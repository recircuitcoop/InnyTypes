"""Console entry point for the host — the commands a person actually types.

Three of them are the host itself:

`innytypes addons install` is the **only** way an addon arrives (plan 0001, invariant 6).
It builds the addon its own environment, pins `innytypes` inside it at the version this
host is running, and records the manifest the addon exports so discovery can find it. It
takes an addon at an exact version — `monty==1.4.0`, resolved from an index — or a **path on
this machine**, a source directory or a wheel, for an addon that is on no index at all.

`innytypes addons list` is the read side of the same thing: what is installed, and what is
installed-but-broken, printed together so nothing is quietly missing from the list.

`innytypes addons outdated` asks each addon's declared source what it publishes and prints
three facts per addon: the installed version, the newest **compatible** version, and — when
the newest published version is not the one that may be taken — the numbered consistency rule
that stands in the way (plan 0003, *Consistency*). It decides and prints; it installs
nothing.

`innytypes addons update <id>` / `--all` is the half that does install: the manual mode's
way of applying the very set `outdated` describes, through the same five steps an `auto`
update follows (:mod:`innytypes.helper.rollout`). Naming an addon is what `manual` mode has
been waiting for; a pinned addon is held back from `--all` and refused by name, because a pin
outranks every mode.

`innytypes up` brings the host and its children up and **installs nothing on the way**. It
discovers, it starts, it waits, it stops — no environment is created, downloaded or written
to by any part of it. A startup that mutates the environment is a startup nobody can debug.
The host it starts is :func:`innytypes.host.build_host`'s, and there is no other: what `up`
prints is :class:`~innytypes.host.HostReport`, so a missing key or an Anytype that is not
running is a line in the output and an exit code of zero (plan 0001, *A missing requirement
degrades, it does not crash*), never a command that refuses with nothing started.

`innytypes quit` is the command-line row of plan 0003's *Turning InnyTypes off* table, and
`innytypes quit --force` is the row below it. Both record the quit before they stop anything,
and both stop processes only by their verified identity; the sequence itself lives in
:mod:`innytypes.helper.launcher`, because the helper's own Quit menu item runs the same one.

`anytype-mcp get-key` lands for the same reason install is explicit: a first run has to
obtain a credential before anything else works, and a user doing that by hand is a user
pasting a key into a shell history. `anytype-mcp refresh-tool-surface` is the opposite case
— the one command here that needs Node and a running Anytype, so it is typed by a person
and never run by the host or the gate.

**Everything outside this module is injected through :class:`CliContext`**: the installer,
the addons root, how the host is built and how this command waits on it. Production builds
it from the defaults; a test hands `CliRunner.invoke` its own, which is how the whole surface
is exercised with no `uv`, no process and no network.

`telemetry` and `addons pin|unpin` land next (plan 0003 slice 01). They are the user's way
to change one switch in the helper's `config.toml`; the helper re-reads that file before it
acts, so neither command needs anything to be restarted.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from collections.abc import Set as AbstractSet
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
from pathlib import Path

import click

from innytypes import __version__
from innytypes.addons.discovery import InstalledAddon, default_addons_root, discover_addons
from innytypes.addons.install import (
    AddonInstaller,
    InstallError,
    UvInstaller,
    install_addon,
    install_addon_from_path,
)
from innytypes.addons.manifest import ManifestError, parse_requirement
from innytypes.addons.settings import PluginAvailability

# Aliased: `innytypes.helper.versions` already calls its own enum `PluginState`, and that one
# is about a plugin's *update*. This one is about whether the plugin runs at all.
from innytypes.addons.settings_form import PluginState as AvailabilityState
from innytypes.anytype_mcp.config import DEFAULT_KEY_FILE, ConfigError, load_config
from innytypes.anytype_mcp.keys import acquire_api_key
from innytypes.anytype_mcp.refresh import RefreshError, refresh_tool_surface
from innytypes.anytype_mcp.tools import FIXTURE_PATH
from innytypes.children import ChildError, ChildExit, ChildSupervisor, RunStateError, RunStateFile
from innytypes.helper.breaker import QuarantineFile, RunState
from innytypes.helper.config import (
    HelperConfig,
    HelperConfigError,
    HelperSettings,
    Telemetry,
    default_config_path,
)
from innytypes.helper.enablement import plugin_states
from innytypes.helper.launcher import QuitReport, Quitter, build_quitter
from innytypes.helper.notification import NoticeFile, NoticeKind, compose
from innytypes.helper.rollout import AppliedUpdate, UpdateApplier, UpdateApplyError
from innytypes.helper.telemetry import (
    PRIVACY_NOTICE,
    ReportQueue,
    TelemetryPipeline,
    default_queue_path,
    os_machine_identifier,
)
from innytypes.helper.versions import (
    PluginReport,
    PluginState,
    UvLockResolver,
    VersionChecker,
)
from innytypes.host import Host, build_host

# How `up` obtains the host, and how it waits on it once it is up. Both are callables so a
# test can hand the CLI a host that spawns nothing and a wait that returns.
BuildHost = Callable[[Path | None], Host]
Supervise = Callable[[ChildSupervisor], None]

# How `outdated` gets the thing that talks to the outside world. A callable rather than a
# checker, because the checker reads the config file the `--config` option chooses.
MakeChecker = Callable[[HelperSettings], VersionChecker]

# How `update` gets the thing that stops, swaps and starts. ``None`` means there is no way to
# reach the running application from here — see :func:`build_update_applier`.
MakeApplier = Callable[[HelperSettings, Path | None], UpdateApplier | None]
# How `quit` gets the thing that turns the application off. A callable taking the run-state
# file, because that file is what a quit acts on and `--run-state` is what redirects it.
MakeQuitter = Callable[[Path | None], Quitter]


def build_version_checker(settings: HelperSettings) -> VersionChecker:
    """The real checker: the live config, real HTTP, real `git`, real `uv` for the lock."""
    return VersionChecker(settings=settings, resolve_lock=UvLockResolver())


def build_update_applier(
    settings: HelperSettings, addons_root: Path | None
) -> UpdateApplier | None:
    """The applier `addons update` would use — and ``None`` until there is one to build.

    Applying an update stops and starts running plugins, and only the host owns its children
    (plan 0001, invariant 9). Reaching the host means the control channel, and both halves of
    that channel are still injected callables rather than anything two processes can speak
    over (plan 0001 slice 07, plan 0003 slice 07). So this answers ``None``, the command says
    what is missing in one line, and nothing here pretends to have stopped a plugin it never
    reached.
    """
    return None


def report_exit(exit_report: ChildExit) -> None:
    """Where a child's exit goes while `up` is the thing running it.

    The helper's control channel is the real destination (plan 0003 slice 05); until a host
    started by the helper has one, a person watching `up` in a terminal is the one who has to
    be told a child is gone.
    """
    expected = "stopped" if exit_report.expected else "exited"
    click.echo(
        f"  {exit_report.id} {expected} (process {exit_report.pid}) "
        f"with code {exit_report.exit_code}"
    )


def build_terminal_host(addons_root: Path | None) -> Host:
    """The host `up` runs: :func:`innytypes.host.build_host`, reporting exits to the terminal.

    The one thing this adds to the host everything else uses is where a child's exit goes —
    to the person watching `up`, rather than to the log a helper-started host writes. It
    assembles nothing itself: a second assembly here would be a second answer to what the
    host's children are, and the two would disagree about a missing key on the day it mattered.
    """
    return build_host(addons_root=addons_root, report_exit=report_exit)


def supervise_children(
    supervisor: ChildSupervisor,
    *,
    interval: float = 1.0,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    """Keep the host up: notice every child that exits, until the user interrupts.

    Noticing is the whole of it. Restarting a child that died is the helper's decision and
    lives in exactly one place (plan 0001, invariant 9), so this loop reports and waits.
    """
    try:
        while True:
            supervisor.poll()
            sleep(interval)
    except KeyboardInterrupt:
        # Ctrl-C is how a person stops a foreground `up`; it is not an error to report.
        click.echo("Stopping.")


@dataclass(frozen=True)
class CliContext:
    """Everything the commands reach for outside themselves, in one injectable object."""

    # Built per invocation rather than shared: it holds no state, and a test replaces it.
    installer: AddonInstaller = field(default_factory=UvInstaller)
    # ``None`` means the real per-user addons root; every test passes its own.
    addons_root: Path | None = None
    host: BuildHost = build_terminal_host
    supervise: Supervise = supervise_children
    make_checker: MakeChecker = build_version_checker
    make_applier: MakeApplier = build_update_applier
    make_quitter: MakeQuitter = build_quitter


# Where the addons group leaves `--config` for pin and unpin (see the group's docstring).
CONFIG_FILE_KEY = "innytypes.config_file"

# Where the telemetry group leaves `--queue` for `show`, for the same reason.
QUEUE_DIR_KEY = "innytypes.queue_dir"


def build_telemetry_pipeline(settings: HelperSettings, queue_dir: Path | None) -> TelemetryPipeline:
    """The pipeline `telemetry show` reads the queue through.

    The identifier source is handed over because the constructor requires one, not because
    this command needs it: the machine id is computed on the first report the switch allows,
    so printing the queue never reads the machine's identifier.
    """
    root = default_queue_path() if queue_dir is None else queue_dir
    return TelemetryPipeline(
        settings=settings,
        queue=ReportQueue(root),
        machine_identifier=os_machine_identifier,
    )


def _config_option(command: click.decorators.FC) -> click.decorators.FC:
    """The `--config` option both helper-facing groups take, spelled once."""
    return click.option(
        "--config",
        "config_file",
        type=click.Path(dir_okay=False, path_type=Path),
        default=None,
        help=f"The helper's config file. Default: {default_config_path()}",
    )(command)


@contextmanager
def _refusing_loudly() -> Iterator[None]:
    """Print a config refusal and exit 1, rather than showing the user a traceback.

    One handler for every command in this file that touches `config.toml`: the loader names
    the file, the section and the key, so the whole job here is to let that message be the
    thing the user sees.
    """
    try:
        yield
    except HelperConfigError as error:
        raise click.ClickException(str(error)) from error


def _describe_telemetry(state: Telemetry) -> str:
    """One line saying where the switch stands, in the words the three states deserve."""
    if state is Telemetry.UNSET:
        return (
            "Telemetry: the first-launch question has not been answered yet. "
            "Nothing is sent, and nothing is queued."
        )
    if state is Telemetry.ON:
        return "Telemetry: on. Usage and error reports are sent."
    return "Telemetry: off. Nothing leaves this machine."


@click.group()
@click.version_option(__version__, prog_name="innytypes")
def cli() -> None:
    """innytypes — host application wrapping the Anytype desktop app."""


@cli.group("addons")
@_config_option
@click.option(
    "--addons-root",
    "addons_root",
    type=click.Path(file_okay=False, path_type=Path),
    default=None,
    help=f"Where addon environments live. Default: {default_addons_root()}",
)
@click.pass_context
def addons(context: click.Context, config_file: Path | None, addons_root: Path | None) -> None:
    """The addons installed on this machine.

    `--config` belongs to `pin`, `unpin` and `outdated`, which write or read a helper
    setting. It is stashed in the context's meta rather than its object, because `install`
    and `list` already receive a :class:`CliContext` there and one slot cannot hold both.

    `--addons-root` is the one thing every command in this group shares, so it is applied to
    the :class:`CliContext` itself and each command keeps reading the field it always read.
    It exists for the same reason the field is injectable: an addon set that is not this
    machine's own — a second install to try something out, or the root a test writes to.
    """
    context.meta[CONFIG_FILE_KEY] = config_file

    if addons_root is not None:
        # Left alone when the option is absent, so a context a caller injected keeps the root
        # it was built with rather than being overwritten with `None`.
        context.obj = replace(context.ensure_object(CliContext), addons_root=addons_root)


@addons.command("install")
@click.argument("source")
@click.option(
    "--force",
    is_flag=True,
    default=False,
    help="Replace an installation that came from another source instead of refusing.",
)
@click.option(
    "--editable",
    "-e",
    is_flag=True,
    default=False,
    help="Point the environment at the source tree, for working on the addon itself.",
)
@click.pass_context
def addons_install(context: click.Context, source: str, force: bool, editable: bool) -> None:
    """Install one addon into its own environment: `innytypes addons install monty==1.4.0`.

    ``SOURCE`` is either an addon at an exact version, resolved from a package index, or a
    path on this machine — a source directory or a wheel — for an addon that is published
    nowhere. A path carries no id and no version, so both are taken from the manifest the
    addon itself exports once its environment has been built.

    `--editable` is for working on the addon: the environment points at the checkout instead
    of at a copy of it, so editing the source and restarting the addon is the whole loop. The
    addon's dependencies stay locked with hashes; its own code is what stops being locked, and
    `addons list` says so for as long as the installation lasts.

    Explicit on purpose (plan 0001, invariant 6): no command installs an addon as a side
    effect of doing something else, and `up` installs nothing at all.
    """
    cli_context = context.ensure_object(CliContext)

    try:
        addon = _install(source, cli_context, force=force, editable=editable)
    except InstallError as error:
        raise click.ClickException(str(error)) from error

    click.echo(f"Installed {addon.id} {addon.manifest.version} in {addon.environment}.")
    click.echo(f"Recorded its manifest at {addon.manifest_path}.")
    if addon.source is not None and addon.source.editable:
        # Said at install time as well as in `addons list`, because this is the moment the
        # guarantee changes and the person who changed it is standing right here.
        click.echo(
            f"It runs the code in {addon.source.path}, which is not locked: edit that "
            "checkout and restart the addon to see your changes."
        )


def _install(
    source: str, cli_context: CliContext, *, force: bool, editable: bool
) -> InstalledAddon:
    """Install from whichever of the two sources ``source`` names, or refuse naming both.

    The grammar decides, not the filesystem: `<addon-id>==<version>` is an addon at an exact
    version and can be nothing else, so a path is never tried for it and a typo in a version
    is never reported as a missing file. Everything else is a path, and a path that is not
    there is refused before any environment is built.
    """
    try:
        requirement = parse_requirement(source)
    except ManifestError:
        # A path, then — including every spelling that is neither, which is refused below
        # naming both. `--editable` only ever applies here: there is no checkout to point at
        # when the addon came from an index.
        path = Path(source)
        if not path.expanduser().exists():
            raise click.ClickException(
                f"{source!r} is neither an addon at an exact version — write "
                "'<addon-id>==<version>', for example 'monty==1.4.0' — nor a path on this "
                "machine: no such directory or wheel."
            ) from None

        return install_addon_from_path(
            path,
            installer=cli_context.installer,
            root=cli_context.addons_root,
            force=force,
            editable=editable,
        )

    if editable:
        raise click.ClickException(
            f"{source!r} names an addon at an exact version, and --editable installs a "
            "checkout: give the path to the addon's source tree instead."
        )

    return install_addon(
        requirement,
        installer=cli_context.installer,
        root=cli_context.addons_root,
        force=force,
    )


@addons.command("list")
@click.pass_context
def addons_list(context: click.Context) -> None:
    """Print every installed addon, the broken ones included.

    A broken addon is printed with the reason it is broken rather than left out: a list that
    silently omits what it could not read is a list nobody can act on.
    """
    cli_context = context.ensure_object(CliContext)
    found = discover_addons(cli_context.addons_root)

    if not found.installed and not found.broken:
        click.echo("No addons installed.")
        return

    for addon in found.installed:
        # The source is printed only when there is one, so an addon from an index reads
        # exactly as it always has — and an author can see at a glance which checkout the
        # installed one is, and whether it is the editable one.
        origin = "" if addon.source is None else f"  ({addon.source})"
        click.echo(f"{addon.id}  {addon.manifest.version}  installed{origin}")
    for broken in found.broken:
        # No version to print: the record that would have carried one is the broken thing.
        click.echo(f"{broken.id}  -  broken: {broken.reason}")


def _describe_report(report: PluginReport) -> list[str]:
    """One addon's lines in `outdated`: the version facts, then the rule that holds it back.

    The newest published version is printed whenever it is not the one being taken, so an
    addon held at 1.4.0 because 2.0.0 needs a newer host reads as exactly that rather than as
    "up to date". The rule is printed with its number, because that is how the plan names the
    five of them and how the next person looks the refusal up.
    """
    head = f"{report.id}  {report.installed_version}"

    if report.state is PluginState.AVAILABLE:
        head += f" -> {report.target_version}"
    elif report.state is PluginState.BLOCKED:
        head += "  held at this version"
    elif report.state is PluginState.UP_TO_DATE:
        head += "  up to date"
    else:
        head += f"  {report.state.value}"

    if report.newest_version is not None and report.newest_version != report.target_version:
        head += f"  (newest published: {report.newest_version})"

    lines = [head]
    if report.rule is not None:
        lines.append(f"    blocked by {report.rule}: {report.reason}")
    elif report.reason is not None:
        lines.append(f"    {report.reason}")
    return lines


@addons.command("outdated")
@click.pass_context
def addons_outdated(context: click.Context) -> None:
    """Print what each addon runs, what it could run, and what stops it.

    Checks and reports; it installs nothing (plan 0001, invariant 6). An addon whose manifest
    declares no `update` section is listed as not updatable rather than guessed at, and an
    addon a consistency rule holds back is listed with the rule that holds it.
    """
    cli_context = context.ensure_object(CliContext)
    found = discover_addons(cli_context.addons_root)

    if not found.installed and not found.broken:
        click.echo("No addons installed.")
        return

    settings = HelperSettings(path=context.meta.get(CONFIG_FILE_KEY))
    with _refusing_loudly():
        check = cli_context.make_checker(settings).check(found.installed)

    if not check.checked:
        # Said before the lines rather than inferred from them: "no newer version" and "no
        # source was asked" look identical in a list and mean opposite things.
        click.echo("auto_check_versions is off: no source was asked, for any addon.")

    for report in check.reports:
        for line in _describe_report(report):
            click.echo(line)

    # Last, and by id only: a broken addon has no manifest, so it has no version to compare.
    for broken in found.broken:
        click.echo(f"{broken.id}  -  broken: {broken.reason}")


@addons.command("update")
@click.argument("addon_id", required=False)
@click.option(
    "--all",
    "every_addon",
    is_flag=True,
    default=False,
    help="Update every addon that is not pinned, as one set.",
)
@click.pass_context
def addons_update(context: click.Context, addon_id: str | None, every_addon: bool) -> None:
    """Apply an addon update now: `innytypes addons update monty`, or `--all`.

    The manual half of plan 0003's update modes (D18). It follows exactly the steps an `auto`
    update follows — build in staging, stop only the affected addons and what requires them,
    swap, start again, confirm or roll the whole group back — and the only difference is who
    asked. Naming an addon is what `manual` mode waits for, so a `manual` addon named here
    updates; a **pinned** addon does not, whatever its mode says, until it is unpinned.
    """
    cli_context = context.ensure_object(CliContext)

    if bool(addon_id) == every_addon:
        raise click.ClickException(
            "name one addon or pass --all: `innytypes addons update monty`, or "
            "`innytypes addons update --all`"
        )

    found = discover_addons(cli_context.addons_root)
    if not found.installed:
        click.echo("No addons installed.")
        return

    settings = HelperSettings(path=context.meta.get(CONFIG_FILE_KEY))
    with _refusing_loudly():
        config = settings.current
        requested = _requested_for_update(
            found.installed, addon_id=addon_id, config=config, every_addon=every_addon
        )
        check = cli_context.make_checker(settings).check(found.installed, requested=requested)

    if not check.checked:
        click.echo("auto_check_versions is off: no source was asked, for any addon.")
        return

    if not check.target.changed:
        # Nothing may move. The reports say why — a rule, a pin, a source that failed — and
        # that is the whole answer, so it is printed instead of an apply that would do nothing.
        for report in check.reports:
            if report.id in requested:
                for line in _describe_report(report):
                    click.echo(line)
        click.echo("Nothing to update.")
        return

    applier = cli_context.make_applier(settings, cli_context.addons_root)
    if applier is None:
        raise click.ClickException(
            "applying an addon update needs the running application: it stops and starts "
            "addons through the host, and this command has no way to reach it yet."
        )

    try:
        applied = applier.apply(
            check.target,
            installed={addon.id: addon.manifest for addon in found.installed},
            config=config,
            requested=requested,
        )
    except UpdateApplyError as error:
        raise click.ClickException(str(error)) from error

    for line in _describe_applied(applied):
        click.echo(line)

    if not applied.applied:
        context.exit(1)


def _requested_for_update(
    installed: Sequence[InstalledAddon],
    *,
    addon_id: str | None,
    config: HelperConfig,
    every_addon: bool,
) -> frozenset[str]:
    """Which addons the user is asking for, refusing the two ways of asking for nothing.

    A pin is refused rather than quietly obeyed when an addon is named: the user asked for
    that addon by name, and doing nothing without saying why is how a person ends up thinking
    the command is broken. With `--all` a pin is simply not part of the request, which is what
    a pin is for.
    """
    by_id = {addon.id: addon for addon in installed}

    if addon_id is not None:
        if addon_id not in by_id:
            raise click.ClickException(
                f"{addon_id} is not installed; `innytypes addons list` shows what is."
            )
        if config.plugins.is_pinned(addon_id):
            raise click.ClickException(
                f"{addon_id} is pinned at {by_id[addon_id].manifest.version}; run "
                f"`innytypes addons unpin {addon_id}` first."
            )
        return frozenset({addon_id})

    return frozenset(addon.id for addon in installed if not config.plugins.is_pinned(addon.id))


def _describe_applied(applied: AppliedUpdate) -> list[str]:
    """What one apply did, in the order a person needs it: the outcome, then the detail."""
    lines: list[str] = []

    if applied.applied:
        for addon_id in applied.changed:
            lines.append(f"{addon_id}  -> {applied.versions[addon_id]}")
        lines.append(f"Restarted: {', '.join(applied.group)}." if applied.group else "Restarted: -")
        return lines

    if applied.reason is not None:
        lines.append(applied.reason)
    if applied.rolled_back:
        lines.append(f"Rolled back: {', '.join(applied.rolled_back)}.")
    if applied.blocked:
        lines.append(f"Blocked: {', '.join(str(entry) for entry in applied.blocked)}.")
    if applied.still_down:
        lines.append(f"Still not running: {', '.join(applied.still_down)}.")
    return lines


@cli.command("up")
@click.pass_context
def up(context: click.Context) -> None:
    """Start the host and its children, and keep them up until you stop it.

    Installs nothing, downloads nothing and writes to no addon environment (plan 0001,
    invariant 6). An addon that is broken or held back is named and skipped; everything else
    starts.

    **What is missing is printed, not raised.** No Anytype API key, or an Anytype that is not
    running, leaves the host without its MCP child and with every addon that does not need
    Anytype up — so the reason is a line here and the exit code is zero (plan 0001, *A missing
    requirement degrades, it does not crash*). The one thing that still refuses is a child
    that cannot be spawned at all: that is a broken installation on this machine rather than a
    designed degradation, and whatever did start is stopped before the refusal.
    """
    cli_context = context.ensure_object(CliContext)
    host = cli_context.host(cli_context.addons_root)

    for broken in host.broken:
        click.echo(f"  skipped {broken.id}: {broken.reason}")

    for held_back in host.children.held_back:
        click.echo(f"  held back {held_back.id}: {held_back.reason}")

    try:
        report = host.start()
    except ChildError as error:
        # Whatever did start must not be left running with nothing owning it.
        host.shutdown()
        raise click.ClickException(str(error)) from error

    for record in report.started:
        click.echo(f"  started {record.id} (process {record.pid})")

    for degradation in report.degraded:
        click.echo(f"  not started {degradation.component}: {degradation.reason}")

    try:
        cli_context.supervise(host.children)
    finally:
        # Reverse start order, terminate escalating to kill: a child left behind is a child
        # nothing owns, holding a socket the next host will try to open.
        host.shutdown()


def _describe_quit(report: QuitReport) -> list[str]:
    """What a quit did, one line per process, plus the one line that matters most.

    The last line is a plain statement about the machine rather than a count: a person typing
    `innytypes quit` wants to know that InnyTypes is off, and anything still running after a
    forced kill has to be said out loud, with its process ID, because it is the one case where
    the command did not do what it promised.
    """
    lines = [
        f"  {stop.record.id} {stop.outcome} (process {stop.record.pid})" for stop in report.stopped
    ]

    if report.left_running:
        for record in report.left_running:
            lines.append(
                f"{record.id} (process {record.pid}) is STILL RUNNING after a forced kill."
            )
        return lines

    lines.append("InnyTypes is off.")
    return lines


@cli.command("quit")
@click.option(
    "--force",
    is_flag=True,
    default=False,
    help="Stop every recorded process directly, without waiting on the helper or the host.",
)
@click.option(
    "--run-state",
    type=click.Path(dir_okay=False, path_type=Path),
    default=None,
    help="Act on this run-state file instead of the per-user one.",
)
@click.pass_context
def quit_command(context: click.Context, force: bool, run_state: Path | None) -> None:
    """Turn the whole InnyTypes application off: plugins, MCP server, host, Anytype, helper.

    The owner's requirement in one command (plan 0003, F1). Plain `innytypes quit` asks the
    helper to do it and then makes sure of it; `--force` asks nobody and stops every process in
    the run-state file itself, politely first and forcibly after, which is what to type when
    something is hung.

    Either way the quit is **recorded before anything is stopped**, so nothing that exits
    during it is treated as a crash, restarted or quarantined. A record whose process ID now
    belongs to a different program is forgotten and never signalled, forced or not, and an
    Anytype this application only adopted is left running (F6).
    """
    cli_context = context.ensure_object(CliContext)
    quitter = cli_context.make_quitter(run_state)

    try:
        report = quitter.force() if force else quitter.quit()
    except RunStateError as error:
        raise click.ClickException(str(error)) from error

    for line in _describe_quit(report):
        click.echo(line)


@cli.group("anytype-mcp")
def anytype_mcp() -> None:
    """The bundled Anytype MCP server."""


@anytype_mcp.command("get-key")
@click.option(
    "--key-file",
    type=click.Path(dir_okay=False, path_type=Path),
    default=None,
    help=f"Where to store the key. Default: {DEFAULT_KEY_FILE}",
)
@click.option(
    "--force",
    is_flag=True,
    default=False,
    help="Replace an existing key file instead of refusing.",
)
def get_key(key_file: Path | None, force: bool) -> None:
    """Obtain an Anytype API key and store it, readable by nobody but you.

    Explicit on purpose (plan 0001, invariant 6): nothing acquires a key at startup.
    """
    click.echo("Anytype Desktop will show a four-digit code — type it here and press Enter.")
    click.echo("The key itself is never printed; it goes straight into the key file.")

    try:
        path = acquire_api_key(key_file=key_file, force=force)
    except ConfigError as error:
        # ClickException prints the message and exits 1, with no traceback. None of these
        # messages contains the credential, which is what makes printing them safe.
        raise click.ClickException(str(error)) from error

    click.echo(f"Stored an Anytype API key in {path} (mode 0600).")


@anytype_mcp.command("refresh-tool-surface")
@click.option(
    "--key-file",
    type=click.Path(dir_okay=False, path_type=Path),
    default=None,
    help=f"Where to read the key from. Default: $ANYTYPE_API_KEY, then {DEFAULT_KEY_FILE}",
)
@click.option(
    "--output",
    type=click.Path(dir_okay=False, path_type=Path),
    default=None,
    help=f"Where to write the surface. Default: {FIXTURE_PATH}",
)
def refresh_tool_surface_command(key_file: Path | None, output: Path | None) -> None:
    """Re-record which tools the pinned server exposes, by asking the real server.

    Needs Node (`npm ci` first) and a running Anytype; nothing else in this repository
    does, and the gate never runs this. Run it when either pin moves: the diff it prints
    is the evidence plan 0002 asks an upgrade to land with.
    """
    try:
        surface, diff = refresh_tool_surface(
            config=load_config(key_file=key_file),
            path=output,
        )
    except (ConfigError, RefreshError) as error:
        # No message from either family contains the credential, which is what makes
        # printing them safe; ClickException prints one and exits 1 with no traceback.
        raise click.ClickException(str(error)) from error

    click.echo(
        f"Recorded {len(surface.tools)} tools for @anyproto/anytype-mcp@"
        f"{surface.package_version} / Anytype-Version {surface.anytype_version}."
    )

    if diff.is_empty:
        click.echo("The tool surface is unchanged.")
        return

    # Printed, not just returned: an upgrade is reviewed by a person reading this list
    # next to the committed fixture's diff.
    for name in diff.added:
        click.echo(f"  added   {name}")
    for name in diff.removed:
        click.echo(f"  removed {name}")
    for name in diff.changed:
        click.echo(f"  changed {name}")


@cli.group("telemetry")
@_config_option
@click.option(
    "--queue",
    "queue_dir",
    type=click.Path(file_okay=False, path_type=Path),
    default=None,
    help=f"Where queued reports wait. Default: {default_queue_path()}",
)
@click.pass_context
def telemetry(ctx: click.Context, config_file: Path | None, queue_dir: Path | None) -> None:
    """The telemetry switch: on, off, what it says now, and what would be sent."""
    ctx.obj = HelperSettings(path=config_file)
    # In the context's meta rather than its object, for the reason the addons group gives:
    # one `obj` slot cannot hold both the settings every subcommand reads and this.
    ctx.meta[QUEUE_DIR_KEY] = queue_dir


@telemetry.command("on")
@click.pass_obj
def telemetry_on(settings: HelperSettings) -> None:
    """Turn telemetry on and store the answer."""
    with _refusing_loudly():
        settings.set_telemetry(True)

    click.echo(f"Telemetry is on, saved in {settings.path}.")


@telemetry.command("off")
@click.pass_obj
def telemetry_off(settings: HelperSettings) -> None:
    """Turn telemetry off. Nothing leaves the machine, and anything queued is dropped."""
    with _refusing_loudly():
        settings.set_telemetry(False)

    click.echo(f"Telemetry is off, saved in {settings.path}.")


@telemetry.command("status")
@click.pass_obj
def telemetry_status(settings: HelperSettings) -> None:
    """Say whether the question has been answered, and what the answer was."""
    with _refusing_loudly():
        state = settings.telemetry

    click.echo(_describe_telemetry(state))
    click.echo(f"Config file: {settings.path}")

    if not state.answered:
        # The notice belongs with the choice (plan 0003, D25), and this is where a person
        # who has not made it yet is standing.
        click.echo()
        click.echo(PRIVACY_NOTICE)


@telemetry.command("show")
@click.pass_context
def telemetry_show(context: click.Context) -> None:
    """Print the queued reports, exactly as they would be sent (plan 0003 D24)."""
    settings: HelperSettings = context.obj
    with _refusing_loudly():
        state = settings.telemetry

    click.echo(_describe_telemetry(state))

    pipeline = build_telemetry_pipeline(settings, context.meta.get(QUEUE_DIR_KEY))
    with _refusing_loudly():
        queued = pipeline.pending()

    if not queued:
        click.echo("No reports are queued.")
        return

    for report in queued:
        destination, body = pipeline.describe(report)
        click.echo()
        click.echo(f"{report.kind.value} report #{report.sequence} → {destination}")
        click.echo(body)


@addons.command("pin")
@click.argument("addon_id")
@click.pass_context
def addons_pin(context: click.Context, addon_id: str) -> None:
    """Hold an addon at its installed version, whatever its update mode says.

    Records a setting; it does not check that the addon is installed. A pin written before an
    addon arrives is the user saying "not this one", and the file is read when nothing runs.
    """
    settings = HelperSettings(path=context.meta.get(CONFIG_FILE_KEY))
    with _refusing_loudly():
        settings.set_pinned(addon_id, True)

    click.echo(f"Pinned {addon_id} at its installed version.")


@addons.command("unpin")
@click.argument("addon_id")
@click.pass_context
def addons_unpin(context: click.Context, addon_id: str) -> None:
    """Release an addon's pin, so its update mode decides again."""
    settings = HelperSettings(path=context.meta.get(CONFIG_FILE_KEY))
    with _refusing_loudly():
        settings.set_pinned(addon_id, False)

    click.echo(f"Unpinned {addon_id}; its update mode decides from now on.")


