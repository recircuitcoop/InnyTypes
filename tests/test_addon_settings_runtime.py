"""The settings an addon is actually handed, and the ones it writes back (plan 0004, slice 05).

**Nothing here spawns a process and nothing here opens a real control channel.** The addon is
a class defined in this file, reached through an injected entry-point loader that answers for
an environment nobody created; its channel is an ``AF_UNIX`` socketpair with both ends in this
process; and the control channel the restart rule speaks is a fake host that records commands
and reports exits the way the real one does. Every file is under ``tmp_path``: no test here
may read or write the real per-user config directory, which is why :func:`run` defaults to no
settings at all and only :func:`main` reaches this user's own.

The addon is started against a channel whose far end is **already closed**, so the runner
starts the addon, finds the host gone and shuts down — the whole start path, with no thread to
join and nothing to wait for. What the addon was handed outlives that: a context is a mapping
and two closures over the stores behind them.

Each refusal is proved by mutation — the same write made a legal way is accepted in the same
test — because the cheapest way to "pass" a requirement to refuse something is to not
implement it.
"""

from __future__ import annotations

import inspect
import socket
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, Any, cast

import pytest

from innytypes import HOST_API_VERSION
from innytypes.addons.install import ENTRY_POINT_GROUP
from innytypes.addons.manifest import SUPPORTED_HOST_API_VERSIONS, parse_manifest, parse_settings
from innytypes.addons.run import (
    RUNTIME_ENTRY_POINT_GROUP,
    Addon,
    AddonContext,
    PluginSettings,
    main,
    no_settings,
    open_settings,
    run,
    user_settings,
)
from innytypes.addons.secrets import SECRETS_ROOT_VARIABLE, SecretStore, secret_is_set_for
from innytypes.addons.settings import (
    SETTINGS_PATH_VARIABLE,
    USER,
    SettingsError,
    SettingsStore,
)
from innytypes.addons.settings_form import SettingsForm
from innytypes.children import ChildExit, ChildKind, Command, CommandName, CommandResult
from innytypes.events.transport import Connection, StreamConnection
from innytypes.helper.breaker import Breaker
from innytypes.helper.config import RestartSettings
from innytypes.helper.restart import RestartPolicy
from innytypes.helper.settings_watch import SettingsWatch

# --- one plugin's declaration -------------------------------------------------------------

FOLDER: dict[str, object] = {
    "id": "root",
    "type": "path",
    "label": "Folder to watch",
    "kind": "folder",
}
INTERVAL: dict[str, object] = {
    "id": "interval",
    "type": "number",
    "label": "Interval",
    "min": 1,
    "max": 60,
    "default": 20,
}
QUALITY: dict[str, object] = {
    "id": "quality",
    "type": "choice",
    "label": "Quality",
    "options": ["low", "high"],
    "default": "high",
}
# What a plugin completes an authorisation into (D11): its own to write, nobody's to read.
TOKEN: dict[str, object] = {
    "id": "token",
    "type": "secret",
    "label": "Access token",
    "written_by": "both",
}
# Written by either, which is the one kind of field a person and a plugin can both set — and
# therefore the only field on which their two attributions can be compared (F2).
SHARED_FOLDER: dict[str, object] = dict(FOLDER, written_by="both")

# The type a plugin with several of something declares (plan 0005), with a nested table inside
# it, because a row that holds rows is what a plugin has to be able to read without parsing.
TAKES: dict[str, object] = {
    "id": "takes",
    "type": "table",
    "label": "Takes",
    "row_label": "take",
    "row": [{"id": "file", "type": "path", "label": "File", "kind": "file"}],
}
VOLUMES: dict[str, object] = {
    "id": "volumes",
    "type": "table",
    "label": "Recorders",
    "row_label": "recorder",
    "written_by": "both",
    "row": [
        {"id": "label", "type": "text", "label": "Name", "required": True},
        {"id": "gain", "type": "number", "label": "Gain", "min": 1},
        TAKES,
    ],
}


