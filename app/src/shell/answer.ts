// From what a child answers to what AppApi v2 answers (plan 0022 §N): a value, or a refusal that
// carries a ui/strings.ts key. The English a child or the channel wrote goes to the log only; the
// page is told why by reason and key, and words it itself.
import type { CallResult } from "../domain/channel/errors";
import type { Logger } from "../ports/logger";
import type { Answer, Refusal, RefusalReason } from "../ui/answer";
import type { StringKey } from "../ui/strings";

export const refused = (
  reason: RefusalReason,
  sentence: StringKey,
  more: Omit<Refusal, "reason" | "sentence"> = {},
): { readonly ok: false; readonly refused: Refusal } => ({
  ok: false,
  refused: { reason, sentence, ...more },
});

/** A call declared before its work item lands (app-api-v2.ts says which item answers it). */
export const notAvailable = () => refused("not-available", "refused.notAvailable");

/**
 * A child's own refusals the shell knows by their exact words, mapped to a key: anything else a
 * child refuses with is `failed`, its words logged.
 */
export type KnownRefusals = Readonly<Record<string, readonly [RefusalReason, StringKey]>>;

/** The answer of a call to a child, as AppApi v2 answers it. */
export function fromChild<T>(
  result: CallResult,
  op: string,
  logger: Logger,
  known: KnownRefusals = {},
): Answer<T> {
  if (result.ok) {
    return { ok: true, value: result.value as T };
  }
  logger.info(`${op} was refused: ${result.error}`);
  if ("code" in result) {
    // The channel's own failure: the process was not there to answer.
    return result.code === "restarting"
      ? refused("restarting", "refused.restarting")
      : result.code === "timeout"
        ? refused("failed", "refused.failed")
        : refused("down", "refused.down");
  }
  const mapped = known[result.error];
  return mapped === undefined ? refused("failed", "refused.failed") : refused(mapped[0], mapped[1]);
}

/** Answers a handler's throw as `failed`, logged, so nothing ever throws across IPC. */
export async function guarded<T>(
  op: string,
  logger: Logger,
  work: () => Promise<Answer<T>> | Answer<T>,
): Promise<Answer<T>> {
  try {
    return await work();
  } catch (error) {
    logger.error(`${op} failed: ${String(error)}`);
    return refused("failed", "refused.failed");
  }
}

/** A `{op, args}` call as the page sends it: the op, and its args as a record. */
export function opOf(call: unknown): { op: string; args: Readonly<Record<string, unknown>> } {
  const { op, args } = (call ?? {}) as { op?: unknown; args?: unknown };
  return {
    op: typeof op === "string" ? op : String(op),
    args: typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {},
  };
}

/** An unknown op on a channel: refused as `failed`, and logged. */
export function unknownOp(op: string, channel: string, logger: Logger) {
  logger.warn(`${op} is not a ${channel} call`);
  return refused("failed", "refused.failed");
}
