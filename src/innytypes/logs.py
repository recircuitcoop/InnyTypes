"""One place where a credential is removed from a log record.

Every module in this distribution logs through :func:`get_logger`, and every logger it
hands back carries :data:`REDACTOR`. The alternative — each call site remembering not to
format the API key into its own message — is the arrangement that eventually loses a key,
because it only has to be forgotten once, in one branch, on one bad afternoon.

The mechanism is exact-match rather than pattern-matching on purpose. A
:class:`~innytypes.anytype_mcp.config.ServerConfig` registers its key with :func:`protect`
the moment it is built, and the filter removes precisely that string from whatever the
record would render. A pattern that guesses what a credential looks like fails *open* on
the credentials it did not anticipate, and a redactor that fails open is decoration.

The cost of exact matching is that the key is held here for the life of the process. That
is a deliberate trade rather than an oversight: the same string already lives in the
``ServerConfig`` and in the child process's environment, whereas a redactor that can
quietly forget a secret is a redactor that silently stops working.

This module imports nothing but the standard library, which is why it sits at the top of
the distribution rather than inside :mod:`innytypes.anytype_mcp`, where it started. The
redactor is needed by the contract layer an addon environment installs — a plugin's secret
store registers its values here too — and that layer may reach nothing a third-party
library would follow (plan 0001, *What an addon environment contains*). Anything holding a
credential can depend on this module, from either side, without a cycle and without a pin.
"""

from __future__ import annotations

import logging

# What a redacted credential is replaced with. Kept recognisable on purpose: a log that
# says a value was removed is much easier to read than one with a hole in it.
REDACTED = "[redacted]"

# Every credential this package must never render. A set, so registering twice is free.
_SECRETS: set[str] = set()


def protect(secret: str) -> None:
    """Register a credential that must never appear in a log record of this package."""
    # An empty secret would be worse than useless: ``"x".replace("", "…")`` inserts the
    # marker between every single character, so one empty registration would destroy every
    # log line in the process.
    if secret:
        _SECRETS.add(secret)


def redact(text: str) -> str:
    """``text`` with every protected credential replaced by :data:`REDACTED`."""
    # Longest first: where one secret contains another, replacing the longer one first
    # leaves a readable result instead of a half-substituted fragment.
    for secret in sorted(_SECRETS, key=len, reverse=True):
        text = text.replace(secret, REDACTED)
    return text


class SecretRedactingFilter(logging.Filter):
    """Removes protected credentials from a record before any handler can see it."""

    def filter(self, record: logging.LogRecord) -> bool:
        # The *rendered* message is what matters. A log argument can be any object, and a
        # credential hides in its ``str()`` rather than in the template, so rendering once
        # here covers every shape a call site can take.
        message = record.getMessage()
        redacted = redact(message)
        if redacted != message:
            # The message is now rendered, so the arguments have been consumed. Clearing
            # them is what stops a handler applying them a second time to the new string —
            # and it is why a clean record keeps its arguments: structured handlers should
            # still see fields whenever there was nothing to remove.
            record.msg = redacted
            record.args = ()

        # A formatter that has already rendered a traceback caches it here, and a traceback
        # carries exception messages that a caller may have built out of configuration.
        if record.exc_text:
            record.exc_text = redact(record.exc_text)

        # A filter returning False drops the record. This one removes credentials, never
        # evidence: a supervisor whose logs disappear is worse than one that logs too much.
        return True

    def __repr__(self) -> str:
        # The default ``Filter`` repr is harmless, but this is the one object in the process
        # whose state is entirely credentials. It does not get a revealing repr.
        return f"<{type(self).__name__}>"


# One shared instance, so a test can unhook it and prove that it is what does the work.
REDACTOR = SecretRedactingFilter()


def get_logger(name: str) -> logging.Logger:
    """The logger for ``name``, with :data:`REDACTOR` installed on it.

    The filter goes on each logger itself rather than on the package logger above them.
    Python runs a logger's own filters when a record is emitted, but propagation walks up
    to ancestor *handlers* without running those ancestors' filters — so a single filter on
    ``innytypes.anytype_mcp`` would never see a record from
    ``innytypes.anytype_mcp.supervisor``.
    """
    logger = logging.getLogger(name)
    if REDACTOR not in logger.filters:
        logger.addFilter(REDACTOR)
    return logger
