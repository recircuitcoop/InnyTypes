// The shell's half of the created event types (spec 9.7, arch_pivot P11a/b; WI-0018-13).
//
// The Events page's calls go to the runtime, which keeps the store. The shell adds what only it
// can see, the nodes on the editor's canvas (deployed or not), so a deletion is refused while an
// undeployed edit uses the type. A create, a new version or a deletion changes the set of node
// types, which takes effect only in a new runtime process (spec 9.7): the shell then restarts
// the runtime child ALONE, for `types`. The app, its window and the editor's page stay up, and
// the editor keeps its undeployed edits (the editor sync, WI-0018-12, brings its palette in
// step). The spike relaunched the whole app instead (P9b).

import type { CallResult } from "../domain/channel/errors";
import type { CallOp, RestartInfo } from "../domain/channel/messages";
import type { Clock } from "../ports/clock";
import type { EditorNodes } from "../ports/editor";
import type { Logger } from "../ports/logger";
import { isEventOp, type EventTypeChange } from "./event-types";

/** The runtime child, as far as event type changes use it. */
export interface RuntimeChild {
  call(op: CallOp, args: unknown): Promise<CallResult>;
  /** A planned restart of this child only; false when it is not running. */
  restart(reason: "types", info: RestartInfo): boolean;
}

export interface EventTypeChangesDeps {
  readonly runtime: RuntimeChild;
  readonly editor: EditorNodes;
  readonly clock: Clock;
  readonly logger: Logger;
}

type Fields = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function changeOf(value: unknown): EventTypeChange | null {
  return isRecord(value) &&
    typeof value["type"] === "string" &&
    isStringList(value["added"]) &&
    isStringList(value["removed"])
    ? { type: value["type"], added: value["added"], removed: value["removed"] }
    : null;
}

export class EventTypeChanges {
  readonly #deps: EventTypeChangesDeps;

  constructor(deps: EventTypeChangesDeps) {
    this.#deps = deps;
  }

  /** One Events page call, `{op, args}`: answered by the runtime, then applied by a restart. */
  async call(call: unknown): Promise<CallResult> {
    const { op, args } = isRecord(call) ? call : {};
    if (!isEventOp(op)) {
      return { ok: false, error: `${String(op)} is not an event type call` };
    }
    const given = isRecord(args) ? args : {};
    // The list shows, and a deletion is judged against, the editor's own nodes too.
    const withEditor =
      op === "event.list" || op === "event.delete"
        ? { ...given, editor: (await this.#deps.editor.nodes()) ?? [] }
        : given;
    const result = await this.#deps.runtime.call(op, withEditor);
    if (!result.ok || op === "event.list" || op === "event.fire") {
      return result;
    }
    const change = changeOf(result.value);
    if (change === null) {
      return result;
    }
    const info: RestartInfo = {
      reason: `event type ${change.type} ${op === "event.delete" ? "deleted" : "created"}`,
      added: change.added,
      removed: change.removed,
      requestedAt: this.#deps.clock.now(),
    };
    if (this.#deps.runtime.restart("types", info)) {
      this.#deps.logger.info(`${info.reason}: restarting the runtime only, for its node types`);
    } else {
      this.#deps.logger.warn(
        `${info.reason}; the runtime is not running, so its next start has it`,
      );
    }
    return result;
  }
}
