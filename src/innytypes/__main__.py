"""``python -m innytypes``: the CLI, reached through the interpreter rather than a script.

This exists so the helper can start the host with a command whose **executable is the
interpreter** — which is what the operating system reports for a console script, and therefore
what the host's run-state record has to say if its identity is ever to verify (plan 0003,
*Phantom detection*). A record naming the `innytypes` script's own path could never be
confirmed, and an unverifiable record is one nothing will ever signal.
"""

from __future__ import annotations

from innytypes.cli import main

if __name__ == "__main__":
    main()