def manifest_document(
    addon_id: str = "monty",
    *,
    host_api: int = HOST_API_VERSION,
    settings: Sequence[Mapping[str, object]] = (),
) -> dict[str, object]:
    """One addon's manifest, as its entry point returns it."""
    document: dict[str, object] = {
        "id": addon_id,
        "version": "1.4.0",
        "host_api": host_api,
        "requires": [],
        "emits": [],
        "subscribes": [],
    }
    if settings:
        document["settings"] = [dict(entry) for entry in settings]
    return document


# --- where everything is recorded, and nothing of it is real --------------------------------


@dataclass(frozen=True)
class Files:
    """The two directories a plugin's values live in, both under this test's own directory."""

    root: Path

    def settings_path(self, addon_id: str) -> Path:
        return self.root / "config" / "plugins" / f"{addon_id}.toml"

    @property
    def secrets_root(self) -> Path:
        return self.root / "config" / "secrets"

    def secrets(self) -> SecretStore:
        return SecretStore(root=self.secrets_root)

    def store(
        self,
        addon_id: str = "monty",
        *settings: Mapping[str, object],
    ) -> SettingsStore:
        """The store the host records this plugin's values through."""
        return SettingsStore(
            addon_id,
            parse_settings([dict(entry) for entry in settings]),
            path=self.settings_path(addon_id),
            secret_is_set=secret_is_set_for(addon_id, self.secrets()),
        )

    def opener(self, manifest: Any) -> PluginSettings:
        """The seam the runner takes: this test's files, and never the user's."""
        return open_settings(
            manifest,
            settings_path=self.settings_path(manifest.id),
            secrets_root=self.secrets_root,
        )


@pytest.fixture
def files(tmp_path: Path) -> Files:
    return Files(root=tmp_path)


# --- the addon, and the environment it pretends to be installed in --------------------------


class FakeAddon:
    """The addon: it keeps the context it was started with, which is what is asserted."""

    def __init__(self, context: AddonContext) -> None:
        self.context = context
        self.stopped = False

    def handle(self, event: object) -> None:  # pragma: no cover - nothing is published here
        raise AssertionError("this suite publishes no events")

    def stop(self) -> None:
        self.stopped = True


class FakeEnvironment:
    """The entry points of an addon environment that was never created."""

    def __init__(self, document: Mapping[str, object]) -> None:
        self.document = document
        self.addon: FakeAddon | None = None

    def load(self, group: str, name: str) -> object:
        if group == ENTRY_POINT_GROUP:
            return lambda: self.document
        if group == RUNTIME_ENTRY_POINT_GROUP:
            return self._start
        raise AssertionError(f"the runner asked for an entry point group nobody exports: {group}")

    def _start(self, context: AddonContext) -> Addon:
        self.addon = FakeAddon(context)
        return self.addon


def closed_channel() -> Connection:
    """The addon's end of a channel whose host end has already gone.

    A host that is not there ends the serve loop on its first read, so the runner starts the
    addon, hands it its context and shuts down — with nothing to wait for and nothing to join.
    """
    host_end, addon_end = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    host_end.close()
    stream = cast(IO[bytes], addon_end.makefile("rwb"))
    addon_end.close()
    return StreamConnection(reader=stream, writer=stream)


StartAddon = Callable[..., AddonContext]


@pytest.fixture
def start_addon(files: Files) -> StartAddon:
    """Start one addon through the real runner and answer with the context it was handed."""

    def _start(
        addon_id: str = "monty",
        *,
        host_api: int = HOST_API_VERSION,
        settings: Sequence[Mapping[str, object]] = (),
    ) -> AddonContext:
        environment = FakeEnvironment(
            manifest_document(addon_id, host_api=host_api, settings=settings)
        )
        exit_code = run(
            addon_id,
            connection=closed_channel(),
            load=environment.load,
            settings=files.opener,
        )
        assert exit_code == 0, "the addon did not start"
        assert environment.addon is not None
        assert environment.addon.stopped, "the addon was not stopped when its host went"
        return environment.addon.context

    return _start


# --- what an addon is handed ----------------------------------------------------------------


