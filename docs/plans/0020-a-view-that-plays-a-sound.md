---
type: plan
title: A view that plays a sound
status: APPROVED
created: 2026-10-01
updated: 2026-10-02
---

# 0020 — A view that plays a sound

Status: APPROVED 2026-10-02 (owner); scheduled for 0.4.0

**Goal:** a view node can hand the person a short sound to listen to before answering, through the
generic view contract, so that no package needs its own player.

## The observation

The question "Who is speaker 2?" (innyrize) needs a **Listen** button that plays that speaker's
sample. The owner, 2026-10-01: the form "belongs to innyrize module/plugin, NOT InnyTypes.
InnyTypes defines the backend, infrastructure, messaging and VIEWS definitions APIs that innyrize
will use to create the right views." The view contract (node protocol v2 §8.1) renders a fixed
vocabulary; sound is not in it.

## What the code says

- `media` accepts images only: `data:image/(png|jpeg|gif|webp)` URIs or a package-origin
  `.png`/`.svg` file (`app/src/ui/view/render.ts:65`, `mediaHtml`).
- The pop-out CSP (spec §8.5.5) has no `media-src`, so under `default-src 'none'` an `<audio>`
  element loads nothing, even from a package's own `component`.
- A `present` frame is bounded by the node protocol's frame bound of 1 MiB (spec §3). A
  10-second sample as Opus or MP3 is 50–200 KB and fits; a WAV of the same length may not.

## The change

1. **`media` gains audio.** An item `{kind: "audio", src, label?}` where `src` is
   `data:audio/(mpeg|ogg|wav|webm);base64,…` or a package-origin file (`<name>.(mp3|ogg|wav)`
   served from the package's `view/` folder). InnyTypes draws it as a **Listen** control: a
   Secondary button with the `play` icon and the label ("Listen to speaker 2"), which plays once
   and reads "Listening…" while it does. Nothing autoplays.
2. **CSP:** `media-src 'self' data:` is added to the pop-out and inline view page headers. Nothing
   else in the CSP changes; `connect-src` stays `'none'`.
3. **Bound:** an audio item over 768 KiB (leaving room for the rest of the frame under 1 MiB) is
   refused at the runtime with the reason "the sample is too large to show; keep it under
   768 KB", and the view presents without it. A bound is a refusal, never a dropped view.
4. **Design system:** the Listen control is shown in `04 Organisms` (the question pop-out and the
   Question slot show it as package content), and the contract table in
   `docs/ux/design-system.md` names it.
5. **SDKs:** `present(content)` in both SDKs accepts the new item; the conformance suite (spec
   §12.2) gains a case.

## Decisions for the owner

Owner, 2026-10-02: "as recommended" (approve; schedule with 0.4.0). Every decision below is approved as recommended.

- **D1, formats.** Recommended: MP3, Ogg/Opus, WAV, WebM audio. Fewer is simpler; WAV is the
  only one every recorder produces without encoding. **Owner: approved as recommended (2026-10-02).**
- **D2, the bound.** Recommended: 768 KiB per item, one item per view. innyrize encodes a
  10-second Opus sample, about 100 KB. **Owner: approved as recommended (2026-10-02).**
- **D3, controls.** Recommended: play/stop only, no scrubbing, no volume; the system player is
  not shown. **Owner: approved as recommended (2026-10-02).**

## Acceptance

- A `present` with an audio `media` item renders a Listen button in the pop-out and inline, and
  pressing it plays the sample once. Proved by `app/test/e2e/app-pages.e2e.ts` "a view plays a
  sound" (the fixture package's view node sends a 1-second generated tone as `data:audio/wav`).
- An image `media` item still renders as before. Proved by the existing render tests.
- The CSP header of the pop-out page contains `media-src 'self' data:` and nothing else changed.
  Proved by a unit test "the CSP allows media and nothing new".
- An audio item over the bound is refused with the sentence and the view still presents. Proved
  by a unit test "an oversized sample is refused, the view stays".
- Both SDKs accept the item and the conformance suite passes with the new case.
- `docs/loop/verify.sh` exits zero and prints `gate: GREEN`.

## Work items

- `WI-0020-01-media-audio-in-the-contract` (S): spec §8.1 table and schema, `render.ts`, CSP,
  the bound and its sentence, unit tests.
- `WI-0020-02-the-listen-control` (S): the design-system entry, the Penpot organism update, the
  e2e with the fixture package's generated tone. depends_on WI-0020-01.
- `WI-0020-03-sdks-and-conformance` (S): both SDKs, the conformance case. depends_on WI-0020-01.