@addons.command("enable")
@click.argument("addon_id")
@click.pass_context
def addons_enable(context: click.Context, addon_id: str) -> None:
    """Switch a plugin on, so InnyTypes starts it again.

    The switch is recorded here and nothing else happens: this command has no way to reach a
    running host, so it says what it did and what it did not do rather than implying a plugin
    came back. The application's own window flips the same switch and starts the plugin with
    it (plan 0004, *The enable switch*).
    """
    settings = HelperSettings(path=context.meta.get(CONFIG_FILE_KEY))
    with _refusing_loudly():
        settings.set_enabled(addon_id, True)

    click.echo(f"Enabled {addon_id}; InnyTypes starts it again.")
    click.echo("If InnyTypes is running, use the switch in its window to start it now.")


@addons.command("disable")
@click.argument("addon_id")
@click.pass_context
def addons_disable(context: click.Context, addon_id: str) -> None:
    """Switch a plugin off, so InnyTypes does not start it and the helper does not restart it.

    Disabled is not quarantined: this is your own choice, it survives a reboot, and only you
    undo it. `innytypes helper release` is the other thing, and it is for a plugin the helper
    gave up on.
    """
    settings = HelperSettings(path=context.meta.get(CONFIG_FILE_KEY))
    with _refusing_loudly():
        settings.set_enabled(addon_id, False)

    click.echo(f"Disabled {addon_id}; it is not started, and it is not restarted.")
    click.echo("If it is running now, use the switch in the InnyTypes window to stop it.")


