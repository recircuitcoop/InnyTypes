// The runtime ↔ services direct channel (plan 0018 §2.2), both of its ends.
//
// The shell side: whenever the runtime and the services process are both running and either
// is a generation the last link did not join, the shell makes a new MessageChannelMain and
// hands one end to each. A runtime restarted for a type change therefore gets a fresh end,
// and the services process, which was never restarted, gets the other one.
//
// The child side: the services process sends the Anytype key over every end it is handed,
// and the runtime registers what arrives with its redactor. The key is held in memory at both
// ends and is never written anywhere by this channel.

import { parsePeerMessage } from "../domain/channel/peer-messages";
import type { ChildStatus } from "../domain/supervision/child-state";
import type { Logger, SecretSink } from "../ports/logger";
import type { PeerLink } from "../ports/shell-link";

/** What the shell's peer linking needs of one supervised child. */
export interface PeerChild {
  status(): ChildStatus;
  onStatus(listener: (status: ChildStatus) => void): void;
  sendPeer(end: object): boolean;
}

/** Link the runtime and the services process now, and again after every new generation. */
export function linkPeers(
  runtime: PeerChild,
  services: PeerChild,
  newChannel: () => readonly [object, object],
  logger: Logger,
): void {
  let linked = "";
  const link = (): void => {
    const [left, right] = [runtime.status(), services.status()];
    if (left.state !== "running" || right.state !== "running") {
      return;
    }
    const generations = `${String(left.generation)}/${String(right.generation)}`;
    if (generations === linked) {
      return;
    }
    const [runtimeEnd, servicesEnd] = newChannel();
    if (runtime.sendPeer(runtimeEnd) && services.sendPeer(servicesEnd)) {
      linked = generations;
      logger.info(
        `linked runtime generation ${String(left.generation)} and services generation ` +
          `${String(right.generation)} directly`,
      );
    }
  };
  runtime.onStatus(link);
  services.onStatus(link);
  link();
}

/**
 * The services side: the current end, and the key it is to carry. The key is sent over every
 * new end, and over the current end whenever it changes (a new pairing).
 */
export class KeyPublisher {
  #peer: PeerLink | null = null;
  #key: string | null = null;

  /** A new end from the shell: the old one is closed, and the key goes over the new one. */
  connect(peer: PeerLink): void {
    this.#peer?.close();
    this.#peer = peer;
    this.#send();
  }

  publish(key: string): void {
    this.#key = key;
    this.#send();
  }

  #send(): void {
    if (this.#peer !== null && this.#key !== null) {
      this.#peer.post({ v: 1, t: "anytype-key", key: this.#key });
    }
  }
}

/** The runtime side: register every key the services process sends with the redactor. */
export function receiveKeys(peer: PeerLink, sink: SecretSink, logger: Logger): void {
  peer.onMessage((raw) => {
    const message = parsePeerMessage(raw);
    if (message === null) {
      logger.warn("the services process sent a message the direct channel does not know");
      return;
    }
    sink.protect(message.key);
    logger.info("the Anytype key arrived from the services process and is redacted from now on");
  });
}
