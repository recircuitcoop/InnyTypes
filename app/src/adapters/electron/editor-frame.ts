// The Node-RED editor in the app window's frame, reached from the shell (WI-0018-12).
//
// The app page (inny-app://) and the editor (http://127.0.0.1:<port>/red/) are different
// origins, so the page cannot read the editor's `RED`. The shell can: Electron runs a script in
// any frame of its own windows (WebFrameMain.executeJavaScript). What is read is the editor's
// client registry and `RED.nodes.dirty()`, editor client code (arch_pivot P11 §4), and the only
// thing done is a press of its own Deploy button.

import type { Cancel, Clock } from "../../ports/clock";
import type { EditorPalette, EditorWindow } from "../../ports/editor";

/** A frame of the app window, as far as this adapter uses it (Electron's WebFrameMain). */
export interface ScriptFrame {
  readonly url: string;
  executeJavaScript(code: string): Promise<unknown>;
}

export interface EditorFrameOptions {
  /** Every frame of the app window now; none when the window is closed. */
  readonly frames: () => readonly ScriptFrame[];
  /** The editor's URL on the runtime's stable port; null before the port is known. */
  readonly editorUrl: () => string | null;
  readonly clock: Clock;
  /** How long one script may take before the editor counts as not there. */
  readonly scriptMs?: number;
  /** How long a deploy may take before it counts as not done. */
  readonly deployMs?: number;
  /** How often a deploy is checked on. */
  readonly pollMs?: number;
}

/**
 * The palette as node SETS: the editor keeps a removed type's definition, so its definitions
 * would still list a type the palette no longer offers (arch_pivot P11 surprise 2). An empty
 * node list is an editor still loading.
 */
export const PALETTE_SCRIPT = `(() => {
  const R = window.RED;
  const registry = R && R.nodes && R.nodes.registry;
  if (!registry || typeof R.nodes.dirty !== "function") return null;
  const list = registry.getNodeList();
  if (!Array.isArray(list) || list.length === 0) return null;
  return {
    sets: list.map((set) => ({ id: String(set.id), types: (set.types || []).map(String) })),
    dirty: R.nodes.dirty() === true,
  };
})()`;

/** A press of the editor's own Deploy button: what the person would do. */
export const DEPLOY_SCRIPT = `(() => {
  const button = document.getElementById("red-ui-header-button-deploy");
  if (button === null) return false;
  button.click();
  return true;
})()`;

function isPalette(value: unknown): value is EditorPalette {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { sets, dirty } = value as Record<string, unknown>;
  return typeof dirty === "boolean" && Array.isArray(sets);
}

export class EditorFrame implements EditorWindow {
  readonly #options: EditorFrameOptions;
  readonly #scriptMs: number;
  readonly #deployMs: number;
  readonly #pollMs: number;

  constructor(options: EditorFrameOptions) {
    this.#options = options;
    this.#scriptMs = options.scriptMs ?? 2_000;
    this.#deployMs = options.deployMs ?? 10_000;
    this.#pollMs = options.pollMs ?? 250;
  }

  async palette(): Promise<EditorPalette | null> {
    const answer = await this.#run(PALETTE_SCRIPT);
    return isPalette(answer) ? answer : null;
  }

  async deploy(): Promise<string | null> {
    const before = await this.palette();
    if (before === null) {
      return "The editor is not loaded, so its edits cannot be deployed.";
    }
    if (!before.dirty) {
      return null;
    }
    if ((await this.#run(DEPLOY_SCRIPT)) !== true) {
      return "The editor's Deploy button was not found.";
    }
    const until = this.#options.clock.now() + this.#deployMs;
    while (this.#options.clock.now() < until) {
      await this.#sleep(this.#pollMs);
      const now = await this.palette();
      if (now !== null && !now.dirty) {
        return null;
      }
    }
    return (
      `The deploy did not finish within ${String(this.#deployMs / 1000)} s; ` +
      "the editor says why."
    );
  }

  /** The script's answer in the editor's frame; null with no editor, a failure or a timeout. */
  async #run(script: string): Promise<unknown> {
    const url = this.#options.editorUrl();
    const frame =
      url === null ? undefined : this.#options.frames().find((f) => f.url.startsWith(url));
    if (frame === undefined) {
      return null;
    }
    let cancel: Cancel = () => undefined;
    const timeout = new Promise<null>((resolve) => {
      cancel = this.#options.clock.after(this.#scriptMs, () => {
        resolve(null);
      });
    });
    try {
      return await Promise.race([frame.executeJavaScript(script), timeout]);
    } catch {
      // A frame navigating or gone answers nothing, like no frame at all.
      return null;
    } finally {
      cancel();
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#options.clock.after(ms, resolve);
    });
  }
}