@cli.group("helper")
def helper() -> None:
    """InnyTypesHelper: what it is watching, and what it has given up on."""


def _quarantine_file(path: Path | None) -> QuarantineFile:
    return QuarantineFile() if path is None else QuarantineFile(path=path)


_quarantine_option = click.option(
    "--quarantine",
    type=click.Path(dir_okay=False, path_type=Path),
    default=None,
    help="Use this quarantine file instead of the per-user one.",
)


@helper.command("status")
@click.option(
    "--run-state",
    type=click.Path(dir_okay=False, path_type=Path),
    default=None,
    help="Read this run-state file instead of the per-user one.",
)
@_quarantine_option
@click.option(
    "--notices",
    type=click.Path(dir_okay=False, path_type=Path),
    default=None,
    help="Read this notices file instead of the per-user one.",
)
@_config_option
@click.option(
    "--addons-root",
    "addons_root",
    type=click.Path(file_okay=False, path_type=Path),
    default=None,
    help=f"Where addon environments live. Default: {default_addons_root()}",
)
def helper_status(
    run_state: Path | None,
    quarantine: Path | None,
    notices: Path | None,
    config_file: Path | None,
    addons_root: Path | None,
) -> None:
    """Print every managed process and plugin, and every update waiting or held back.

    Read from the files the helper keeps rather than asked of the helper itself: a status
    command that needs the helper to answer says nothing at the moment a person most wants to
    know — when the helper is the thing that is wedged.

    A plugin that is not running has three different ways of not running, and they get three
    different words, because they take three different remedies (plan 0004, *The enable
    switch*): **disabled** is your own switch, **quarantined** is the helper having given up
    and takes `helper release`, and **held-disabled** is a settings form that is not complete
    yet and clears itself when it is. The word is chosen by
    :func:`innytypes.helper.enablement.plugin_state`, which is also what the window draws
    from, so the two cannot disagree.

    The update lines come from the notices file, which the helper rewrites on every tick
    whether or not it posted a notification (plan 0003, D6). So this report says the same thing
    whether the user saw the notification, dismissed it, or was never shown one.
    """
    quarantines = _quarantine_file(quarantine).load()

    try:
        records = RunStateFile(run_state).records()
    except RunStateError as error:
        raise click.ClickException(str(error)) from error

    with _refusing_loudly():
        plugins: dict[str, AvailabilityState] = dict(
            plugin_states(
                installed=discover_addons(addons_root).installed,
                enabled=HelperSettings(path=config_file).is_enabled,
                quarantines=quarantines,
                config_path=config_file,
            )
        )

    running = {record.id for record in records}
    # An installed plugin earns a line when it has something to say: it is running, it is
    # quarantined, or it is one of the two kinds of *not going to run* that take an action
    # from the person reading this. A plugin that is simply enabled and not running is
    # already covered by everything else being stopped, and a list of every plugin repeating
    # "stopped" would bury the two lines that matter.
    speaking_up = {
        plugin_id
        for plugin_id, state in plugins.items()
        if state.availability is not PluginAvailability.ENABLED
    }
    known = sorted(running | set(quarantines) | speaking_up)

    if not known:
        click.echo("Nothing is running, and nothing is quarantined.")
    else:
        for child_id in known:
            click.echo(f"  {child_id}: {_standing(child_id, plugins, quarantines, running)}")

    _echo_notices(notices)


