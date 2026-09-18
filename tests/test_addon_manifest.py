"""The manifest contract: what parses, and — mostly — what is refused.

Every refusal here is a test that turns red when its check is deleted. That is deliberate:
the cheapest way to "satisfy" a requirement to refuse something is to not implement it, so
each refusal in `innytypes.addons.manifest` owns a test that asserts both the raise and the
offender named in the message.
"""

from __future__ import annotations

import pytest

from innytypes import HOST_API_VERSION
from innytypes.addons.manifest import (
    SUPPORTED_HOST_API_VERSIONS,
    AddonManifest,
    EventKind,
    KindPrefix,
    ManifestError,
    Requirement,
    parse_kind,
    parse_manifest,
    parse_subscription,
)


def manifest_data(**overrides: object) -> dict[str, object]:
    """A manifest that parses, so each test can break exactly one thing."""
    data: dict[str, object] = {
        "id": "whodunnit",
        "version": "1.0.0",
        "host_api": HOST_API_VERSION,
        "requires": ["monty==1.4.0"],
        "emits": ["whodunnit.transcribed.v1"],
        "subscribes": ["monty.recorded.v1", "summarize.*"],
    }
    data.update(overrides)
    return data


# --- the happy path: a typed object, not a dict ------------------------------------------


def test_a_full_manifest_parses_into_readable_fields() -> None:
    manifest = parse_manifest(manifest_data())

    assert isinstance(manifest, AddonManifest)
    assert manifest.id == "whodunnit"
    assert manifest.version == "1.0.0"
    assert manifest.host_api == HOST_API_VERSION
    # Every field below is reached by attribute, never by a dict lookup.
    assert manifest.requires == (Requirement(addon_id="monty", version="1.4.0"),)
    assert manifest.emits == (EventKind(addon_id="whodunnit", name="transcribed", version=1),)
    assert manifest.subscribes == (
        EventKind(addon_id="monty", name="recorded", version=1),
        KindPrefix(prefix="summarize"),
    )
    assert manifest.stability is None
    assert manifest.update is None


def test_parsed_kinds_and_requirements_render_back_to_their_wire_form() -> None:
    manifest = parse_manifest(manifest_data())

    assert str(manifest.emits[0]) == "whodunnit.transcribed.v1"
    assert str(manifest.subscribes[1]) == "summarize.*"
    assert str(manifest.requires[0]) == "monty==1.4.0"


def test_a_manifest_may_require_emit_and_subscribe_to_nothing() -> None:
    manifest = parse_manifest(manifest_data(requires=[], emits=[], subscribes=[]))

    assert manifest.requires == ()
    assert manifest.emits == ()
    assert manifest.subscribes == ()


# --- requires: exact pins only ------------------------------------------------------------


@pytest.mark.parametrize(
    "entry",
    [
        "monty>=1.0",
        "monty<2.0",
        "monty~=1.0",
        "monty==1.*",
        "monty",
        "monty==",
        "Monty==1.0",
    ],
)
def test_a_requires_entry_that_is_not_an_exact_pin_is_refused(entry: str) -> None:
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(requires=[entry]))

    # The message names the offending entry — a resolver's user has to know which line.
    assert entry in str(refusal.value)


def test_an_exact_pin_is_accepted() -> None:
    manifest = parse_manifest(manifest_data(requires=["monty==1.4.0", "summarize==0.2"]))

    assert [r.addon_id for r in manifest.requires] == ["monty", "summarize"]
    assert [r.version for r in manifest.requires] == ["1.4.0", "0.2"]


# --- the kind grammar ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "kind",
    [
        "whodunnit.transcribed",
        "Whodunnit.Transcribed.v1",
        "whodunnit.transcribed.vX",
        "whodunnit.transcribed.v1.v2",
        "whodunnit.transcribed.1",
        "whodunnit.transcribed.v0",
        "whodunnit.transcribed.v01",
        "whodunnit..v1",
        ".transcribed.v1",
        "",
    ],
)
def test_a_kind_that_breaks_the_grammar_is_refused_by_name(kind: str) -> None:
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(emits=[kind]))

    assert repr(kind) in str(refusal.value)


def test_a_broken_kind_in_subscribes_is_refused_too() -> None:
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(subscribes=["monty.recorded"]))

    assert "monty.recorded" in str(refusal.value)


def test_parse_kind_reads_the_three_parts() -> None:
    kind = parse_kind("anytype-mcp.object-created.v12")

    assert kind.addon_id == "anytype-mcp"
    assert kind.name == "object-created"
    assert kind.version == 12


