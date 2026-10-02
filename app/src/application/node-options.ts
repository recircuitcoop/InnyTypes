// The runtime's one resolver of a step's dynamic options (plan 0022 §B, D9): the canvas form's
// admin route `/red/inny/options` and Setup's `AppApi.nodeOptions` both answer through it.
//
// It asks the services process, which alone holds the Anytype key, over the direct peer
// channel, and turns what comes back into options: a space's id or a type's key as the value
// a node stores, its name as the label (the value itself when Anytype named none). A refusal
// passes through with its sentence; anything the services process could not answer becomes
// the "unavailable" refusal, its reason logged and never shown.

import type { OpResult } from "../domain/channel/messages";
import type { PeerOp } from "../domain/channel/peer-messages";
import {
  parseOptionsAnswer,
  parseOptionsQuery,
  refusal,
  type NodeOption,
  type OptionsAnswer,
  type OptionsQuery,
} from "../domain/forms/node-options";
import type { Logger } from "../ports/logger";

export interface NodeOptionsDeps {
  /** A call to the services process over the direct channel (PeerCaller.call). */
  readonly ask: (op: PeerOp, args: unknown) => Promise<OpResult>;
  readonly logger: Logger;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One listed entry as an option: `idKey` names the field the node stores. */
function optionOf(entry: unknown, idKey: "id" | "key"): NodeOption | null {
  if (!isRecord(entry)) {
    return null;
  }
  const value = entry[idKey];
  const name = entry["name"];
  if (typeof value !== "string" || value === "") {
    return null;
  }
  return { value, label: typeof name === "string" && name !== "" ? name : value };
}

export class NodeOptions {
  readonly #deps: NodeOptionsDeps;

  constructor(deps: NodeOptionsDeps) {
    this.#deps = deps;
  }

  /** The options `query` asks for, or the refusal to show in their place. */
  async resolve(query: OptionsQuery): Promise<OptionsAnswer> {
    const [op, args, idKey] =
      query.source === "spaces"
        ? (["anytype.spaces", {}, "id"] as const)
        : (["anytype.types", { spaceId: query.spaceId }, "key"] as const);
    const result = await this.#deps.ask(op, args);
    if (!result.ok) {
      this.#deps.logger.warn(`a step's form asked for ${op} and got no answer: ${result.error}`);
      return refusal("unavailable");
    }
    if (!Array.isArray(result.value)) {
      const answer = parseOptionsAnswer(result.value);
      if (answer !== null && "refused" in answer) {
        return answer;
      }
      this.#deps.logger.warn(
        `the services process answered ${op} with neither a list nor a refusal`,
      );
      return refusal("unavailable");
    }
    const options = (result.value as unknown[]).map((entry) => optionOf(entry, idKey));
    if (options.some((option) => option === null)) {
      this.#deps.logger.warn(`the services process listed an entry of ${op} with no ${idKey}`);
      return refusal("unavailable");
    }
    return { options: options as NodeOption[] };
  }

  /** The shell's `node.options` call (Setup, WI-0022-16): `{source, spaceId?}`. */
  async call(args: unknown): Promise<OpResult> {
    const query = parseOptionsQuery(args);
    if (query === null) {
      return {
        ok: false,
        error: "node.options needs {source: 'spaces'} or {source: 'types', spaceId}",
      };
    }
    return { ok: true, value: await this.resolve(query) };
  }
}