def test_an_addon_is_handed_every_declared_setting_already_judged(
    files: Files, start_addon: StartAddon
) -> None:
    """Values validated, defaults filled in, and no key an addon has to handle the absence of."""
    watched = files.root / "Recordings"
    watched.mkdir()
    files.store("monty", FOLDER, INTERVAL, QUALITY).write({"root": str(watched)}, by=USER)

    context = start_addon(settings=[FOLDER, INTERVAL, QUALITY])

    assert set(context.settings) == {"root", "interval", "quality"}
    assert context.settings["root"] == str(watched)
    # Never recorded by anybody: the declaration's own defaults, filled in by the host.
    assert context.settings["interval"] == 20
    assert context.settings["quality"] == "high"


def test_an_addon_is_handed_a_table_as_a_tuple_of_mappings_nested_as_declared(
    files: Files, start_addon: StartAddon
) -> None:
    """Plan 0005: a plugin reads a table the way it reads a scalar — by looking at it."""
    files.store("monty", VOLUMES).write(
        {
            "volumes": [
                {"label": "Zoom H6", "gain": 5, "takes": [{"file": "/tmp/one.wav"}]},
                {"label": "Field recorder", "takes": [{"file": "/tmp/two.wav"}]},
            ]
        },
        by=USER,
    )

    context = start_addon(settings=[VOLUMES])
    volumes = context.settings["volumes"]

    # A tuple of mappings, one per recorded row, in the order they were recorded.
    assert isinstance(volumes, tuple)
    assert [row["label"] for row in volumes] == ["Zoom H6", "Field recorder"]
    assert volumes[0]["gain"] == 5
    # A nested table column arrives the same way, inside its own row's mapping — so reaching
    # a take is one subscript and never a parse.
    assert volumes[0]["takes"][0]["file"] == "/tmp/one.wav"
    assert volumes[1]["takes"][0]["file"] == "/tmp/two.wav"
    assert all(isinstance(row, Mapping) for row in volumes)
    assert all(isinstance(take, Mapping) for row in volumes for take in row["takes"])
    # A cell nobody filled in is absent rather than guessed at, exactly as the store holds it.
    assert "gain" not in volumes[1]


def test_a_manifest_declaring_host_api_1_starts_with_an_empty_settings_mapping(
    files: Files, start_addon: StartAddon
) -> None:
    """D3: moving the contract number took nothing away from an addon written against 1.

    The values are on disk and the declaration is in the manifest, so an empty mapping here is
    the version being honoured rather than there being nothing to hand over.
    """
    files.store("monty", FOLDER).write({"root": str(files.root)}, by=USER)

    context = start_addon(host_api=1, settings=[FOLDER, INTERVAL])

    assert dict(context.settings) == {}
    # And the two ways back are answerable, rather than raising at an addon that never asked
    # for them: it declares no setting, so there is no secret of its own to read...
    with pytest.raises(KeyError):
        context.secret("token")
    # ...and nothing it writes is a setting it declares.
    outcome = context.write_settings({"root": str(files.root)})
    assert not outcome.accepted
    assert "not a setting monty declares" in outcome.refused[0].reason


def test_the_host_api_moved_to_two_and_one_is_still_implemented() -> None:
    """The contract number and the range of numbers still served, in one place (D3)."""
    assert HOST_API_VERSION == 2
    assert SUPPORTED_HOST_API_VERSIONS == (1, 2)
    # Both are manifests this host will parse rather than refuse.
    assert parse_manifest(manifest_document(host_api=1)).host_api == 1
    assert parse_manifest(manifest_document(host_api=2)).host_api == 2


def test_only_the_process_entry_point_opens_this_users_own_settings() -> None:
    """Which is why the gate can run the runner at all without reading ``~/.config``.

    Asserted on the defaults rather than by calling :func:`user_settings`, because calling it
    is precisely the thing no test here may do.
    """
    assert inspect.signature(run).parameters["settings"].default is no_settings
    assert inspect.signature(main).parameters["settings"].default is user_settings


# --- and where that entry point is told to look (plan 0012, slice 01) ------------------------


