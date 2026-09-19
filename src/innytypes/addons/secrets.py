"""A plugin's `secret` settings: one file per secret, owner-only, and nowhere else.

Plan 0004, decision D6. Eight of the nine setting types are values the host records in the
plugin's own `plugins/<addon-id>.toml`. The ninth is not: a `secret` holds a credential, and
a credential goes where the Anytype API key already goes — a file of its own, mode 0600, in
the per-user config directory, outside the repository and outside the settings file.

The obligations that come with that are the ones :mod:`innytypes.anytype_mcp.keys` already
carries, so this module discharges them the same way rather than inventing a second set:

* **The file is 0600 the moment it exists**, because it is created by ``os.open`` with that
  mode rather than widened by a later ``chmod``. A file that was briefly world-readable is a
  file that was readable.
* **The value is registered with the redactor** the instant it is written or read, so anything
  that later renders it through one of this distribution's loggers prints ``[redacted]``.
  That registry is the same one :func:`innytypes.helper.telemetry.redact` consults, which is
  what puts a stored secret out of reach of a telemetry report as well as a log line.
* **Nothing here renders the credential.** No message repeats a value, the one structure that
  carries values declares its own ``repr``, and the log lines name the plugin, the field and
  the mode — never a byte of the value.

Three things are this module's own, because a plugin's secret is not quite the Anytype key:

**A field id becomes a file name, so it is checked as one.** The manifest's rule for a field
id is "a non-empty string" (:func:`innytypes.addons.manifest.parse_settings`), which would
happily accept ``../../../../etc/cron.d/evil``. A store that turned that into a path would
write an attacker-chosen string to an attacker-chosen file. :data:`_SAFE_NAME` is therefore an
allow-list, applied here, at the boundary where a name becomes a path — and it refuses upper
case as well, because on a case-insensitive filesystem ``Token`` and ``token`` would be two
declared fields sharing one file.

**Writing is scratch-and-rename**, the discipline the helper's config file already uses. An
overwrite must replace the old value whole: a truncate-then-write leaves a shorter new secret
sitting in front of the tail of the old one if the process dies in between, and that tail is
still a credential. The scratch file is created 0600 like the real one, so the window an
overwrite opens is never a window onto a wider mode.

**There is exactly one way back to a value**, :meth:`SecretStore.read`, and it exists for the
host to hand a plugin its own credential at start (slice 05). It is never what the window,
the form or a settings mapping gets: those get :func:`secret_states`, which answers *whether*
a secret is set and nothing more. That is the whole of "the form shows whether a secret is
set, never what it is".

**This module is the other side of one seam, not a second settings store.**
:class:`~innytypes.addons.settings.SettingsStore` records every type but this one and refuses
a write to a `secret` by field; it asks :func:`secret_is_set_for` whether a *required* secret
has been answered, which is the only thing it needs to know. Saving a form (slice 04) sends
the `secret` fields to :func:`store_secret` and everything else to that store, and both answer
in the same :class:`~innytypes.addons.settings.WriteOutcome` shape. The question "is this
field a secret?" has one answer, :func:`~innytypes.addons.settings.is_secret_field`, and it
lives there because that is where the declaration is already read.
"""

from __future__ import annotations

import os
import re
import stat
import threading
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

from innytypes.addons.manifest import SettingsField, is_addon_id
from innytypes.addons.settings import FieldProblem, WriteOutcome, is_secret_field
from innytypes.logs import get_logger, protect

__all__ = [
    "CREDENTIALS_DIRECTORY",
    "SECRETS_DIRNAME",
    "SECRET_DIRECTORY_MODE",
    "SECRET_FILE_MODE",
    "PluginSecretError",
    "SecretStore",
    "default_secrets_root",
    "secret_is_set_for",
    "secret_states",
    "store_secret",
]

log = get_logger(__name__)

# Where every credential this application holds lives: the Anytype API key, and the
# per-plugin secrets in a directory below it.
#
# It is spelled **here**, in the contract layer, and
# :data:`innytypes.anytype_mcp.config.DEFAULT_KEY_FILE` is derived from it — the opposite of
# the way round it started. This module runs inside every addon's own environment, which
# holds `innytypes` with none of the host's libraries (plan 0001, *What an addon environment
# contains*), so it cannot reach into :mod:`innytypes.anytype_mcp` for a path. The host can
# reach the other way whenever it likes.
CREDENTIALS_DIRECTORY = Path.home() / ".config" / "innytypes"

# Beside the Anytype key, in a directory of their own so that removing a plugin (D8) is one
# directory to delete and so the key file keeps a neighbourhood it does not share with a
# growing number of plugin files.
SECRETS_DIRNAME = "secrets"

