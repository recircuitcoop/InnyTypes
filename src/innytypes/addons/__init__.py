"""The addon-facing side of the host: what an addon declares, and what the host reads.

This package holds the **contracts**, never an addon. The host depends on no addon (plan
0001), so nothing here imports addon code — it parses the manifests recorded when addons
were installed, each in its own environment.

The manifest is the first of those contracts, because discovery, dependency resolution and
the event bus all start by reading one.
"""

from innytypes.addons.discovery import (
    ADDONS_DIRNAME,
    APPLICATION_NAME,
    ENVIRONMENT_DIRNAME,
    MANIFEST_FILENAME,
    BrokenAddon,
    DiscoveryResult,
    InstalledAddon,
    addon_environment,
    addon_root,
    default_addons_root,
    discover_addons,
    recorded_manifest_path,
)
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
from innytypes.addons.resolution import (
    DependencyCycleError,
    HeldBackAddon,
    ResolutionError,
    StartPlan,
    resolve_start_order,
)

__all__ = [
    "ADDONS_DIRNAME",
    "APPLICATION_NAME",
    "ENVIRONMENT_DIRNAME",
    "MANIFEST_FILENAME",
    "SUPPORTED_HOST_API_VERSIONS",
    "AddonManifest",
    "BrokenAddon",
    "DependencyCycleError",
    "DiscoveryResult",
    "EventKind",
    "HeldBackAddon",
    "InstalledAddon",
    "KindPrefix",
    "ManifestError",
    "Requirement",
    "ResolutionError",
    "StabilityProfile",
    "StartPlan",
    "UpdateSource",
    "addon_environment",
    "addon_root",
    "default_addons_root",
    "discover_addons",
    "parse_kind",
    "parse_manifest",
    "parse_requirement",
    "parse_subscription",
    "recorded_manifest_path",
    "resolve_start_order",
]
