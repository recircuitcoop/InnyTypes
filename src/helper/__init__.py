"""The package Briefcase runs when the user clicks the InnyTypes icon — and nothing else.

**Why it exists, and why it is called `helper`.** Briefcase starts a bundled application with
``python -m <package>``, where the package's name *is* the application's name in
`[tool.briefcase]` — and that same name is appended to the bundle prefix to form the bundle
identifier. Plan 0003's D27 fixes that identifier at `it.l1nx.innytypes.helper`, and three
platforms already depend on the exact string (the macOS bundle, the Linux `.desktop` entry and
window class, the Windows AppUserModelID), so the application is named `helper` and the package
Briefcase runs is therefore `helper`. Naming it anything else would move the identifier, and
moving the identifier would break a click on a Linux notification.

**It holds no behaviour, and that is the whole design.** :mod:`helper.__main__` calls the same
:func:`innytypes.helper.launcher.main` that the `innytypes-helper` console script names, so a
bundle and an unpackaged installation start the application through one function. A test
asserts that the two still name the same thing, because the failure this package could
otherwise cause is silent: a renamed entry point would leave a bundle that builds, installs,
opens and does nothing.

It sits outside the `innytypes` package and outside the wheel on purpose — `pip install
innytypes` neither ships it nor needs it.
"""

from __future__ import annotations

__all__: list[str] = []
