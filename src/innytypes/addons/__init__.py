"""The addon-facing side of the host: what an addon declares, and what the host reads.

This package holds the **contracts**, never an addon. The host depends on no addon (plan
0001), so nothing here imports addon code — it parses the manifests recorded when addons
were installed, each in its own environment.

The manifest is the first of those contracts, because discovery, dependency resolution and
the event bus all start by reading one.

**This module re-exports nothing, deliberately.** An addon process runs
:mod:`innytypes.addons.run` inside its own environment, and importing that module imports
this one first — so every name gathered up here would be a module the addon's interpreter
has to load before the addon starts. Re-exporting :mod:`innytypes.addons.install` pulled
the whole installer, the MCP package and the host's third-party libraries into a process
that installs nothing, which is how `innytypes` came to pin `psutil` for every plugin that
also named it (plan 0001, *What an addon environment contains*). Import from the module
that defines the name.
"""
