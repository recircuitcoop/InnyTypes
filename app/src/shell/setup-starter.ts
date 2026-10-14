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
//   folder the first time it scans it, so the copy waits for that first scan: the source writes
//   down what it has seen (`seen.json` in its instance's data folder) once it has scanned.
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

/** The folder source's record of what it has seen (packages/folder/src/watcher.ts SEEN_FILE). */
const SEEN_FILE = "seen.json";
/** How long Try with a sample waits for the folder source's first scan. */
export const FIRST_SCAN_WAIT_MS = 30_000;
const FIRST_SCAN_POLL_MS = 250;

export interface StarterDeps {
  readonly runtime: Pick<Supervisor, "call">;
  readonly editor: EditorWindow & EditorPresence;
  readonly dialog: Pick<Dialog, "showOpenDialog">;
  /** The bundled sample (app/resources/sample/sample-10s.wav, or <resources>/sample/ packaged). */
  readonly sampleFile: string;
  /** Where the runtime keeps each node instance's data folder (userData/instances). */
  readonly instancesDir: string;
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
    const { runtime, editor, logger } = this.#deps;
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
    const told = { templateId: starter.id, ...(await canvasState(editor)) };
    const made = flowAnswer<FlowNamed>(
      await runtime.call("flow.fromTemplate", told),
      "setup.starter",
      logger,
    );
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

  /** The starter's row of Configuration › Flows; `gone` when it is not there. */
  async summary(flowId: string): Promise<Answer<FlowSummary>> {
    const { runtime, logger } = this.#deps;
    const listed = flowAnswer<readonly FlowSummary[]>(
      await runtime.call("flow.list", null),
      "setup.starter",
      logger,
    );
    if (!listed.ok) {
      return listed;
    }
    const flow = listed.value.find((each) => each.id === flowId);
    return flow === undefined
      ? refused("gone", "flows.refused.gone")
      : { ok: true, value: flow };
  }

  /** "Choose a folder…": the shell's chooser, and the folder written into the starter's source. */
  async chooseFolder(flowId: string): Promise<Answer<ChosenFolder>> {
    const { runtime, editor, dialog, logger } = this.#deps;
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
    const told = {
      flowId,
      nodeId: source.id,
      values: { folder },
      ...(await canvasState(editor)),
    };
    const configured = flowAnswer<unknown>(
      await runtime.call("flow.node.configure", told),
      "setup.chooseFolder",
      logger,
    );
    return configured.ok ? { ok: true, value: { folder } } : configured;
  }

  /** Switch the starter on, once its health is Ready; whether it is on now. */
  async switchOnWhenReady(flowId: string): Promise<boolean> {
    const { runtime, editor, logger } = this.#deps;
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
    const told = { id: flowId, on: true, ...(await canvasState(editor)) };
    const switched = flowAnswer<unknown>(await runtime.call("flow.setOn", told), "setup", logger);
    return switched.ok;
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
    if (!(await this.#firstScanDone(source.id, folder))) {
      logger.warn("Setup: the folder source has not scanned its folder yet; no sample copied");
      return refused("failed", "refused.failed");
    }
    const copied = copySample(this.#deps.sampleFile, folder);
    logger.info(`Setup copied the sample into the starter's folder as ${copied}`);
    return { ok: true, value: null };
  }

  /** Whether the folder source has scanned `folder` once: its record names that folder. */
  async #firstScanDone(nodeId: string, folder: string): Promise<boolean> {
    const sleep = this.#deps.sleep ?? realSleep;
    const record = path.join(this.#deps.instancesDir, nodeId, SEEN_FILE);
    for (let waited = 0; waited <= FIRST_SCAN_WAIT_MS; waited += FIRST_SCAN_POLL_MS) {
      if (recordNames(record, folder)) {
        return true;
      }
      await sleep(FIRST_SCAN_POLL_MS);
    }
    return false;
  }
}

/** Whether the source's record is there and is of `folder`. */
function recordNames(record: string, folder: string): boolean {
  try {
    const document = JSON.parse(fs.readFileSync(record, "utf8")) as { folder?: unknown };
    return document.folder === folder;
  } catch {
    // Not written yet, or half written: not scanned yet.
    return false;
  }
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