# Owner-only, for the files and for every directory this module creates.
SECRET_FILE_MODE = 0o600
SECRET_DIRECTORY_MODE = 0o700

# What may become a file name here: lowercase letters and digits, joined by single dots,
# hyphens or underscores. Deliberately narrower than "a non-empty string": this is the one
# place where a name a plugin author chose turns into a path on the user's disk.
_SAFE_NAME = re.compile(r"^[a-z0-9]+(?:[._-][a-z0-9]+)*$")

# The one declared type whose value never goes in the settings file. `list of secret` also
# parses — the vocabulary allows a list of any scalar type — and is refused when a value is
# stored: "one file per secret" has no spelling for a list, and inventing a container format
# for credentials is exactly the kind of thing this module exists to avoid.
SECRET_TYPE = "secret"


class PluginSecretError(ValueError):
    """A plugin secret could not be stored, read or cleared.

    **No message carries a value.** A refusal names the plugin, the field and the file; the
    string that was refused is the one thing that must not end up in whatever log or
    traceback the caller keeps.
    """


def default_secrets_root() -> Path:
    """Where this user's plugin secrets live, creating nothing.

    Beside the Anytype key (D6), and resolved from the same directory rather than spelled
    out a second time: one answer to "where does innytypes keep credentials".
    """
    return CREDENTIALS_DIRECTORY / SECRETS_DIRNAME


# --- what the settings store and the form ask of this one --------------------------------


def secret_is_set_for(addon_id: str, store: SecretStore) -> Callable[[str], bool]:
    """The predicate :class:`~innytypes.addons.settings.SettingsStore` takes.

    That store records every type but `secret`, and asks this one question about the one it
    does not: has a **required** secret been answered, so that the plugin need not be held
    disabled? Bound to one addon id here, so the store it is handed to has no way to ask
    about another plugin's secrets.
    """

    def is_set(field_id: str) -> bool:
        return store.is_set(addon_id, field_id)

    return is_set


def secret_states(
    fields: Sequence[SettingsField],
    *,
    addon_id: str,
    store: SecretStore,
) -> dict[str, bool]:
    """For each declared `secret` field, whether a value is stored — never which value.

    This is the whole of what the form is given about a secret (plan 0004, *Secrets*): a
    password field draws itself from "set" or "not set", and no call anywhere hands it more.
    """
    is_set = secret_is_set_for(addon_id, store)
    return {field.id: is_set(field.id) for field in fields if is_secret_field(field)}


def store_secret(
    fields: Sequence[SettingsField],
    *,
    addon_id: str,
    field_id: str,
    value: object,
    store: SecretStore,
) -> WriteOutcome:
    """Record one secret against its declaration — the secret half of saving a form.

    The mirror of :meth:`~innytypes.addons.settings.SettingsStore.write`, and it answers in
    the same shape: a field is either recorded or refused with a reason to show beside its
    widget. Slice 04 saves a form by sending the `secret` fields here and everything else
    there, and has one kind of result to merge.

    **No reason ever carries the value.** Every refusal below names the field, the type or the
    file, and :class:`PluginSecretError` — which the store raises for a name it will not turn
    into a path, or for a write the operating system refused — is quoted for the same reason:
    it is built to name everything except what was being stored.

    Who may write a secret is **not** decided here. `written_by` is the settings store's rule
    (F2) and applies to a secret exactly as it applies to a path; this function is reached
    once that question has been answered.
    """
    declared = {field.id: field for field in fields}
    field = declared.get(field_id)

    if field is None:
        return _refused(
            field_id,
            f"{field_id} is not a setting {addon_id} declares, so there is nothing to store "
            "it against",
        )

    if not is_secret_field(field):
        return _refused(
            field_id,
            f"{field_id} is declared {field.type!r}, not a secret: its value belongs in "
            f"{addon_id}'s settings file, not in a file of its own",
        )

    if field.element_type == SECRET_TYPE:
        return _refused(
            field_id,
            f"{field_id} is declared {field.type!r}, and a secret is stored one file per "
            "value: declare one secret field per credential instead",
        )

    if not isinstance(value, str):
        return _refused(
            field_id,
            f"{field_id} is a secret and must be a string, got {type(value).__name__}",
        )

    # Registered the moment it is recognised as a secret, before the write and before any
    # refusal below it: whatever happens next, nothing in this package can render it.
    protect(value.strip())

    try:
        store.write(addon_id, field_id, value)
    except PluginSecretError as error:
        return _refused(field_id, str(error))

    return WriteOutcome(recorded=(field_id,), refused=())


