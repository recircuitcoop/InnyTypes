// Setup's starter flow (plan 0022 §H, D18, D19): what Setup does to the flow it always installs.
//
// * Installed once, when Setup reaches Source folder: `flow.fromTemplate` with the one template
//   marked `starter`, its id and its step forms then kept in Setup's state, so a quit never
//   installs it twice. The shipped packages (anytype, folder) need no step of their own: they are
//   found beside the app and their types are in the runtime before Setup starts.
// * Source folder: the shell's own folder chooser, and the chosen folder written into the
//   starter's source (its `folder` setting) with `flow.node.configure`.
// * Ready: the flow is switched on, only once its health is Ready.
// * Try with a sample: the bundled 10-second sample copied into the chosen folder, so the folder
//   source passes it on and the run is real. The source leaves alone the files already in the
//   folder the first time it scans it, so the copy waits for that first scan, as the source says
//   it: its own status "watching" (a green dot), which packages/folder shows only once a scan has
//   finished, read through the runtime's `node.status`. The ring "watching" the runtime shows
//   when the process starts comes before any scan, and is not taken for it.
//
// Every flow write is told whether the canvas has unsaved changes, as the page's flow calls are.
import fs from "node:fs";
import * as path from "node:path";
import type { Dialog } from "electron";
import type { Supervisor } from "../application/supervisor";
import type { EditorPresence, EditorWindow } from "../ports/editor";
import type { Logger } from "../ports/logger";
import type { Answer } from "../ui/answer";
import type { FlowNamed, FlowSummary, FlowTemplateEntry, NodeForm } from "../ui/flow-contract";
import type { ChosenFolder } from "../ui/general-contract";
import { STRINGS } from "../ui/strings";
import { refused } from "./answer";
import { canvasState, flowAnswer } from "./flow-calls";

/** The folder source's status once a scan has finished (packages/folder/src/main.ts). */
export const FIRST_SCAN_STATUS = { text: "watching", shape: "dot" } as const;
/** How long Try with a sample waits for the folder source's first scan. */
export const FIRST_SCAN_WAIT_MS = 30_000;
const FIRST_SCAN_POLL_MS = 250;
/** How long a flow write waits for the canvas to finish loading, and how often it asks. */
const CANVAS_LOAD_WAIT_MS = 30_000;
const WRITE_RETRY_MS = 500;

export interface StarterDeps {
  readonly runtime: Pick<Supervisor, "call">;
  readonly editor: EditorWindow & EditorPresence;
  readonly dialog: Pick<Dialog, "showOpenDialog">;
  /** The bundled sample (app/resources/sample/sample-10s.wav, or <resources>/sample/ packaged). */
  readonly sampleFile: string;
  readonly logger: Logger;
  /** A pause; a test passes one that does not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The starter flow, installed: its id and how many step forms it has after its source. */
export interface InstalledStarter {
  readonly flowId: string;
  readonly formCount: number;
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export class SetupStarter {
  readonly #deps: StarterDeps;

  constructor(deps: StarterDeps) {
    this.#deps = deps;
  }

  /** Install the starter template as a new flow (off): its id and form count. */
  async install(): Promise<Answer<InstalledStarter>> {
    const { runtime, logger } = this.#deps;
    const templates = flowAnswer<readonly FlowTemplateEntry[]>(
      await runtime.call("flow.templates", null),
      "setup.starter",
      logger,
    );
    if (!templates.ok) {
      return templates;
    }
    const starter = templates.value.find((template) => template.starter);
    if (starter === undefined) {
      logger.warn("Setup: no template is marked as the starter");
      return refused("no-template", "flows.refused.noTemplate");
    }
    // A flow already made from the starter template is the starter: an install whose answer was
    // lost (a timeout after the runtime made it) is adopted, never made a second time.
    const listed = await this.#flows();
    if (!listed.ok) {
      return listed;
    }
    const existing = listed.value.find((flow) => flow.template === starter.id);
    if (existing !== undefined) {
      logger.info(`Setup adopted the starter flow ${existing.id}, made before`);
      return { ok: true, value: { flowId: existing.id, formCount: existing.steps.length } };
    }
    const made = await this.#write<FlowNamed>("flow.fromTemplate", { templateId: starter.id });
    if (!made.ok) {
      return made;
    }
    const summary = await this.summary(made.value.id);
    if (!summary.ok) {
      return summary;
    }
    logger.info(`Setup installed the starter flow ${made.value.id}`);
    return { ok: true, value: { flowId: made.value.id, formCount: summary.value.steps.length } };
  }

  /** Every flow, as Configuration › Flows lists them. */
  async #flows(): Promise<Answer<readonly FlowSummary[]>> {
    const { runtime, logger } = this.#deps;
    return flowAnswer<readonly FlowSummary[]>(
      await runtime.call("flow.list", null),
      "setup.starter",
      logger,
    );
  }

  /** The starter's row of Configuration › Flows; `gone` when it is not there. */
  async summary(flowId: string): Promise<Answer<FlowSummary>> {
    const listed = await this.#flows();
    if (!listed.ok) {
      return listed;
    }
    const flow = listed.value.find((each) => each.id === flowId);
    return flow === undefined ? refused("gone", "flows.refused.gone") : { ok: true, value: flow };
  }