def refuse_to_resolve(*arguments: object, **keywords: object) -> Path:
    """Stands in for a per-user path resolver an addon process must never reach."""
    raise AssertionError("an addon process resolved a per-user location for itself")


def test_an_addon_is_told_where_its_settings_are_rather_than_working_it_out(
    files: Files, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The defect: the process that most needs the answer is the one that cannot find it.

    An addon environment holds `innytypes`, the addon and the addon's own dependencies and
    nothing else, so both resolvers below reach for a library that is not there. The host has
    it, has already validated these values and is what spawned the process — so it says where,
    and the process never asks. Both resolvers are replaced with a refusal, which is what makes
    this an assertion about the *path not taken* rather than about the values that came back.
    """
    files.store("monty", FOLDER).write({"root": str(files.root)}, by=USER)
    monkeypatch.setattr("innytypes.addons.run.default_settings_path", refuse_to_resolve)
    monkeypatch.setattr("innytypes.addons.run.default_secrets_root", refuse_to_resolve)

    opened = user_settings(
        parse_manifest(manifest_document(settings=[FOLDER])),
        environment={
            SETTINGS_PATH_VARIABLE: str(files.settings_path("monty")),
            SECRETS_ROOT_VARIABLE: str(files.secrets_root),
        },
    )

    assert opened.values["root"] == str(files.root)


def test_an_addon_told_nothing_looks_exactly_where_it_looked_before(
    files: Files, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A host of one version and an addon of another still work together.

    An addon installed before the host learned to say where its files are is spawned with
    neither variable set, and it must behave as it did: resolve both locations itself. The two
    resolvers are replaced with this test's own directories rather than called, because calling
    the real ones is the one thing no test here may do.
    """
    files.store("monty", FOLDER).write({"root": str(files.root)}, by=USER)
    monkeypatch.setattr(
        "innytypes.addons.run.default_settings_path",
        lambda addon_id: files.settings_path(addon_id),
    )
    monkeypatch.setattr("innytypes.addons.run.default_secrets_root", lambda: files.secrets_root)

    opened = user_settings(parse_manifest(manifest_document(settings=[FOLDER])), environment={})

    assert opened.values["root"] == str(files.root)


# --- a plugin writing its own values back ----------------------------------------------------


def test_a_plugins_write_is_recorded_and_cannot_reach_another_plugin(
    files: Files, start_addon: StartAddon
) -> None:
    """D11: bound to its own id, with no argument anywhere that names another plugin."""
    whodunnit = files.store("whodunnit", SHARED_FOLDER)
    whodunnit.write({"root": str(files.root / "theirs")}, by=USER)
    before = files.settings_path("whodunnit").read_text(encoding="utf-8")

    context = start_addon("monty", settings=[SHARED_FOLDER])
    mine = str(files.root / "mine")

    assert context.write_settings({"root": mine}).accepted
    assert files.store("monty", SHARED_FOLDER).read().values["root"] == mine

    # There is nowhere to put another plugin's id: the write takes values and nothing else.
    assert list(inspect.signature(context.write_settings).parameters) == ["values"]

    # Its own id is the only one the store will accept a write in, so the one door that does
    # name a writer refuses this plugin at another plugin's file.
    with pytest.raises(SettingsError, match="a plugin writes only its own settings"):
        whodunnit.write({"root": mine}, by="monty")

    assert files.settings_path("whodunnit").read_text(encoding="utf-8") == before
    assert whodunnit.read().values["root"] == str(files.root / "theirs")


def test_a_plugins_write_is_validated_and_refused_by_field_exactly_as_a_persons_is(
    files: Files, start_addon: StartAddon
) -> None:
    """F2: a plugin cannot record a value the user could not have typed."""
    interval = dict(INTERVAL, written_by="both")
    store = files.store("monty", interval)
    store.write({"interval": 30}, by=USER)

    context = start_addon(settings=[interval])
    outcome = context.write_settings({"interval": 900})

    assert outcome.recorded == ()
    assert [problem.field for problem in outcome.refused] == ["interval"]
    # The same value, refused to a person by the form, gives the same sentence — one validator.
    refused_to_a_person = SettingsForm(store).save({"interval": 900})
    assert outcome.refused[0].reason == refused_to_a_person.refused[0].reason

    # And the value that was already there is untouched by either refusal.
    assert store.read().values["interval"] == 30
    # Mutation: the same write inside the declared range is recorded, so the refusal above is
    # the constraint and not the write path being broken.
    assert context.write_settings({"interval": 45}).accepted
    assert store.read().values["interval"] == 45


def test_a_plugin_may_not_write_a_field_declared_written_by_user(
    files: Files, start_addon: StartAddon
) -> None:
    """F2: `written_by: user` is the person's field, and the plugin is refused by name."""
    store = files.store("monty", FOLDER, dict(INTERVAL, written_by="both"))
    theirs = str(files.root / "chosen-by-a-person")
    store.write({"root": theirs}, by=USER)

    context = start_addon(settings=[FOLDER, dict(INTERVAL, written_by="both")])
    outcome = context.write_settings({"root": str(files.root / "chosen-by-monty")})

    assert outcome.recorded == ()
    assert outcome.refused[0].field == "root"
    assert "written_by 'user'" in outcome.refused[0].reason
    # Refused means unchanged, not merely unreported.
    assert store.read().values["root"] == theirs
    assert store.read().attribution["root"].by == USER

    # Mutation: the field declared `both` in the same call is recorded, so the refusal is the
    # `written_by` rule rather than a plugin being unable to write at all.
    assert context.write_settings({"interval": 5}).accepted


def test_a_plugin_may_not_write_a_table_its_author_declared_the_users(
    files: Files, start_addon: StartAddon
) -> None:
    """A table is judged by `written_by` exactly as a scalar is — rows change nothing (F2)."""
    theirs = dict(VOLUMES, written_by="user")
    store = files.store("monty", theirs)
    store.write({"volumes": [{"label": "typed in by a person"}]}, by=USER)

    context = start_addon(settings=[theirs])
    outcome = context.write_settings({"volumes": [{"label": "found by monty"}]})

    assert outcome.recorded == ()
    assert outcome.refused[0].field == "volumes"
    assert "written_by 'user'" in outcome.refused[0].reason
    # Refused means unchanged, not merely unreported: the row and its writer are as they were.
    recorded = store.read()
    assert [row["label"] for row in recorded.values["volumes"]] == ["typed in by a person"]
    assert recorded.attribution["volumes"].by == USER

    # Mutation: the same rows, written to the same table declared `both`, are recorded — so
    # the refusal above is the `written_by` rule and not a plugin being unable to write rows.
    shared = start_addon(settings=[VOLUMES])
    assert shared.write_settings({"volumes": [{"label": "found by monty"}]}).accepted


def test_a_plugins_table_write_is_attributed_to_the_plugin_rather_than_to_the_user(
    files: Files, start_addon: StartAddon
) -> None:
    """D4: attribution is per field, so a table of ten rows has one writer and one time."""
    store = files.store("monty", VOLUMES)
    store.write({"volumes": [{"label": "typed in"}]}, by=USER)
    assert store.read().attribution["volumes"].by_user

    context = start_addon(settings=[VOLUMES])
    assert context.write_settings({"volumes": [{"label": "one"}, {"label": "two"}]}).accepted

    written = store.read().attribution["volumes"]
    assert written.by == "monty"
    assert not written.by_user


def test_a_plugins_table_write_records_the_rows_that_pass_and_keeps_the_one_that_fails(
    files: Files, start_addon: StartAddon
) -> None:
    """D2 for a plugin's write: one bad row costs that row and nothing else."""
    store = files.store("monty", VOLUMES)
    store.write(
        {
            "volumes": [
                {"label": "one", "gain": 5},
                {"label": "two", "gain": 5},
                {"label": "three", "gain": 5},
            ]
        },
        by=USER,
    )

    context = start_addon(settings=[VOLUMES])
    outcome = context.write_settings(
        {
            "volumes": [
                {"label": "one-edited", "gain": 7},
                {"label": "two-edited", "gain": 0},
                {"label": "three-edited", "gain": 9},
            ]
        }
    )

    assert [problem.field for problem in outcome.refused] == ["volumes"]
    assert outcome.refused[0].reason == "volumes: recorder 2's gain is 0, below the declared min 1"
    # The refusal names the row and the cell, in the one address the form places it at.
    assert outcome.refused[0].cell is not None
    assert outcome.refused[0].cell.column == "gain"

    recorded = store.read().values["volumes"]
    assert [row["label"] for row in recorded] == ["one-edited", "two", "three-edited"]
    assert [row["gain"] for row in recorded] == [7, 5, 9]


def test_a_plugin_writes_a_secret_that_is_never_readable_back_but_reaches_the_plugin(
    files: Files, start_addon: StartAddon
) -> None:
    """The authorisation case (D11): recorded, unreadable, and still usable by its owner."""
    token = "ya29-a-token-an-oauth-exchange-returned"
    store = files.store("monty", FOLDER, TOKEN)
    # So that there is a settings file to look in below: a secret write creates none.
    store.write({"root": str(files.root)}, by=USER)
    context = start_addon(settings=[FOLDER, TOKEN])

    assert context.write_settings({"token": token}).recorded == ("token",)

    # Not in the mapping the plugin was handed, and not in a mapping opened after the write.
    assert "token" not in context.settings
    assert "token" not in files.opener(parse_manifest(manifest_document(settings=[TOKEN]))).values

    # Not in the form either — all it ever says is that something is set.
    published = SettingsForm(store).publish().field("token")
    assert published.value is None
    assert published.secret_is_set

    # Not in the settings file at all: a secret lives in a file of its own (D6).
    assert token not in files.settings_path("monty").read_text(encoding="utf-8")

    # And the one way back to it is the plugin that owns it.
    assert context.secret("token") == token


def test_a_plugin_may_not_write_a_secret_its_author_declared_the_users(
    files: Files, start_addon: StartAddon
) -> None:
    """`written_by` governs a secret exactly as it governs a folder (F2).

    The rule is the settings store's and the file is the secret store's, so this is the one
    write where the two have to agree — and the refusal proves they are asked in that order.
    """
    theirs: dict[str, object] = dict(TOKEN, id="api-key", written_by="user")
    context = start_addon(settings=[theirs])

    outcome = context.write_settings({"api-key": "a key the user pasted in"})

    assert outcome.recorded == ()
    assert outcome.refused[0].field == "api-key"
    assert "written_by 'user'" in outcome.refused[0].reason
    # Refused before the secret store was reached: nothing was stored under that name.
    assert not files.secrets().is_set("monty", "api-key")
    assert context.secret("api-key") is None


def test_a_plugin_reads_its_own_secret_and_has_no_way_to_ask_for_another_plugins(
    files: Files, start_addon: StartAddon
) -> None:
    """The accessor is bound to the addon, like its emitter: a field id in, its own value out."""
    monty = start_addon("monty", settings=[FOLDER, TOKEN])
    whodunnit = start_addon("whodunnit", settings=[TOKEN])

    assert monty.write_settings({"token": "monty's own token"}).accepted
    assert whodunnit.write_settings({"token": "whodunnit's own token"}).accepted

    # Two plugins, one field id, two values — and each context answers with its own.
    assert monty.secret("token") == "monty's own token"
    assert whodunnit.secret("token") == "whodunnit's own token"
    assert list(inspect.signature(monty.secret).parameters) == ["field_id"]

    # A field that is not a secret this addon declares is a mistake, not "not set": answering
    # None would tell a plugin its credential is missing when it never had one here.
    with pytest.raises(KeyError, match="no secret setting"):
        monty.secret("root")


def test_a_plugins_write_is_attributed_to_the_plugin_and_a_persons_to_the_user(
    files: Files, start_addon: StartAddon
) -> None:
    """F2: the window can say "set by monty" beside a value nobody typed."""
    store = files.store("monty", SHARED_FOLDER)
    context = start_addon(settings=[SHARED_FOLDER])

    store.write({"root": str(files.root / "typed-in")}, by=USER)
    by_the_user = store.read().attribution["root"]

    assert context.write_settings({"root": str(files.root / "found-by-monty")}).accepted
    by_the_plugin = store.read().attribution["root"]

    assert by_the_user.by == USER
    assert by_the_user.by_user
    assert by_the_plugin.by == "monty"
    assert not by_the_plugin.by_user
    assert by_the_plugin.by != by_the_user.by


# --- a value that changed under a running plugin (D10) ---------------------------------------


@dataclass
class FakeHost:
    """A host that carries out commands and NEVER restarts a child by itself.

    The stop inside a restart is the host's own, so the exit it reports is **expected** —
    which is the whole of why a settings change costs a plugin nothing.
    """

    commands: list[Command] = field(default_factory=list)
    exits: list[ChildExit] = field(default_factory=list)

    def send(self, command: Command) -> CommandResult:
        self.commands.append(command)
        if command.name in (CommandName.RESTART, CommandName.STOP, CommandName.KILL):
            assert command.child_id is not None
            self.exits.append(_exit_of(command.child_id, expected=True))
        return CommandResult(name=command.name)

    @property
    def restarted(self) -> list[str | None]:
        return [
            command.child_id for command in self.commands if command.name is CommandName.RESTART
        ]


def _exit_of(child_id: str, *, expected: bool, code: int | None = 0) -> ChildExit:
    return ChildExit(id=child_id, kind=ChildKind.ADDON, pid=4242, exit_code=code, expected=expected)


@dataclass
class FakeHelper:
    """The helper's own wiring, in the one respect this rule depends on.

    Every exit the host reports goes to the restart policy, and an intervention is recorded
    only when the policy decided something had to be done about it — which is precisely what
    an expected stop does not.
    """

    policy: RestartPolicy
    breaker: Breaker
    host: FakeHost

    def drain(self) -> None:
        for exit_report in self.host.exits:
            if self.policy.child_exited(exit_report) is not None:
                self.breaker.record(exit_report.id, reason="restarted after an exit")
        self.host.exits.clear()


@pytest.fixture
def helper() -> FakeHelper:
    host = FakeHost()
    return FakeHelper(
        policy=RestartPolicy(channel=host, settings=RestartSettings(), now=lambda: 1000.0),
        # In memory: nothing here quarantines anything, and a quarantine file is a real path
        # this suite has no business writing.
        breaker=Breaker(now=lambda: 1000.0),
        host=host,
    )


def test_a_changed_value_restarts_its_plugin_and_costs_it_nothing(
    files: Files, helper: FakeHelper
) -> None:
    """D10: an expected stop-and-start, so nothing counts it and the breaker never hears."""
    monty = files.store("monty", FOLDER)
    whodunnit = files.store("whodunnit", FOLDER)
    monty.write({"root": str(files.root / "before")}, by=USER)
    whodunnit.write({"root": str(files.root / "theirs")}, by=USER)

    watch = SettingsWatch(helper.policy)
    watch.watch(monty)
    watch.watch(whodunnit)

    # Nothing has changed yet, so nothing is restarted — the tick is not a restart in itself.
    assert watch.tick() == ()

    monty.write({"root": str(files.root / "after")}, by=USER)

    assert watch.tick() == ("monty",)
    # One command in the whole exchange, and it names the plugin whose value changed: the
    # other running plugin is not stopped, started or spoken about by a neighbour's change.
    assert [(command.name, command.child_id) for command in helper.host.commands] == [
        (CommandName.RESTART, "monty")
    ]

    helper.drain()

    assert helper.policy.state("monty").attempts == 0
    assert helper.policy.pending == ()
    assert helper.breaker.interventions_for("monty") == ()
    assert not helper.breaker.is_quarantined("monty")

    # Mutation: the same plugin dying on its own DOES cost it an attempt and an intervention,
    # so the three assertions above are the expected stop and not a helper that counts nothing.
    helper.host.exits.append(_exit_of("monty", expected=False, code=1))
    helper.drain()
    assert helper.policy.state("monty").attempts == 1
    assert len(helper.breaker.interventions_for("monty")) == 1


def test_a_plugin_is_not_restarted_for_its_own_write(
    files: Files, helper: FakeHelper, start_addon: StartAddon
) -> None:
    """A token a plugin just exchanged is already in its hands; restarting it would lose it."""
    store = files.store("monty", SHARED_FOLDER)
    context = start_addon(settings=[SHARED_FOLDER])
    watch = SettingsWatch(helper.policy)
    watch.watch(store)

    assert context.write_settings({"root": str(files.root / "found-by-monty")}).accepted

    assert watch.tick() == ()
    assert helper.host.commands == []
    # The change is taken up all the same, so the next user edit is judged against it.
    assert watch.values_for("monty")["root"] == str(files.root / "found-by-monty")

    # Mutation: the same field, changed by a person, restarts the plugin.
    store.write({"root": str(files.root / "typed-in")}, by=USER)
    assert watch.tick() == ("monty",)


def test_rewriting_the_same_value_restarts_nothing(files: Files, helper: FakeHelper) -> None:
    """A restart is an interruption, and needs a reason a person can point at."""
    store = files.store("monty", FOLDER, INTERVAL)
    store.write({"root": str(files.root / "watched")}, by=USER)

    watch = SettingsWatch(helper.policy)
    watch.watch(store)

    # The same value again: the file is rewritten and its bookkeeping moves, the values do not.
    store.write({"root": str(files.root / "watched")}, by=USER)

    assert watch.tick() == ()
    assert helper.host.commands == []

    # Mutation: a different value in the same field does restart it.
    store.write({"root": str(files.root / "somewhere-else")}, by=USER)
    assert watch.tick() == ("monty",)


def test_a_value_that_stopped_fitting_its_declaration_restarts_its_plugin(
    files: Files, helper: FakeHelper
) -> None:
    """The plugin must not keep running on a value the host will no longer hand it (D5).

    Whether it comes back up is the availability rule's business — a plugin whose values do
    not fit is held disabled with the reason. What this rule owes is that it stops.
    """
    switch: dict[str, object] = {"id": "enabled", "type": "switch", "label": "On"}
    store = files.store("monty", switch)
    store.write({"enabled": True}, by=USER)

    watch = SettingsWatch(helper.policy)
    watch.watch(store)
    assert watch.values_for("monty")["enabled"] is True

    # `1` is not a switch, however much `True == 1` is true in Python: the store refuses it,
    # so the field leaves the mapping the plugin would be handed.
    files.settings_path("monty").write_text("[values]\nenabled = 1\n", encoding="utf-8")

    assert watch.tick() == ("monty",)
    assert helper.host.restarted == ["monty"]
    assert "enabled" not in watch.values_for("monty")


def test_a_settings_file_that_cannot_be_read_restarts_nothing_and_is_read_again(
    files: Files, helper: FakeHelper
) -> None:
    """A file caught mid-edit is not a reconfiguration, and not a reason to stop watching."""
    store = files.store("monty", FOLDER)
    store.write({"root": str(files.root / "watched")}, by=USER)

    watch = SettingsWatch(helper.policy)
    watch.watch(store)

    files.settings_path("monty").write_text("[values]\nroot = \n", encoding="utf-8")

    assert watch.tick() == ()
    assert helper.host.commands == []
    assert watch.watching == ("monty",)

    # And the next readable tick acts on what the file finally says. Written by hand, because
    # the store itself cannot merge a value into a file it cannot parse.
    corrected = files.root / "corrected"
    files.settings_path("monty").write_text(f'[values]\nroot = "{corrected}"\n', encoding="utf-8")
    assert watch.tick() == ("monty",)


def test_a_plugin_that_stopped_is_no_longer_watched(files: Files, helper: FakeHelper) -> None:
    """There is nothing to restart, and a value changed meanwhile is read by the next start."""
    store = files.store("monty", FOLDER)
    store.write({"root": str(files.root / "watched")}, by=USER)

    watch = SettingsWatch(helper.policy)
    watch.watch(store)
    watch.forget("monty")

    store.write({"root": str(files.root / "somewhere-else")}, by=USER)

    assert watch.tick() == ()
    assert watch.watching == ()
    assert helper.host.commands == []