def _refused(field_id: str, reason: str) -> WriteOutcome:
    """One field refused, in the shape the settings store already refuses fields in."""
    return WriteOutcome(recorded=(), refused=(FieldProblem(field_id, reason),))


# --- the store -----------------------------------------------------------------------------


@dataclass(frozen=True)
class SecretStore:
    """One file per secret, under ``root``, owner-only all the way down.

    ``root`` is injected everywhere — no method defaults to :func:`default_secrets_root` — so
    no test can reach the real per-user config directory by forgetting an argument.

    Holds no value of its own, so its ``repr`` is the dataclass's and carries nothing but a
    path.
    """

    root: Path

    # --- naming ---------------------------------------------------------------------------

    def path_for(self, addon_id: str, field_id: str) -> Path:
        """The file one secret lives in, after both names have been checked as file names.

        The check is the security boundary of this module: a field id is only "a non-empty
        string" as far as the manifest is concerned, and this is where it becomes a path.
        """
        if _SAFE_NAME.match(field_id) is None:
            raise PluginSecretError(
                f"settings field id {field_id!r} cannot name a file: a secret is stored in a "
                "file of its own, so its field id must be lowercase letters and digits joined "
                "by single dots, hyphens or underscores"
            )
        return self.directory_for(addon_id) / field_id

    def directory_for(self, addon_id: str) -> Path:
        """The directory one plugin's secrets live in, after its id has been checked."""
        if not is_addon_id(addon_id):
            raise PluginSecretError(
                f"{addon_id!r} is not an addon id, so it cannot name the directory a secret "
                "is stored in; nothing was stored"
            )
        return self.root / addon_id

    # --- writing --------------------------------------------------------------------------

    def write(self, addon_id: str, field_id: str, value: str) -> Path:
        """Store one secret, owner-only, replacing any previous value whole. Returns its path.

        Atomic: the value is written to a scratch file created 0600 and then renamed over the
        target. A rename replaces a symlink at the destination rather than writing through
        it, so a link planted where a secret belongs is destroyed instead of followed.
        """
        path = self.path_for(addon_id, field_id)

        secret = value.strip()
        if not secret:
            # An empty secret file reads as "configured" and then fails at the far end, which
            # is a much harder thing to diagnose than a field that is simply not set. The
            # gesture for "no longer set" is `clear`.
            raise PluginSecretError(
                f"refusing to store an empty secret for {addon_id}.{field_id}: clear the "
                "field instead of storing nothing in it"
            )

        # Registered before the write, not after: from here on nothing in this package can
        # render it, whatever the write does.
        protect(secret)

        self._private_directory(self.root)
        self._private_directory(path.parent)

        # Per process and per thread, as the helper's config file and the telemetry queue
        # already do: the window and the CLI can both be writing, and two writers sharing one
        # scratch name corrupt each other.
        scratch = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.new")
        try:
            # A leftover scratch from a process that died mid-write is ours to remove; the
            # O_EXCL that follows is what refuses anything that appears in between, including
            # a symlink somebody planted at this name.
            scratch.unlink(missing_ok=True)
            descriptor = os.open(
                scratch,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                SECRET_FILE_MODE,
            )
            with os.fdopen(descriptor, "wb") as handle:
                # os.open's mode applies only when the file is created, and it is filtered
                # through the umask — which can remove the owner's own bits. Set it again so
                # the result does not depend on how the process was started.
                os.fchmod(descriptor, SECRET_FILE_MODE)
                handle.write(secret.encode("utf-8"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(scratch, path)
        except OSError as error:
            # Whatever failed, no half-written credential is left lying about.
            scratch.unlink(missing_ok=True)
            raise PluginSecretError(
                f"could not store the secret for {addon_id}.{field_id} in {path}: {error.strerror}"
            ) from None

        log.info("stored the %s secret for %s with mode %o", field_id, addon_id, SECRET_FILE_MODE)
        return path

    # --- reading --------------------------------------------------------------------------

    def is_set(self, addon_id: str, field_id: str) -> bool:
        """Whether a secret is stored for this field. **The only question the form asks.**

        Never follows a symlink and never reads a byte: a link, a directory or an empty file
        where a secret belongs is "not set", which is also what :meth:`read` will say about
        them rather than handing on whatever they point at.
        """
        try:
            status = self.path_for(addon_id, field_id).lstat()
        except (OSError, PluginSecretError):
            return False
        return stat.S_ISREG(status.st_mode) and status.st_size > 0

    def read(self, addon_id: str, field_id: str) -> str | None:
        """The stored secret, or ``None`` if there is none. **The only way back to a value.**

        This exists so the host can hand a plugin the credential the plugin itself stored —
        an OAuth token, a paired device (D11). It is never what the window, the form or a
        reported settings mapping is given: those get :func:`secret_states`.

        Registers what it read with the package redactor, so a value written by a previous
        run is as unrenderable as one written by this one.
        """
        path = self.path_for(addon_id, field_id)

        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return None
        except OSError as error:
            # ELOOP: the path is a symlink, which O_NOFOLLOW refused. Reading through it
            # would hand the addon some other file's contents under its own field's name.
            raise PluginSecretError(
                f"the secret for {addon_id}.{field_id} could not be read from {path}: it is "
                f"not a regular file this store wrote ({error.strerror})"
            ) from None

        # Checked on the descriptor rather than on the path, and before a single byte is read:
        # a directory opens perfectly well for reading, and reading one raises from somewhere
        # that would have to describe what it was holding. The descriptor is closed by hand on
        # this path, because `os.fdopen` below is what otherwise takes ownership of it — and
        # closing it twice would eventually close some other file this process had opened.
        try:
            regular = stat.S_ISREG(os.fstat(descriptor).st_mode)
        except OSError:
            os.close(descriptor)
            raise

        if not regular:
            os.close(descriptor)
            raise PluginSecretError(
                f"the secret for {addon_id}.{field_id} could not be read from {path}: it is "
                "not a regular file this store wrote"
            )

        with os.fdopen(descriptor, "rb") as handle:
            raw = handle.read()

        try:
            secret = raw.decode("utf-8")
        except UnicodeDecodeError:
            # The message says how much there was and nothing about what it was: on a file
            # that decoded far enough to be interesting, the bytes are the thing to withhold.
            raise PluginSecretError(
                f"the secret for {addon_id}.{field_id} in {path} is not UTF-8 text "
                f"({len(raw)} bytes); it was not written by this store"
            ) from None

        if not secret:
            return None

        protect(secret)
        return secret

    # --- clearing -------------------------------------------------------------------------

    def clear(self, addon_id: str, field_id: str) -> bool:
        """Forget one secret. ``True`` if there was one, ``False`` if there was not."""
        path = self.path_for(addon_id, field_id)
        try:
            path.unlink()
        except FileNotFoundError:
            return False
        except OSError as error:
            raise PluginSecretError(
                f"the secret for {addon_id}.{field_id} could not be removed from {path}: "
                f"{error.strerror}"
            ) from None

        log.info("cleared the %s secret for %s", field_id, addon_id)
        return True

    def clear_addon(self, addon_id: str) -> int:
        """Forget every secret one plugin had, and say how many there were (D8).

        What `addons remove` calls. Removes the files this store wrote and then the directory
        itself; anything else that is in there is left alone and leaves the directory behind,
        because deleting what we did not write is how a remove turns into a disaster.
        """
        directory = self.directory_for(addon_id)

        try:
            entries = sorted(directory.iterdir())
        except (FileNotFoundError, NotADirectoryError):
            return 0
        except OSError as error:
            raise PluginSecretError(
                f"the secrets of {addon_id} could not be listed in {directory}: {error.strerror}"
            ) from None

        removed = 0
        for entry in entries:
            if entry.is_symlink() or not entry.is_file():
                continue
            entry.unlink(missing_ok=True)
            removed += 1

        # Only when it is empty: `rmdir` refuses a directory that still holds something, which
        # is exactly the behaviour wanted for anything this store did not write.
        try:
            directory.rmdir()
        except OSError:
            log.info("kept %s: it holds something this store did not write", directory)

        log.info("cleared %d secret(s) for %s", removed, addon_id)
        return removed

    # --- the directories --------------------------------------------------------------------

    @staticmethod
    def _private_directory(directory: Path) -> None:
        """Create ``directory`` owner-only, and tighten it if something has widened it.

        Unlike :func:`innytypes.anytype_mcp.keys._ensure_private_directory`, this one does set
        the mode on a directory that already exists. The difference is ownership of the
        decision: that function's directory is ``~/.config/innytypes``, which belongs to the
        user and is normally readable by their group; these directories are this store's own,
        they hold nothing but credentials, and a mode on them that is not 0700 is not a
        preference — it is a mistake.

        The parents above :data:`SECRETS_DIRNAME` are created with the default mode and left
        alone, for the same reason.
        """
        try:
            directory.mkdir(parents=True, exist_ok=True)
            os.chmod(directory, SECRET_DIRECTORY_MODE)
        except OSError as error:
            raise PluginSecretError(
                f"could not make {directory} a private directory for plugin secrets: "
                f"{error.strerror}"
            ) from None