# --- emits: the namespace is the addon's own ----------------------------------------------


def test_emitting_another_addons_namespace_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(emits=["monty.recorded.v1"]))

    message = str(refusal.value)
    assert "monty.recorded.v1" in message
    assert "whodunnit" in message


# --- subscribes: exact or prefix; emits: exact only ---------------------------------------


def test_subscribes_takes_both_an_exact_kind_and_a_prefix() -> None:
    manifest = parse_manifest(
        manifest_data(subscribes=["monty.recorded.v1", "monty.*", "monty.recorded.*"])
    )

    assert manifest.subscribes == (
        EventKind(addon_id="monty", name="recorded", version=1),
        KindPrefix(prefix="monty"),
        KindPrefix(prefix="monty.recorded"),
    )


def test_a_prefix_in_emits_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(emits=["whodunnit.*"]))

    message = str(refusal.value)
    assert "whodunnit.*" in message
    assert "subscribes" in message


def test_a_malformed_prefix_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(subscribes=["Monty.*"]))

    assert "Monty.*" in str(refusal.value)


def test_parse_subscription_returns_the_two_shapes() -> None:
    assert parse_subscription("monty.recorded.v1") == EventKind("monty", "recorded", 1)
    assert parse_subscription("monty.*") == KindPrefix("monty")


# --- the host API contract ----------------------------------------------------------------


def test_a_host_api_this_host_does_not_implement_is_refused_with_both_versions() -> None:
    unsupported = max(SUPPORTED_HOST_API_VERSIONS) + 1

    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(host_api=unsupported))

    message = str(refusal.value)
    assert str(unsupported) in message
    assert str(HOST_API_VERSION) in message


def test_the_host_api_version_the_host_implements_is_accepted() -> None:
    assert parse_manifest(manifest_data(host_api=HOST_API_VERSION)).host_api == HOST_API_VERSION


# --- the shape of the document itself -----------------------------------------------------


@pytest.mark.parametrize("field", ["id", "version", "host_api", "requires", "emits", "subscribes"])
def test_a_missing_required_field_is_refused_by_name(field: str) -> None:
    data = manifest_data()
    del data[field]

    with pytest.raises(ManifestError) as refusal:
        parse_manifest(data)

    assert field in str(refusal.value)


def test_an_unknown_field_is_refused_rather_than_ignored() -> None:
    # A typo that is ignored is a setting the author believes is in force. Refuse it.
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(subscribed=["monty.*"]))

    assert "subscribed" in str(refusal.value)


@pytest.mark.parametrize("bad_id", ["Whodunnit", "who_dunnit", "1monty", "who dunnit", ""])
def test_an_id_that_cannot_namespace_a_kind_is_refused(bad_id: str) -> None:
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(id=bad_id, emits=[]))

    assert repr(bad_id) in str(refusal.value)


def test_a_host_api_that_is_not_an_integer_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(host_api="1"))

    assert "host_api" in str(refusal.value)


def test_a_version_that_is_not_a_string_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(version=1.0))

    assert "version" in str(refusal.value)


@pytest.mark.parametrize("version", ["*", ">=1.0", "latest", ""])
def test_a_version_that_is_not_an_exact_version_is_refused(version: str) -> None:
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(version=version))

    assert repr(version) in str(refusal.value)


def test_a_kind_list_given_as_one_string_is_refused() -> None:
    # `emits: "whodunnit.transcribed.v1"` iterates into characters if taken literally.
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(emits="whodunnit.transcribed.v1"))

    assert "emits" in str(refusal.value)


def test_a_non_string_entry_in_a_kind_list_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(emits=[1]))

    assert "emits" in str(refusal.value)


# --- the optional stability section (plan 0003) -------------------------------------------


def test_a_manifest_without_the_optional_sections_parses() -> None:
    manifest = parse_manifest(manifest_data())

    assert manifest.stability is None
    assert manifest.update is None


def test_a_stability_section_parses_with_the_plans_defaults() -> None:
    manifest = parse_manifest(manifest_data(stability={"heartbeat_interval": 10}))

    profile = manifest.stability
    assert profile is not None
    assert profile.heartbeat_interval == 10
    # stale_after defaults to 3 x heartbeat_interval.
    assert profile.stale_after == 30
    assert profile.max_rss_mb == 1024
    assert profile.max_cpu_percent == 90
    assert profile.cpu_window == 120
    assert profile.max_open_files == 1024
    assert profile.max_children is None
    assert profile.breach_grace == 60
    assert profile.restartable is True


