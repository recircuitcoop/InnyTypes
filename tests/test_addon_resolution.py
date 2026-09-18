"""Dependency resolution: what starts, in what order, and what quietly does not.

Two behaviours carry this slice, and both are the kind that is easiest to "pass" by not
implementing them:

* **A cycle is refused by name.** A resolver that hangs or blows the stack also never
  returns a wrong order, so every cycle test asserts the names in the message.
* **A missing requirement degrades.** Each degradation test asserts *both* halves — the
  addon that is held back, and the addons that start anyway — because a resolver that
  simply drops everything on the floor satisfies half of that sentence.

Every manifest below is built by `manifest()`, which runs the real
`innytypes.addons.manifest.parse_manifest`. Nothing here reads a disk, and nothing
re-parses or re-discovers: the resolver is handed parsed manifests, which is exactly what
discovery hands it.
"""

from __future__ import annotations

from collections.abc import Sequence

import pytest

from innytypes import HOST_API_VERSION
from innytypes.addons.manifest import AddonManifest, parse_manifest
from innytypes.addons.resolution import (
    DependencyCycleError,
    HeldBackAddon,
    ResolutionError,
    StartPlan,
    resolve_start_order,
)


def manifest(
    addon_id: str,
    *,
    version: str = "1.0.0",
    requires: Sequence[str] = (),
    emits: Sequence[str] = (),
    subscribes: Sequence[str] = (),
) -> AddonManifest:
    """One parsed manifest, so no test invents a shape the grammar would refuse."""
    return parse_manifest(
        {
            "id": addon_id,
            "version": version,
            "host_api": HOST_API_VERSION,
            "requires": list(requires),
            "emits": list(emits),
            "subscribes": list(subscribes),
        }
    )


def reasons(plan: StartPlan) -> dict[str, str]:
    """The held-back addons as `{id: reason}`, for tests that assert on the reason."""
    return {addon.id: addon.reason for addon in plan.held_back}


# --- the order requirements impose --------------------------------------------------------


def test_a_chain_of_requirements_starts_dependencies_first() -> None:
    # Alphabetically this is monty, summarize, whodunnit — so an order that merely sorts
    # the ids passes nothing here.
    plan = resolve_start_order(
        [
            manifest("summarize", requires=["whodunnit==1.0.0"]),
            manifest("whodunnit", requires=["monty==1.0.0"]),
            manifest("monty"),
        ]
    )

    assert plan.order == ("monty", "whodunnit", "summarize")
    assert plan.held_back == ()


def test_independent_addons_come_back_in_one_stable_order() -> None:
    manifests = [manifest("summarize"), manifest("monty"), manifest("whodunnit")]

    first = resolve_start_order(manifests)
    second = resolve_start_order(list(reversed(manifests)))

    # Nothing constrains these three, so the tie is broken by id — and broken the same way
    # whatever order discovery happened to walk the directory in.
    assert first.order == ("monty", "summarize", "whodunnit")
    assert second.order == first.order


def test_an_addon_waits_for_every_one_of_its_requirements() -> None:
    plan = resolve_start_order(
        [
            manifest("monty"),
            manifest("whodunnit", requires=["monty==1.0.0"]),
            # Two requirements: satisfying the first must not release it early.
            manifest("summarize", requires=["monty==1.0.0", "whodunnit==1.0.0"]),
            manifest("sidecar", requires=["monty==1.0.0"]),
        ]
    )

    assert plan.order == ("monty", "sidecar", "whodunnit", "summarize")


def test_nothing_installed_is_an_empty_plan_rather_than_an_error() -> None:
    plan = resolve_start_order([])

    assert plan == StartPlan(order=(), held_back=())


# --- the order a subscription implies -----------------------------------------------------


def test_a_subscriber_starts_after_the_publisher_it_subscribes_to() -> None:
    plan = resolve_start_order(
        [
            # `requires` is empty on purpose: the edge exists because of `subscribes` alone,
            # so the author never declares the same relationship twice.
            manifest("summarize", subscribes=["whodunnit.transcribed.v1"]),
            manifest("whodunnit", emits=["whodunnit.transcribed.v1"]),
        ]
    )

    assert plan.order == ("whodunnit", "summarize")
    assert plan.held_back == ()


