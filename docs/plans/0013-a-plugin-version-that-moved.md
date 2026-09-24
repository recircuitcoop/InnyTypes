---
type: plan
title: A plugin version that moved, and nobody said so
status: APPROVED
created: 2026-09-24
updated: 2026-09-24
---

# 0013 — A plugin version that moved, and nobody said so

## The observation

monty's source changed on 2026-09-23 — three commits adding a new event kind and its behaviour.
The installed copy stayed at the 2026-09-19 build. The application ran for days against the old
one, and:

- the helper never noticed the installed plugin and its source had diverged;
- **the plugin management section of the window showed no "update available" message**, or any
  other sign that the installed copy was behind;
- the divergence surfaced only when a person asked why a feature did not work, and a trace found
  the recorded manifest and the installed package both predating the feature.

The owner's words: *the version of monty moved silently and the helper did not verify that it had.*

## Why this is a plan rather than a bug report

Plan 0003 already built the pieces this seems to need — `WI-0003-12` plugin version check,
`WI-0003-13` plugin update apply, `WI-0003-14` user notification — and all three are marked done.
So either they do not cover this case, or they cover it and something is not assembled. That
question has to be answered before anything is built, and it is the first slice's work.

**A specific hypothesis to test first, not to assume:** monty is installed from a local path
(`source.json` records `"editable": false` with a filesystem path). A version check written
against a published catalogue or a tagged release has nothing to compare a path install to — the
"upstream" is a directory on the same machine. If that is the answer, the gap is not a broken
check but a kind of install the check was never given a rule for, and the fix is a rule rather
than a repair.

The second candidate, and the shape this repository keeps producing: the check exists, is tested,
and is never called by the running application. Four defects this year were exactly that. Look for
the caller before concluding the logic is wrong.

## What the plan must establish before it designs anything

- What the existing plugin version check actually compares, for each kind of install this
  application supports — a catalogue entry, a tag, a path.
- Whether it runs in the shipped application at all, and on what cadence.
- What the window is supposed to show when a plugin is behind, and whether that path has ever
  been exercised outside a test.
- Whether "behind" is even well defined for a path install whose source is edited in place: a
  directory has no version until something reads its manifest, and its declared version may not
  change when its behaviour does. **monty's declared version did not move when its manifest gained
  a new event kind**, which means a version-number comparison would have said "up to date" and
  been wrong. Whatever is built has to answer that, or it repeats this failure with more
  machinery.

## Sketch of the outcome, to be confirmed by the above

A person looking at the plugin management section can tell, without leaving the application,
whether what is installed is what the source says it should be — and is told when it is not,
rather than discovering it through a feature that quietly does nothing.

## Non-goals

- automatic updating of a path-installed plugin: noticing and saying so is this plan's job, and
  applying an update already has a slice of its own;
- changing the event or manifest vocabulary;
- a version scheme for plugins that edit in place, unless the investigation shows nothing smaller
  can work.

## Status

Seeded from the owner's observation on 2026-09-24, deliberately not started. No work items yet:
the first slice is an investigation whose findings decide what the others are.