def test_an_empty_stability_section_promises_no_heartbeats() -> None:
    profile = parse_manifest(manifest_data(stability={})).stability

    assert profile is not None
    assert profile.heartbeat_interval is None
    assert profile.stale_after is None


def test_every_stability_field_can_be_set() -> None:
    profile = parse_manifest(
        manifest_data(
            stability={
                "heartbeat_interval": 5,
                "stale_after": 60,
                "max_rss_mb": 256,
                "max_cpu_percent": 50,
                "cpu_window": 30,
                "max_open_files": 64,
                "max_children": 2,
                "breach_grace": 10,
                "restartable": False,
            }
        )
    ).stability

    assert profile is not None
    assert (profile.heartbeat_interval, profile.stale_after) == (5, 60)
    assert (profile.max_rss_mb, profile.max_cpu_percent, profile.cpu_window) == (256, 50, 30)
    assert (profile.max_open_files, profile.max_children, profile.breach_grace) == (64, 2, 10)
    assert profile.restartable is False


def test_an_unknown_stability_field_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(stability={"heartbeat": 10}))

    assert "heartbeat" in str(refusal.value)


def test_a_stability_section_that_is_not_a_mapping_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(stability=["heartbeat_interval", 10]))

    assert "stability" in str(refusal.value)


@pytest.mark.parametrize("value", ["10", None, True])
def test_a_stability_number_that_is_not_a_number_is_refused(value: object) -> None:
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(stability={"heartbeat_interval": value}))

    assert "heartbeat_interval" in str(refusal.value)


@pytest.mark.parametrize("value", [0, -1])
def test_a_stability_limit_that_is_not_positive_is_refused(value: int) -> None:
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(stability={"max_rss_mb": value}))

    assert "max_rss_mb" in str(refusal.value)


def test_a_stability_count_that_is_not_an_integer_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(stability={"max_open_files": 64.5}))

    assert "max_open_files" in str(refusal.value)


def test_a_non_positive_count_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(stability={"max_children": 0}))

    assert "max_children" in str(refusal.value)


def test_restartable_must_be_a_boolean() -> None:
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(stability={"restartable": "no"}))

    assert "restartable" in str(refusal.value)


def test_a_stale_window_without_heartbeats_is_refused() -> None:
    # Nothing can go stale when nothing was ever promised, so this is a mistake, not a default.
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(stability={"stale_after": 30}))

    assert "stale_after" in str(refusal.value)


# --- the optional update section (plan 0003 D15) ------------------------------------------


def test_an_update_section_parses_and_defaults_to_the_stable_channel() -> None:
    update = parse_manifest(
        manifest_data(update={"source": "https://example.invalid/index"})
    ).update

    assert update is not None
    assert update.source == "https://example.invalid/index"
    assert update.channel == "stable"


def test_an_update_channel_can_be_chosen() -> None:
    data = manifest_data(update={"source": "pypi:whodunnit", "channel": "beta"})

    update = parse_manifest(data).update

    assert update is not None
    assert update.channel == "beta"


def test_an_update_section_without_a_source_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(update={"channel": "stable"}))

    assert "source" in str(refusal.value)


@pytest.mark.parametrize("update", [{"source": ""}, {"source": "pypi:x", "channel": ""}])
def test_an_empty_update_value_is_refused(update: dict[str, str]) -> None:
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(update=update))

    assert "update" in str(refusal.value)


def test_an_unknown_update_field_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(update={"source": "pypi:x", "mode": "auto"}))

    # The update *mode* is the user's setting in the helper's config, never the addon's claim.
    assert "mode" in str(refusal.value)


def test_an_update_source_that_is_not_a_string_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(update={"source": 1}))

    assert "source" in str(refusal.value)


def test_an_update_section_that_is_not_a_mapping_is_refused() -> None:
    with pytest.raises(ManifestError) as refusal:
        parse_manifest(manifest_data(update="pypi:whodunnit"))

    assert "update" in str(refusal.value)


# --- the manifest itself --------------------------------------------------------------


def test_a_manifest_that_is_not_a_mapping_is_refused() -> None:
    with pytest.raises(ManifestError):
        parse_manifest(["id", "whodunnit"])  # type: ignore[arg-type]


def test_a_parsed_manifest_is_frozen() -> None:
    manifest = parse_manifest(manifest_data())

    with pytest.raises(AttributeError):
        manifest.id = "monty"  # type: ignore[misc]