def test_a_prefix_subscription_implies_the_same_edge() -> None:
    plan = resolve_start_order(
        [
            manifest("summarize", subscribes=["whodunnit.*"]),
            manifest("whodunnit", emits=["whodunnit.transcribed.v1"]),
        ]
    )

    assert plan.order == ("whodunnit", "summarize")


def test_a_versioned_prefix_subscription_implies_the_same_edge() -> None:
    plan = resolve_start_order(
        [
            manifest("summarize", subscribes=["whodunnit.transcribed.*"]),
            manifest("whodunnit", emits=["whodunnit.transcribed.v1"]),
        ]
    )

    assert plan.order == ("whodunnit", "summarize")


def test_subscribing_to_an_absent_publisher_is_not_a_requirement() -> None:
    # Subscribing is not requiring. Nothing publishes `monty.*`, so the subscriber receives
    # nothing — and starts, because the bus having nothing to deliver is not a failure.
    plan = resolve_start_order([manifest("summarize", subscribes=["monty.*"])])

    assert plan.order == ("summarize",)
    assert plan.held_back == ()


def test_an_addon_may_subscribe_to_its_own_kinds() -> None:
    plan = resolve_start_order(
        [manifest("monty", emits=["monty.recorded.v1"], subscribes=["monty.recorded.v1"])]
    )

    # An addon listening to itself is not a cycle; it is one process, started once.
    assert plan.order == ("monty",)


# --- cycles are refused, by name ----------------------------------------------------------


def test_a_cycle_of_requirements_is_refused_and_names_both_addons() -> None:
    manifests = [
        manifest("monty", requires=["whodunnit==1.0.0"]),
        manifest("whodunnit", requires=["monty==1.0.0"]),
    ]

    with pytest.raises(DependencyCycleError) as raised:
        resolve_start_order(manifests)

    assert set(raised.value.cycle) == {"monty", "whodunnit"}
    message = str(raised.value)
    assert "monty" in message
    assert "whodunnit" in message
    # Refused outright: there is no half-answer to fish a partial order out of.
    assert isinstance(raised.value, ResolutionError)


def test_a_cycle_closed_by_a_subscription_is_refused_too() -> None:
    # `requires` alone is acyclic here. The cycle exists only because the implied edge from
    # `subscribes` is real, so this is the test that stops that edge being cosmetic.
    manifests = [
        manifest("monty", emits=["monty.recorded.v1"], subscribes=["whodunnit.transcribed.v1"]),
        manifest(
            "whodunnit",
            requires=["monty==1.0.0"],
            emits=["whodunnit.transcribed.v1"],
        ),
    ]

    with pytest.raises(DependencyCycleError) as raised:
        resolve_start_order(manifests)

    assert set(raised.value.cycle) == {"monty", "whodunnit"}


def test_a_longer_cycle_names_every_addon_in_it() -> None:
    manifests = [
        manifest("monty", requires=["summarize==1.0.0"]),
        manifest("whodunnit", requires=["monty==1.0.0"]),
        manifest("summarize", requires=["whodunnit==1.0.0"]),
    ]

    with pytest.raises(DependencyCycleError) as raised:
        resolve_start_order(manifests)

    assert set(raised.value.cycle) == {"monty", "summarize", "whodunnit"}


def test_a_cycle_is_refused_even_when_unrelated_addons_could_have_started() -> None:
    manifests = [
        manifest("monty", requires=["whodunnit==1.0.0"]),
        manifest("whodunnit", requires=["monty==1.0.0"]),
        manifest("sidecar"),
    ]

    # A cycle is a configuration error, not a degradation: the host refuses the whole plan
    # rather than starting most of it and hoping.
    with pytest.raises(DependencyCycleError):
        resolve_start_order(manifests)


def test_a_cycle_is_reported_rather_than_recursed_through() -> None:
    # A long cycle is where a naive depth-first resolver dies with a RecursionError instead
    # of a sentence a human can act on.
    length = 2000
    manifests = [
        manifest(f"addon-{index}", requires=[f"addon-{(index + 1) % length}==1.0.0"])
        for index in range(length)
    ]

    with pytest.raises(DependencyCycleError) as raised:
        resolve_start_order(manifests)

    assert len(raised.value.cycle) == length