def _standing(
    child_id: str,
    plugins: Mapping[str, AvailabilityState],
    quarantines: Mapping[str, str],
    running: AbstractSet[str],
) -> str:
    """One process's line: the word for it, and the sentence when there is one to give.

    An installed plugin is described by its **availability** whenever that is something other
    than plain `enabled`, because those are the words that name a remedy. An enabled plugin,
    and anything that is not a plugin at all — the host, the MCP server, the helper — is
    described by what its process is doing, which is the question :class:`RunState` answers.
    """
    state = plugins.get(child_id)

    if state is not None and state.availability is not PluginAvailability.ENABLED:
        return f"{state.availability} — {state.reason}"

    if child_id in quarantines:
        return f"{RunState.QUARANTINED} — {quarantines[child_id]}"

    return str(RunState.RUNNING)


def _echo_notices(path: Path | None) -> None:
    """The update conditions, in the same words the notification uses.

    Quarantines are left out here because the process lines above already carry them, from the
    file `release` writes to — and one condition reported twice reads as two problems.
    """
    store = NoticeFile() if path is None else NoticeFile(path=path)
    waiting = [
        notice for notice in store.read() if notice.kind is not NoticeKind.PROCESS_QUARANTINED
    ]

    if not waiting:
        click.echo("No update is waiting, and nothing is held back.")
        return

    for notice in waiting:
        message = compose(notice)
        click.echo(f"  {message.title} — {message.body}")


@helper.command("release")
@click.argument("child_id")
@_quarantine_option
def helper_release(child_id: str, quarantine: Path | None) -> None:
    """Clear a quarantine, so the helper may restart that process again."""
    store = _quarantine_file(quarantine)
    quarantines = store.load()

    if child_id not in quarantines:
        click.echo(f"{child_id} is not quarantined; nothing to release.")
        return

    del quarantines[child_id]
    store.save(quarantines)
    click.echo(f"Released {child_id}; the helper may restart it again.")


def main() -> None:
    """Entry point named by `[project.scripts]`."""
    cli()
