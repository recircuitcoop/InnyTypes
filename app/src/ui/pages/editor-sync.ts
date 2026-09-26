// Keeping the editor's palette in step with the runtime (arch_pivot P11b, WI-0018-12).
//
// A runtime restart leaves the editor's page, and its undeployed edits, alone; only its
// websocket reconnects. After each new runtime generation this compares the editor's node SETS
// with the runtime's and asks the runtime to raise Node-RED's own `node/added` and
// `node/removed` until they match; the events reach the editor only once its websocket is back,
// hence the repeats.
//
// Those events are Node-RED's convention, not an API (P11 §4). If they stop working the palette
// never matches, and 10 s after the runtime is ready: a clean editor is reloaded, which loses
// nothing; a dirty one is not, and the person is asked.
//
// Plain on purpose: the owner will redesign the UI. Tests find everything by `data-testid`.

import type { AppApi, ChildStatus, NodeSetSummary, PaletteChange } from "../contract";
import { attributeOf, escape } from "../view/render";
import type { Region, Section } from "./page";

/** The first check waits for the editor's websocket to reconnect; the rest repeat. */
export const FIRST_CHECK_MS = 500;
export const CHECK_MS = 1_000;
/** How long after the runtime is ready the palette may take to match before the fallback. */
export const FALLBACK_MS = 10_000;

/** A set's identity: its id and its types; a set whose types changed is another set. */
const key = (set: NodeSetSummary): string => `${set.id}\n${[...set.types].sort().join("\n")}`;

/** What the runtime must raise for the editor's node sets to be the runtime's. */
export function paletteChange(
  runtime: readonly NodeSetSummary[],
  editor: readonly NodeSetSummary[],
): PaletteChange {
  const inRuntime = new Set(runtime.map(key));
  const inEditor = new Set(editor.map(key));
  return {
    added: runtime.filter((set) => !inEditor.has(key(set))).map((set) => set.id),
    removed: editor
      .filter((set) => !inRuntime.has(key(set)))
      .map((set) => ({ id: set.id, types: [...set.types] })),
  };
}

export type SyncState = "checking" | "matched" | "reloaded" | "stale" | "kept" | "no-editor";

const SAID: Readonly<Record<SyncState, string>> = {
  checking: "Checking the editor's palette against the runtime.",
  matched: "The editor's palette matches the runtime.",
  reloaded: "The editor was reloaded to pick up the node types that changed.",
  stale:
    "The editor could not pick up the node types that changed, and it has changes that are not deployed.",
  kept: "The editor keeps its changes; its palette may not show the node types that changed.",
  "no-editor": "No editor is loaded.",
};

/** The sync's state in a line: shown under the editor, and read by the e2e gate. */
export function syncHtml(generation: number, state: SyncState, checks: number): string {
  return (
    `<span data-testid="editor-sync" data-generation="${String(generation)}" ` +
    `data-state="${state}" data-checks="${String(checks)}">${escape(SAID[state])}</span>`
  );
}

/** The question the fallback asks when the editor holds undeployed edits. */
export const STALE_PROMPT_HTML =
  '<p data-testid="editor-stale">Reload the editor to see the node types that changed? ' +
  "The changes that are not deployed are then lost.</p>" +
  '<button type="button" data-editor-reload="1" data-testid="editor-reload">Reload the editor</button> ' +
  '<button type="button" data-editor-keep="1" data-testid="editor-keep">Keep editing</button>';

export interface EditorSyncDom {
  /** Where clicks on the prompt are heard. */
  readonly section: Section;
  /** The sync's state line. */
  readonly status: Region;
  /** The fallback's question, empty when there is none. */
  readonly prompt: Region;
  /** Load the editor again from the runtime. */
  readonly reload: () => void;
}

/** Time for the sync: a test moves it by hand. */
export interface SyncTimer {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realTimer: SyncTimer = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/** Mount the sync; the returned function hears the runtime's state. */
export function mountEditorSync(
  dom: EditorSyncDom,
  api: AppApi,
  timer: SyncTimer = realTimer,
): (status: ChildStatus) => void {
  // The generation being synced; a newer one takes the job over.
  let current: number | null = null;

  const draw = (generation: number, state: SyncState, checks: number): void => {
    dom.status.innerHTML = syncHtml(generation, state, checks);
    dom.prompt.innerHTML = state === "stale" ? STALE_PROMPT_HTML : "";
  };

  const sync = async (generation: number): Promise<void> => {
    const readyAt = timer.now();
    draw(generation, "checking", 0);
    for (let check = 1; ; check += 1) {
      await timer.sleep(check === 1 ? FIRST_CHECK_MS : CHECK_MS);
      if (current !== generation) {
        return;
      }
      const palette = await api.editorPalette();
      if (palette !== null) {
        const runtime = await api.runtimeNodeSets();
        if (current !== generation) {
          return;
        }
        if (runtime.ok) {
          const change = paletteChange(runtime.value, palette.sets);
          if (change.added.length === 0 && change.removed.length === 0) {
            draw(generation, "matched", check);
            return;
          }
          await api.raiseNodeEvents(change);
        }
      }
      if (timer.now() - readyAt >= FALLBACK_MS) {
        // An editor that is not loaded will load from this runtime: nothing to fall back from.
        if (palette === null) {
          draw(generation, "no-editor", check);
        } else if (palette.dirty) {
          draw(generation, "stale", check);
        } else {
          dom.reload();
          draw(generation, "reloaded", check);
        }
        return;
      }
    }
  };

  dom.section.on("click", (event) => {
    if (current === null) {
      return;
    }
    if (attributeOf(event.target, "data-editor-reload") !== null) {
      dom.reload();
      draw(current, "reloaded", 0);
    } else if (attributeOf(event.target, "data-editor-keep") !== null) {
      draw(current, "kept", 0);
    }
  });

  return (status) => {
    if (status.state !== "running" || status.generation === current) {
      return;
    }
    current = status.generation;
    void sync(status.generation);
  };
}
