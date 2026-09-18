"""Console entry point for the host — the commands a person actually types.

Three of them are the host itself:

`innytypes addons install` is the **only** way an addon arrives (plan 0001, invariant 6).
It builds the addon its own environment, pins `innytypes` inside it at the version this
host is running, and records the manifest the addon exports so discovery can find it.

`innytypes addons list` is the read side of the same thing: what is installed, and what is
installed-but-broken, printed together so nothing is quietly missing from the list.

`innytypes addons outdated` asks each addon's declared source what it publishes and prints
three facts per addon: the installed version, the newest **compatible** version, and — when
the newest published version is not the one that may be taken — the numbered consistency rule
that stands in the way (plan 0003, *Consistency*). It decides and prints; it installs
nothing.

`innytypes up` brings the host and its children up and **installs nothing on the way**. It
discovers, it starts, it waits, it stops — no environment is created, downloaded or written
to by any part of it. A startup that mutates the environment is a startup nobody can debug.
The host it starts is :func:`innytypes.host.build_host`'s, and there is no other: what `up`
prints is :class:`~innytypes.host.HostReport`, so a missing key or an Anytype that is not
running is a line in the output and an exit code of zero (plan 0001, *A missing requirement
degrades, it does not crash*), never a command that refuses with nothing started.

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
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

import click

from innytypes import __version__
from innytypes.addons.discovery import discover_addons
from innytypes.addons.install import AddonInstaller, InstallError, UvInstaller, install_addon
from innytypes.addons.manifest import ManifestError, parse_requirement
from innytypes.anytype_mcp.config import DEFAULT_KEY_FILE, ConfigError, load_config
from innytypes.anytype_mcp.keys import acquire_api_key
from innytypes.anytype_mcp.refresh import RefreshError, refresh_tool_surface
from innytypes.anytype_mcp.tools import FIXTURE_PATH
from innytypes.children import ChildError, ChildExit, ChildSupervisor, RunStateError, RunStateFile
from innytypes.helper.breaker import QuarantineFile, RunState
from innytypes.helper.config import (
    HelperConfigError,
    HelperSettings,
    Telemetry,
    default_config_path,
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


def build_version_checker(settings: HelperSettings) -> VersionChecker:
    """The real checker: the live config, real HTTP, real `git`, real `uv` for the lock."""
    return VersionChecker(settings=settings, resolve_lock=UvLockResolver())


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


# Where the addons group leaves `--config` for pin and unpin (see the group's docstring).
CONFIG_FILE_KEY = "innytypes.config_file"


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
@click.pass_context
def addons(context: click.Context, config_file: Path | None) -> None:
    """The addons installed on this machine.

    `--config` belongs to `pin`, `unpin` and `outdated`, which write or read a helper
    setting. It is stashed in the context's meta rather than its object, because `install`
    and `list` already receive a :class:`CliContext` there and one slot cannot hold both.
    """
    context.meta[CONFIG_FILE_KEY] = config_file


@addons.command("install")
@click.argument("requirement")
@click.option(
    "--force",
    is_flag=True,
    default=False,
    help="Replace an existing installation instead of refusing.",
)
@click.pass_context
def addons_install(context: click.Context, requirement: str, force: bool) -> None:
    """Install one addon into its own environment: `innytypes addons install monty==1.4.0`.

    Explicit on purpose (plan 0001, invariant 6): no command installs an addon as a side
    effect of doing something else, and `up` installs nothing at all.
    """
    cli_context = context.ensure_object(CliContext)

    try:
        pinned = parse_requirement(requirement)
    except ManifestError as error:
        raise click.ClickException(
            f"{requirement!r} does not name an addon at an exact version: write "
            "'<addon-id>==<version>', for example 'monty==1.4.0'"
        ) from error

    try:
        addon = install_addon(
            pinned,
            installer=cli_context.installer,
            root=cli_context.addons_root,
            force=force,
        )
    except InstallError as error:
        raise click.ClickException(str(error)) from error

    click.echo(f"Installed {addon.id} {addon.manifest.version} in {addon.environment}.")
    click.echo(f"Recorded its manifest at {addon.manifest_path}.")


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
        click.echo(f"{addon.id}  {addon.manifest.version}  installed")
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
@click.pass_context
def telemetry(ctx: click.Context, config_file: Path | None) -> None:
    """The telemetry switch: on, off, what it says now, and what would be sent."""
    ctx.obj = HelperSettings(path=config_file)


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


@telemetry.command("show")
@click.pass_obj
def telemetry_show(settings: HelperSettings) -> None:
    """Print the queued reports, exactly as they would be sent (plan 0003 D24)."""
    with _refusing_loudly():
        state = settings.telemetry

    click.echo(_describe_telemetry(state))

    # Said plainly rather than printed as an empty list: "nothing is queued" would claim a
    # queue was consulted, and there is no queue to consult until slice 08 builds one.
    click.echo(
        "No queued reports to show: no telemetry queue exists yet — the on-disk queue "
        "lands with the telemetry pipeline (plan 0003 slice 08)."
    )


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
def helper_status(run_state: Path | None, quarantine: Path | None) -> None:
    """Print every managed process and whether it is running or quarantined.

    Read from the two files the helper keeps rather than asked of the helper itself: a status
    command that needs the helper to answer says nothing at the moment a person most wants to
    know — when the helper is the thing that is wedged.
    """
    quarantines = _quarantine_file(quarantine).load()

    try:
        records = RunStateFile(run_state).records()
    except RunStateError as error:
        raise click.ClickException(str(error)) from error

    running = {record.id for record in records}
    known = sorted(running | set(quarantines))

    if not known:
        click.echo("Nothing is running, and nothing is quarantined.")
        return

    for child_id in known:
        if child_id in quarantines:
            click.echo(f"  {child_id}: {RunState.QUARANTINED} — {quarantines[child_id]}")
        else:
            click.echo(f"  {child_id}: {RunState.RUNNING}")


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