def test_a_long_chain_is_ordered_rather_than_recursed_through() -> None:
    length = 2000
    manifests = [manifest("addon-0")] + [
        manifest(f"addon-{index}", requires=[f"addon-{index - 1}==1.0.0"])
        for index in range(1, length)
    ]

    plan = resolve_start_order(manifests)

    assert plan.order[0] == "addon-0"
    assert len(plan.order) == length


# --- degradation: what is missing, and what starts anyway ---------------------------------


def test_a_missing_requirement_holds_back_that_addon_and_only_that_addon() -> None:
    plan = resolve_start_order(
        [
            manifest("whodunnit", requires=["monty==1.4.0"]),
            manifest("summarize"),
            manifest("sidecar"),
        ]
    )

    # Half one: the addon whose requirement is absent does not start, and the host says
    # exactly what is missing.
    assert plan.held_back == (
        HeldBackAddon(
            id="whodunnit",
            reason="requires monty==1.4.0, which is not installed",
        ),
    )
    # Half two: everything that did not depend on it starts regardless.
    assert plan.order == ("sidecar", "summarize")


def test_a_requirement_at_another_version_reports_the_required_and_the_found_version() -> None:
    plan = resolve_start_order(
        [
            manifest("whodunnit", requires=["monty==1.4.0"]),
            manifest("monty", version="1.2.0"),
        ]
    )

    reason = reasons(plan)["whodunnit"]
    assert "1.4.0" in reason
    assert "1.2.0" in reason
    # The addon that is there at the wrong version is itself fine, and starts.
    assert plan.order == ("monty",)


def test_a_dependent_of_a_held_back_addon_is_held_back_and_names_the_root_cause() -> None:
    plan = resolve_start_order(
        [
            manifest("whodunnit", requires=["monty==1.4.0"]),
            manifest("summarize", requires=["whodunnit==1.0.0"]),
            manifest("sidecar"),
        ]
    )

    summarize_reason = reasons(plan)["summarize"]
    assert "whodunnit" in summarize_reason
    # The root cause travels with the symptom: whoever reads this learns to install monty,
    # not to stare at summarize.
    assert "monty==1.4.0" in summarize_reason
    # An unrelated sibling of the dependent is untouched.
    assert plan.order == ("sidecar",)


def test_a_subscriber_of_a_held_back_publisher_still_starts() -> None:
    plan = resolve_start_order(
        [
            manifest("whodunnit", requires=["monty==1.4.0"], emits=["whodunnit.transcribed.v1"]),
            manifest("summarize", subscribes=["whodunnit.*"]),
        ]
    )

    # Subscribing is not requiring. `summarize` asked to be told about events that will not
    # arrive; that is a quiet inbox, not a reason to hold a working addon back.
    assert plan.order == ("summarize",)
    assert [addon.id for addon in plan.held_back] == ["whodunnit"]


def test_held_back_addons_come_back_in_one_stable_order() -> None:
    manifests = [
        manifest("whodunnit", requires=["monty==1.4.0"]),
        manifest("summarize", requires=["monty==1.4.0"]),
        manifest("sidecar", requires=["monty==1.4.0"]),
    ]

    plan = resolve_start_order(manifests)
    again = resolve_start_order(list(reversed(manifests)))

    assert [addon.id for addon in plan.held_back] == ["sidecar", "summarize", "whodunnit"]
    assert again.held_back == plan.held_back


def test_the_first_unsatisfied_requirement_is_the_one_reported() -> None:
    plan = resolve_start_order(
        [manifest("whodunnit", requires=["monty==1.4.0", "summarize==2.0.0"])]
    )

    # Both are missing; the message names the first rather than inventing a list format
    # nobody else in the host uses.
    assert reasons(plan)["whodunnit"] == "requires monty==1.4.0, which is not installed"


def test_an_addon_requiring_itself_at_its_own_version_is_satisfied() -> None:
    # Silly, but it is not a cycle and it is not unsatisfied: the addon is installed, at
    # exactly that version. Refusing it would be a rule nobody wrote down.
    plan = resolve_start_order([manifest("monty", version="1.0.0", requires=["monty==1.0.0"])])

    assert plan.order == ("monty",)


def test_an_addon_requiring_itself_at_another_version_is_held_back() -> None:
    plan = resolve_start_order([manifest("monty", version="1.0.0", requires=["monty==2.0.0"])])

    assert plan.order == ()
    assert "2.0.0" in reasons(plan)["monty"]
