// The once-only notice for an Anytype key that Anytype refuses (plan 0018 §4.2).
//
// A first-party Anytype node that meets a 401 fails the input with PAIR_AGAIN_MESSAGE and does
// not retry it. A node process cannot raise a notice itself (protocol v2 has no frame for one),
// so the runtime watches the inputs of the Anytype package's instances: the first input to fail
// with exactly that text raises one notice, and further refusals raise none, however many
// instances meet them, until an Anytype input succeeds again (the person paired again).
//
// The shell's NoticeBoard is what keeps it once across runtime restarts (WI-0018-21): this side
// only saves the channel a message per refusal, and clears the condition when an input succeeds.

import { PAIR_AGAIN_MESSAGE } from "../domain/anytype/errors";
import { ANYTYPE_PACKAGE_NAME } from "../domain/anytype/pins";
import type {
  InputDelivery,
  InputMessage,
  NodeProcess,
  NodeProcessHost,
  NodeProcessLauncher,
  NodeProcessSpec,
} from "../ports/node-process";
import type { Notice, Notifier } from "../ports/notifier";

/** The first-party package whose inputs are watched. */
export const ANYTYPE_PACKAGE = ANYTYPE_PACKAGE_NAME;

export const PAIR_AGAIN_NOTICE: Notice = { kind: "anytype-key-refused", subject: "Anytype" };

/** `launcher`, with the inputs of every Anytype instance it starts watched for refusals. */
export function noticeAnytypeRefusals(
  launcher: NodeProcessLauncher,
  notifier: Notifier,
): NodeProcessLauncher {
  let raised = false;
  const watch = (delivery: InputDelivery): InputDelivery => ({
    send: (output) => {
      delivery.send(output);
    },
    done: (error) => {
      if (error === undefined) {
        if (raised) {
          raised = false;
          notifier.clear(PAIR_AGAIN_NOTICE.kind, PAIR_AGAIN_NOTICE.subject);
        }
      } else if (error.message === PAIR_AGAIN_MESSAGE && !raised) {
        raised = true;
        notifier.raise(PAIR_AGAIN_NOTICE);
      }
      delivery.done(error);
    },
  });
  return {
    start: (spec: NodeProcessSpec, host: NodeProcessHost): NodeProcess => {
      const started = launcher.start(spec, host);
      return spec.identity.package === ANYTYPE_PACKAGE ? new Watched(started, watch) : started;
    },
  };
}

/** A node process whose inputs' ends pass through `watch`; everything else is the process's. */
class Watched implements NodeProcess {
  constructor(
    readonly process: NodeProcess,
    readonly watch: (delivery: InputDelivery) => InputDelivery,
  ) {}

  get pid(): number | null {
    return this.process.pid;
  }

  input(message: InputMessage, delivery: InputDelivery): string | null {
    return this.process.input(message, this.watch(delivery));
  }

  cancel(inputId: string): void {
    this.process.cancel(inputId);
  }

  action(inputId: string, values: Readonly<Record<string, unknown>>): boolean {
    return this.process.action(inputId, values);
  }

  trigger(action: string, snapshot: { id: string; state: unknown }, values: object): boolean {
    return this.process.trigger(action, snapshot, values);
  }

  fire(data: Readonly<Record<string, unknown>>): void {
    this.process.fire(data);
  }

  close(reason: Parameters<NodeProcess["close"]>[0]): Promise<void> {
    return this.process.close(reason);
  }

  replay(redeliver: (message: InputMessage) => void): number {
    return this.process.replay(redeliver);
  }

  queue(): ReturnType<NodeProcess["queue"]> {
    return this.process.queue();
  }
}
