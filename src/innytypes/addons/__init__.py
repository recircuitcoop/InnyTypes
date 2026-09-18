"""The addon-facing side of the host: what an addon declares, and what the host reads.

This package holds the **contracts**, never an addon. The host depends on no addon (plan
0001), so nothing here imports addon code — it parses the manifests recorded when addons
were installed, each in its own environment.

The manifest is the first of those contracts, because discovery, dependency resolution and
the event bus all start by reading one.
"""

from innytypes.addons.manifest import (
    SUPPORTED_HOST_API_VERSIONS,
    AddonManifest,
    EventKind,
    KindPrefix,
    ManifestError,
    Requirement,
    StabilityProfile,
    UpdateSource,
    parse_kind,
    parse_manifest,
    parse_requirement,
    parse_subscription,
)

__all__ = [
    "SUPPORTED_HOST_API_VERSIONS",
    "AddonManifest",
    "EventKind",
    "KindPrefix",
    "ManifestError",
    "Requirement",
    "StabilityProfile",
    "UpdateSource",
    "parse_kind",
    "parse_manifest",
    "parse_requirement",
    "parse_subscription",
]