  /** "Choose a folder…": the shell's chooser, and the folder written into the starter's source. */
  async chooseFolder(flowId: string): Promise<Answer<ChosenFolder>> {
    const { dialog } = this.#deps;
    const summary = await this.summary(flowId);
    if (!summary.ok) {
      return summary;
    }
    const source = summary.value.sources[0];
    if (source === undefined) {
      return refused("no-step", "flows.refused.noStep");
    }
    const chosen = await dialog.showOpenDialog({
      title: STRINGS["setup.folder.title"],
      properties: ["openDirectory", "createDirectory"],
    });
    const folder = chosen.canceled ? null : (chosen.filePaths[0] ?? null);
    if (folder === null) {
      return { ok: true, value: { folder: null } };
    }
    const configured = await this.#write<unknown>("flow.node.configure", {
      flowId,
      nodeId: source.id,
      values: { folder },
    });
    return configured.ok ? { ok: true, value: { folder } } : configured;
  }

  /** Switch the starter on, once its health is Ready; whether it is on now. */
  async switchOnWhenReady(flowId: string): Promise<boolean> {
    const { logger } = this.#deps;
    const summary = await this.summary(flowId);
    if (!summary.ok) {
      return false;
    }
    if (summary.value.on) {
      return true;
    }
    if (summary.value.health.kind !== "ready") {
      logger.info(`Setup leaves the starter flow off: it is not set up (${flowId})`);
      return false;
    }
    const switched = await this.#write<unknown>("flow.setOn", { id: flowId, on: true });
    return switched.ok;
  }

  /**
   * A flow write, told whether the canvas has unsaved changes as the page's flow calls are. The
   * canvas cannot be reached during Setup, so a canvas still loading has no edits of the
   * person's: the write is asked again until it has loaded, rather than refused to them.
   */
  async #write<T>(
    op: "flow.fromTemplate" | "flow.node.configure" | "flow.setOn",
    args: Readonly<Record<string, unknown>>,
  ): Promise<Answer<T>> {
    const { runtime, editor, logger } = this.#deps;
    const sleep = this.#deps.sleep ?? realSleep;
    for (let waited = 0; ; waited += WRITE_RETRY_MS) {
      const told = { ...args, ...(await canvasState(editor)) };
      const answer = flowAnswer<T>(await runtime.call(op, told), `setup ${op}`, logger);
      if (answer.ok || answer.refused.reason !== "loading" || waited >= CANVAS_LOAD_WAIT_MS) {
        return answer;
      }
      await sleep(WRITE_RETRY_MS);
    }
  }

  /** Try with a sample: the sample copied into the starter's folder once its source scanned it. */
  async trySample(flowId: string): Promise<Answer<null>> {
    const { runtime, logger } = this.#deps;
    const summary = await this.summary(flowId);
    if (!summary.ok) {
      return summary;
    }
    const source = summary.value.sources[0];
    if (source === undefined) {
      return refused("no-step", "flows.refused.noStep");
    }
    const form = flowAnswer<NodeForm>(
      await runtime.call("flow.node.form", { flowId, nodeId: source.id }),
      "setup.trySample",
      logger,
    );
    if (!form.ok) {
      return form;
    }
    const folder = form.value.values["folder"];
    if (typeof folder !== "string" || folder === "") {
      logger.warn("Setup: Try with a sample, but the starter has no folder");
      return refused("failed", "refused.failed");
    }
    if (!(await this.switchOnWhenReady(flowId))) {
      return refused("failed", "refused.failed");
    }
    if (!(await this.#firstScanDone(source.id))) {
      logger.warn("Setup: the folder source has not scanned its folder yet; no sample copied");
      return refused("failed", "refused.failed");
    }
    const copied = copySample(this.#deps.sampleFile, folder);
    logger.info(`Setup copied the sample into the starter's folder as ${copied}`);
    return { ok: true, value: null };
  }

  /** Whether the folder source has said it scanned its folder, within FIRST_SCAN_WAIT_MS. */
  async #firstScanDone(nodeId: string): Promise<boolean> {
    const { runtime } = this.#deps;
    const sleep = this.#deps.sleep ?? realSleep;
    for (let waited = 0; waited <= FIRST_SCAN_WAIT_MS; waited += FIRST_SCAN_POLL_MS) {
      const answer = await runtime.call("node.status", { nodeId });
      if (answer.ok && scanned(answer.value)) {
        return true;
      }
      await sleep(FIRST_SCAN_POLL_MS);
    }
    return false;
  }
}

/** Whether a `node.status` answer is the folder source's status after a scan. */
function scanned(value: unknown): boolean {
  const status = (value as { status?: { text?: unknown; shape?: unknown } | null } | null)?.status;
  return status?.text === FIRST_SCAN_STATUS.text && status.shape === FIRST_SCAN_STATUS.shape;
}

/**
 * Copy the sample into `folder` under a name not taken there ("sample-10s.wav", then
 * "sample-10s 2.wav", …), never over a file of the person's own; the name it was given.
 */
export function copySample(sampleFile: string, folder: string): string {
  const extension = path.extname(sampleFile);
  const stem = path.basename(sampleFile, extension);
  for (let copy = 1; ; copy += 1) {
    const name = copy === 1 ? `${stem}${extension}` : `${stem} ${String(copy)}${extension}`;
    try {
      fs.copyFileSync(sampleFile, path.join(folder, name), fs.constants.COPYFILE_EXCL);
      return name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
}
