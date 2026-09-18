"""``python -m helper``: the built bundle's one launcher, in either of its roles.

Which role this is comes from the argument the operating system was given, and the reading of
it is :func:`innytypes.helper.launcher.run_bundled`'s — not this file's. See :mod:`helper`.
"""

from __future__ import annotations

import sys

from innytypes.helper.launcher import run_bundled

if __name__ == "__main__":
    run_bundled(sys.argv[1:])
