"""Dependency resolution — what the host starts, in what order, and what it holds back.

Discovery says what is installed; this module says what can actually run. It is handed
parsed manifests and hands back a :class:`StartPlan`. It reads no disk, re-parses nothing
and — like every host module — imports no addon.

Three choices here are load-bearing:

**A cycle is refused; degradation is not.** They look alike (neither addon starts) and they
are opposites. A missing requirement is a fact about *this machine* — one addon is not
installed — so the host reports it and starts everything else. A cycle is a fact about the
addons themselves: no start order exists at all, for anybody, and no amount of installing
fixes it. So a cycle raises, naming the addons in it, and returns no partial order to be
half-acted on. The whole algorithm is iterative for the same reason: a deep or long cycle
must come back as a sentence, never as a ``RecursionError`` (plan 0001).

**`subscribes` implies an edge; it does not imply a requirement.** If an addon subscribes to
kinds another addon owns, the publisher starts first — derived here, so the author does not
declare the same relationship twice in ``requires``. But a subscription that cannot be
served is a quiet inbox, not a failure: a subscriber whose publisher is missing or held back
still starts. Only ``requires`` is a hard dependency, because only ``requires`` pins a
version, and only a version pin says "I was written against that API".

**Held back is reported, never raised.** A missing or version-mismatched requirement takes
that addon — and whatever requires it — out of the start order, carrying a reason that names
the root cause, while every unaffected addon starts (plan 0001: degradation is the designed
behaviour, not an error path that happens to work).

This slice computes the plan. Launching anything is slice 07.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from innytypes.addons.manifest import AddonManifest, EventKind, KindPrefix

__all__ = [
    "DependencyCycleError",
    "HeldBackAddon",
    "ResolutionError",
    "StartPlan",
    "dependency_edges",
    "resolve_start_order",
]


class ResolutionError(ValueError):
    """Raised when no start order exists for the addons as written."""


class DependencyCycleError(ResolutionError):
    """Raised when addons depend on each other in a loop.

    ``cycle`` is the loop itself in "depends on" order — ``('monty', 'whodunnit')`` means
    monty depends on whodunnit depends on monty — rotated to start at its lowest id so two
    runs report one cycle the same way.
    """

    def __init__(self, cycle: Sequence[str]) -> None:
        self.cycle = tuple(cycle)
        chain = " depends on ".join([*self.cycle, self.cycle[0]])
        super().__init__(
            f"dependency cycle between {', '.join(sorted(self.cycle))}: {chain}. "
            "No start order exists; break the loop in one of these manifests."
        )


@dataclass(frozen=True)
class HeldBackAddon:
    """One addon that will not be started, and why.

    ``reason`` names the root cause even when this addon is only a casualty of it, because
    the person reading it has to know which addon to go and install.
    """

    id: str
    reason: str


@dataclass(frozen=True)
class StartPlan:
    """The decision: ``order`` is started, front to back; ``held_back`` is not started.

    Both travel together, so a caller can report what runs and what does not in one breath
    and can never be handed a silently shortened list.
    """

    order: tuple[str, ...]
    held_back: tuple[HeldBackAddon, ...]


def resolve_start_order(manifests: Sequence[AddonManifest]) -> StartPlan:
    """Decide what starts and in what order, given every discovered addon's manifest.

    Raises :class:`DependencyCycleError` if the addons depend on each other in a loop. Every
    other problem degrades: the affected addons come back in ``held_back`` with a reason, and
    the rest come back in ``order``.
    """
    by_id = {manifest.id: manifest for manifest in manifests}

    # Cycles are settled first, over every addon: a loop is refused whether or not the
    # addons in it would have been held back anyway.
    order = _topological_order(dependency_edges(by_id))

    held_back: dict[str, str] = {}
    startable: list[str] = []

    # `order` puts every dependency before its dependents, so one pass is enough to carry a
    # reason from the addon that is missing something down to everything that needs it.
    for addon_id in order:
        reason = _hold_back_reason(by_id[addon_id], by_id=by_id, held_back=held_back)
        if reason is None:
            startable.append(addon_id)
        else:
            held_back[addon_id] = reason

    return StartPlan(
        order=tuple(startable),
        held_back=tuple(
            HeldBackAddon(id=addon_id, reason=reason)
            for addon_id, reason in sorted(held_back.items())
        ),
    )


def dependency_edges(by_id: Mapping[str, AddonManifest]) -> dict[str, tuple[str, ...]]:
    """For each addon, the installed addons that must start before it.

    Public because it is the one definition of *depends on* in this project, and a second one
    would eventually disagree with the start order. Plan 0003 slice 13 reads it to decide
    which plugins an update has to stop: whatever starts after a changed plugin is restarted
    with it, and everything else keeps running.

    Requirements naming an addon that is not installed are deliberately absent here: they
    are not edges in a graph, they are the degradation :func:`_hold_back_reason` reports.
    An addon pointing at itself is skipped rather than made a loop of one — an addon that
    subscribes to its own kinds, or pins its own version, is still one process started once.
    """
    edges: dict[str, tuple[str, ...]] = {}

    for addon_id, manifest in by_id.items():
        before: set[str] = set()

        for requirement in manifest.requires:
            if requirement.addon_id in by_id and requirement.addon_id != addon_id:
                before.add(requirement.addon_id)

        for subscription in manifest.subscribes:
            publisher = _publisher_of(subscription)
            if publisher in by_id and publisher != addon_id:
                before.add(publisher)

        edges[addon_id] = tuple(sorted(before))

    return edges


def _publisher_of(subscription: EventKind | KindPrefix) -> str:
    """Which addon owns the kinds a subscription asks for.

    The grammar does the work: a kind is ``<addon-id>.<name>.v<N>`` and a prefix is a
    dotted-segment head, so the owning addon is the leading segment of either. That holds
    for `monty.recorded.v1`, `monty.recorded.*` and `monty.*` alike, and it does not depend
    on the publisher's ``emits`` being complete — the namespace is the ownership.
    """
    if isinstance(subscription, EventKind):
        return subscription.addon_id
    return subscription.prefix.split(".", 1)[0]


def _topological_order(edges: dict[str, tuple[str, ...]]) -> tuple[str, ...]:
    """Every addon, dependencies first, ties broken by id. Refuses a cycle by name.

    Kahn's algorithm, chosen over a depth-first walk because it is iterative: a cycle a
    thousand addons long has to come back as a sentence rather than as a stack overflow.
    """
    # How many un-started dependencies each addon still has, and who is waiting on it.
    outstanding = {addon_id: len(dependencies) for addon_id, dependencies in edges.items()}
    dependents: dict[str, list[str]] = {addon_id: [] for addon_id in edges}
    for addon_id, dependencies in edges.items():
        for dependency in dependencies:
            dependents[dependency].append(addon_id)

    # Sorted rather than a plain queue: with nothing to separate two addons, the id does,
    # so two runs over the same addons cannot disagree about the order.
    ready = sorted(addon_id for addon_id, count in outstanding.items() if count == 0)
    order: list[str] = []

    while ready:
        addon_id = ready.pop(0)
        order.append(addon_id)

        released = []
        for dependent in dependents[addon_id]:
            outstanding[dependent] -= 1
            if outstanding[dependent] == 0:
                released.append(dependent)

        if released:
            ready = sorted([*ready, *released])

    if len(order) < len(edges):
        # Whatever is left has no dependency-free addon in it, which is exactly what a
        # cycle is. Name it.
        remaining = {addon_id for addon_id in edges if outstanding[addon_id] > 0}
        raise DependencyCycleError(_find_cycle(edges, remaining))

    return tuple(order)


def _find_cycle(edges: dict[str, tuple[str, ...]], remaining: set[str]) -> tuple[str, ...]:
    """One cycle from the addons Kahn's algorithm could not order.

    Every remaining addon depends on another remaining addon, so following dependencies
    must revisit somebody: the walk between the two visits is a cycle. Iterative, and it
    always takes the lowest-numbered id, so the same tangle reports the same loop twice.
    """
    seen_at: dict[str, int] = {}
    walk: list[str] = []
    addon_id = min(remaining)

    while addon_id not in seen_at:
        seen_at[addon_id] = len(walk)
        walk.append(addon_id)
        addon_id = min(dependency for dependency in edges[addon_id] if dependency in remaining)

    cycle = walk[seen_at[addon_id] :]

    # Rotate to start at the lowest id in the loop: the walk's entry point depends on where
    # it began, and the cycle reported should not.
    start = cycle.index(min(cycle))
    return tuple(cycle[start:] + cycle[:start])


def _hold_back_reason(
    manifest: AddonManifest,
    *,
    by_id: dict[str, AddonManifest],
    held_back: dict[str, str],
) -> str | None:
    """Why this addon will not start, or ``None`` if it will.

    The first unsatisfied requirement is the one reported, as everywhere else in the host:
    one broken rule, named, rather than a list format nothing else prints.
    """
    for requirement in manifest.requires:
        installed = by_id.get(requirement.addon_id)

        if installed is None:
            return f"requires {requirement}, which is not installed"

        if installed.version != requirement.version:
            return (
                f"requires {requirement}, but {requirement.addon_id} "
                f"{installed.version} is installed"
            )

        # The requirement is installed at the right version and is still not starting, so
        # neither is this addon. Carrying the reason forward is what puts the root cause in
        # front of whoever reads the message.
        if requirement.addon_id in held_back:
            return (
                f"requires {requirement.addon_id}, which is not starting: "
                f"{held_back[requirement.addon_id]}"
            )

    return None
