"""Event kinds and the bound emitter: who may publish what, and what a payload may contain.

Three refusals carry this slice, and each one is easiest to "pass" by not implementing it —
an emitter that refuses nothing emits every event these tests ask for. So every refusal test
asserts the message *and* that nothing reached the sink, and the unregistered-kind test reads
the registry back afterwards, because auto-registering on first emit would satisfy a careless
reading of the same criterion.

The sink is the seam slice 05 fills with the bus. Here it is a recorder: this slice is the
publish side only, so "the event was emitted" means "the sink was handed it", and no test
touches a queue, a thread or a subscriber.

Every manifest below is built by `manifest()`, which runs the real
`innytypes.addons.manifest.parse_manifest`, so no test can invent an `emits` list the grammar
would have refused on the way in.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path

import pytest

from innytypes import HOST_API_VERSION
from innytypes.addons.manifest import AddonManifest, ManifestError, parse_kind, parse_manifest
from innytypes.events import (
    Emitter,
    Event,
    EventError,
    KindRegistry,
    PayloadError,
    UnownedKindError,
    UnregisteredKindError,
)


class Recorder:
    """A sink that records instead of delivering.

    Slice 05 puts the bus here. Until then this is what proves an emit got through — and,
    just as often below, that a refused one did not.
    """

    def __init__(self) -> None:
        self.events: list[Event] = []

    def __call__(self, event: Event) -> None:
        self.events.append(event)


def manifest(
    addon_id: str,
    *,
    version: str = "1.0.0",
    emits: Sequence[str] = (),
    subscribes: Sequence[str] = (),
) -> AddonManifest:
    """One parsed manifest, so no test invents a shape the grammar would refuse."""
    return parse_manifest(
        {
            "id": addon_id,
            "version": version,
            "host_api": HOST_API_VERSION,
            "requires": [],
            "emits": list(emits),
            "subscribes": list(subscribes),
        }
    )


def bound(addon_id: str, emits: Sequence[str] = ()) -> tuple[KindRegistry, Emitter, Recorder]:
    """A registry with one addon registered, its emitter, and the sink behind it."""
    registry = KindRegistry()
    recorder = Recorder()
    emitter = registry.emitter_for(manifest(addon_id, emits=emits), sink=recorder)
    return registry, emitter, recorder


# --- the binding ---------------------------------------------------------------------------


def test_the_emitter_carries_the_addons_id_so_the_caller_never_passes_it() -> None:
    _registry, emitter, recorder = bound("monty", emits=["monty.recorded.v1"])

    # Two arguments: the kind and the payload. There is no place to put a source id, which
    # is the point — an addon cannot claim to be another one.
    emitter.emit("monty.recorded.v1", {"path": "/volumes/dictaphone/a.wav"})

    assert emitter.addon_id == "monty"
    assert [event.kind for event in recorder.events] == [parse_kind("monty.recorded.v1")]
    assert recorder.events[0].payload == {"path": "/volumes/dictaphone/a.wav"}


def test_an_already_parsed_kind_may_be_emitted_too() -> None:
    _registry, emitter, recorder = bound("monty", emits=["monty.recorded.v1"])

    emitter.emit(parse_kind("monty.recorded.v1"), {"path": "/tmp/a.wav"})

    assert [str(event.kind) for event in recorder.events] == ["monty.recorded.v1"]


def test_a_kind_that_is_not_a_kind_at_all_is_refused_by_the_grammar() -> None:
    _registry, emitter, recorder = bound("monty", emits=["monty.recorded.v1"])

    # The grammar lives in the manifest module and is not re-implemented here, so a
    # malformed kind comes back as that module's refusal.
    with pytest.raises(ManifestError, match="not a well-formed event kind"):
        emitter.emit("Monty.Recorded", {})

    assert recorder.events == []


# --- a kind belongs to the addon whose id namespaces it --------------------------------------


def test_emitting_another_addons_kind_is_refused_naming_both() -> None:
    _registry, emitter, recorder = bound("monty", emits=["monty.recorded.v1"])

    with pytest.raises(UnownedKindError) as refusal:
        emitter.emit("whodunnit.transcribed.v1", {"text": "hello"})

    message = str(refusal.value)
    assert "monty" in message
    assert "whodunnit.transcribed.v1" in message
    assert recorder.events == []


def test_emitting_another_addons_kind_is_refused_even_when_that_addon_registered_it() -> None:
    registry = KindRegistry()
    recorder = Recorder()
    registry.emitter_for(manifest("whodunnit", emits=["whodunnit.transcribed.v1"]), sink=recorder)
    monty = registry.emitter_for(manifest("monty", emits=["monty.recorded.v1"]), sink=recorder)

    # The kind is registered — by its owner. Registration is not permission to forge it.
    assert registry.is_registered("whodunnit.transcribed.v1")
    with pytest.raises(UnownedKindError):
        monty.emit("whodunnit.transcribed.v1", {"text": "hello"})

    assert recorder.events == []


# --- a kind must be registered, and emitting never registers it ------------------------------


def test_an_unregistered_kind_in_the_addons_own_namespace_is_refused() -> None:
    registry, emitter, recorder = bound("monty", emits=["monty.recorded.v1"])

    with pytest.raises(UnregisteredKindError) as refusal:
        emitter.emit("monty.vanished.v1", {"path": "/volumes/dictaphone"})

    message = str(refusal.value)
    assert "monty.vanished.v1" in message
    assert "emits" in message
    assert recorder.events == []


def test_a_refused_kind_is_not_registered_on_the_way_out() -> None:
    registry, emitter, _recorder = bound("monty", emits=["monty.recorded.v1"])

    with pytest.raises(UnregisteredKindError):
        emitter.emit("monty.vanished.v1", {})

    # The follow-up read: a typo that registered itself would turn into a public API that
    # nobody declared, so the registry must look exactly as it did before the attempt.
    assert not registry.is_registered("monty.vanished.v1")
    assert [str(kind) for kind in registry.kinds()] == ["monty.recorded.v1"]

    # And a second attempt is refused just as firmly as the first.
    with pytest.raises(UnregisteredKindError):
        emitter.emit("monty.vanished.v1", {})


# --- payloads are JSON, checked where the call site is still visible --------------------------


def test_a_payload_that_round_trips_through_json_unchanged_is_accepted() -> None:
    _registry, emitter, recorder = bound("monty", emits=["monty.recorded.v1"])
    payload = {
        "path": "/volumes/dictaphone/a.wav",
        "bytes": 4096,
        "seconds": 12.5,
        "lossless": True,
        "device": None,
        "tags": ["meeting", "2026"],
        "meta": {"channels": 2, "notes": []},
    }

    emitter.emit("monty.recorded.v1", payload)

    assert recorder.events[0].payload == payload
    assert json.loads(json.dumps(payload)) == payload


def test_an_empty_payload_is_a_payload() -> None:
    _registry, emitter, recorder = bound("monty", emits=["monty.recorded.v1"])

    emitter.emit("monty.recorded.v1", {})

    assert recorder.events[0].payload == {}


def test_a_set_is_refused_and_the_error_names_the_field() -> None:
    _registry, emitter, recorder = bound("monty", emits=["monty.recorded.v1"])

    with pytest.raises(PayloadError) as refusal:
        emitter.emit("monty.recorded.v1", {"tags": {"meeting", "2026"}})

    message = str(refusal.value)
    assert "'tags'" in message
    assert "set" in message
    assert recorder.events == []


def test_a_datetime_nested_in_a_list_is_refused_and_the_error_names_the_field() -> None:
    _registry, emitter, recorder = bound("monty", emits=["monty.recorded.v1"])

    with pytest.raises(PayloadError) as refusal:
        emitter.emit(
            "monty.recorded.v1",
            {"meta": {"marks": ["start", datetime(2026, 9, 18, tzinfo=UTC)]}},
        )

    message = str(refusal.value)
    # The path, not just the leaf name: a payload can have three fields called `marks`.
    assert "'meta.marks[1]'" in message
    assert "datetime" in message
    assert recorder.events == []


def test_an_open_file_is_refused_and_the_error_names_the_field(tmp_path: Path) -> None:
    _registry, emitter, recorder = bound("monty", emits=["monty.recorded.v1"])
    recording = tmp_path / "a.wav"
    recording.write_bytes(b"RIFF")

    with open(recording, "rb") as handle, pytest.raises(PayloadError) as refusal:
        emitter.emit("monty.recorded.v1", {"audio": handle})

    assert "'audio'" in str(refusal.value)
    assert recorder.events == []


def test_a_tuple_is_refused_because_it_would_arrive_as_something_else() -> None:
    _registry, emitter, recorder = bound("monty", emits=["monty.recorded.v1"])

    # `json.dumps` would take this happily and the subscriber would receive a list. A
    # payload that changes shape in transit is not the payload that was published.
    with pytest.raises(PayloadError) as refusal:
        emitter.emit("monty.recorded.v1", {"tags": ("meeting", "2026")})

    assert "'tags'" in str(refusal.value)
    assert recorder.events == []


def test_a_non_string_key_is_refused() -> None:
    _registry, emitter, recorder = bound("monty", emits=["monty.recorded.v1"])

    with pytest.raises(PayloadError) as refusal:
        emitter.emit("monty.recorded.v1", {"meta": {2: "channels"}})

    message = str(refusal.value)
    assert "'meta'" in message
    assert "2" in message
    assert recorder.events == []


def test_a_number_that_is_not_finite_is_refused() -> None:
    _registry, emitter, recorder = bound("monty", emits=["monty.recorded.v1"])

    # `json.dumps` writes a bare `NaN`, which is not JSON and which no other language on
    # the far side of the boundary is obliged to read.
    with pytest.raises(PayloadError) as refusal:
        emitter.emit("monty.recorded.v1", {"seconds": float("nan")})

    assert "'seconds'" in str(refusal.value)
    assert recorder.events == []


def test_a_payload_that_refers_to_itself_is_refused_rather_than_recursed_into() -> None:
    _registry, emitter, recorder = bound("monty", emits=["monty.recorded.v1"])
    payload: dict[str, object] = {"path": "/tmp/a.wav"}
    payload["meta"] = payload

    # A named refusal, not a RecursionError: the offending call site is the whole point of
    # checking here rather than at the far end of the boundary.
    with pytest.raises(PayloadError) as refusal:
        emitter.emit("monty.recorded.v1", payload)

    assert "'meta'" in str(refusal.value)
    assert recorder.events == []


def test_a_payload_that_is_not_a_mapping_is_refused() -> None:
    _registry, emitter, recorder = bound("monty", emits=["monty.recorded.v1"])

    with pytest.raises(PayloadError) as refusal:
        emitter.emit("monty.recorded.v1", ["not", "an", "object"])  # type: ignore[arg-type]

    assert "mapping" in str(refusal.value)
    assert recorder.events == []


def test_the_payload_is_checked_after_the_kind_so_a_forgery_is_named_as_one() -> None:
    _registry, emitter, _recorder = bound("monty", emits=["monty.recorded.v1"])

    # Both rules are broken. The one reported is the one about who may publish, because
    # fixing the payload would not make this emit legal.
    with pytest.raises(UnownedKindError):
        emitter.emit("whodunnit.transcribed.v1", {"tags": {"meeting"}})


# --- the registry ----------------------------------------------------------------------------


def test_two_addons_may_register_the_same_local_name_without_collision() -> None:
    registry = KindRegistry()
    recorder = Recorder()
    first = registry.emitter_for(manifest("a", emits=["a.done.v1"]), sink=recorder)
    second = registry.emitter_for(manifest("b", emits=["b.done.v1"]), sink=recorder)

    first.emit("a.done.v1", {"who": "a"})
    second.emit("b.done.v1", {"who": "b"})

    assert [str(kind) for kind in registry.kinds()] == ["a.done.v1", "b.done.v1"]
    assert [str(event.kind) for event in recorder.events] == ["a.done.v1", "b.done.v1"]


def test_a_second_version_leaves_the_first_registered_and_emittable() -> None:
    registry = KindRegistry()
    recorder = Recorder()
    registry.emitter_for(manifest("x", version="1.0.0", emits=["x.done.v1"]), sink=recorder)

    # The addon ships a new payload, so it ships a NEW kind. `x.done.v1` is untouched:
    # whoever subscribed to it keeps working, which is the whole reason the version sits
    # inside the kind.
    emitter = registry.emitter_for(
        manifest("x", version="2.0.0", emits=["x.done.v1", "x.done.v2"]), sink=recorder
    )

    emitter.emit("x.done.v1", {"ok": True})
    emitter.emit("x.done.v2", {"ok": True, "detail": "why"})

    assert registry.is_registered("x.done.v1")
    assert [str(kind) for kind in registry.kinds()] == ["x.done.v1", "x.done.v2"]
    assert [str(event.kind) for event in recorder.events] == ["x.done.v1", "x.done.v2"]


def test_registering_the_same_manifest_twice_registers_the_kinds_once() -> None:
    registry = KindRegistry()
    recorder = Recorder()
    document = manifest("monty", emits=["monty.recorded.v1"])

    registry.emitter_for(document, sink=recorder)
    registry.emitter_for(document, sink=recorder)

    assert [str(kind) for kind in registry.kinds()] == ["monty.recorded.v1"]


def test_an_empty_registry_has_no_kinds() -> None:
    registry = KindRegistry()

    assert registry.kinds() == ()
    assert not registry.is_registered("monty.recorded.v1")


def test_an_addon_that_emits_nothing_still_gets_an_emitter() -> None:
    registry, emitter, _recorder = bound("monty")

    # A subscribe-only addon is a normal addon. It just cannot publish anything.
    assert registry.kinds() == ()
    with pytest.raises(UnregisteredKindError):
        emitter.emit("monty.recorded.v1", {})


def test_every_refusal_is_one_error_a_caller_can_catch() -> None:
    _registry, emitter, _recorder = bound("monty", emits=["monty.recorded.v1"])

    for kind, payload in (
        ("whodunnit.transcribed.v1", {}),
        ("monty.vanished.v1", {}),
        ("monty.recorded.v1", {"tags": {"meeting"}}),
    ):
        with pytest.raises(EventError):
            emitter.emit(kind, payload)
