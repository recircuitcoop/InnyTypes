// The Anytype core service (plan 0018 §4.1): the key, the health gate, the MCP child and its
// heartbeat, in the services process. It keeps every plan 0002/0007/0015 behaviour; only its
// language and host process changed.
//
// * The key is read through the SecretStore (the owner-only file adapter: canonical file, then
//   the read-only legacy one) and handed to the runtime's redactor over the direct channel.
// * The MCP child starts only after the health gate passes. Anytype not running is a state,
//   checked again on a timer; it is not a crash.
// * The handshake runs and tools/list must match the committed surface exactly, or the state
//   is `tool-surface-mismatch`, named, and the child is not restarted.
// * A child that exits, or that the heartbeat judges stale, is restarted under the domain
//   backoff and breaker (the ones the shell's supervisor uses). After the breaker's limit it
//   stops, and a notice says so. A stale child is restarted with a notice naming it.
// * A dead child fails every pending call (the session does that) and nothing is retried.

import type { CallOp, OpResult } from "../domain/channel/messages";
import { SessionError, ToolSurfaceMismatchError } from "../domain/anytype/errors";
import { childEnvironment } from "../domain/anytype/pins";
import type { AnytypeState, AnytypeStatus } from "../domain/anytype/status";
import { crashRestartDelay, type BackoffSettings } from "../domain/supervision/backoff";
import { CrashLoopBreaker, type CrashLoopSettings } from "../domain/supervision/breaker";
import type { StabilityProfile } from "../domain/supervision/staleness";
import type { AnytypeApi, McpChild, McpChildLauncher, McpSession, McpTool } from "../ports/anytype";
import type { Cancel, Clock } from "../ports/clock";
import type { Logger } from "../ports/logger";
import type { Notifier } from "../ports/notifier";
import type { SecretStore } from "../ports/secret-store";
import { McpHeartbeat } from "./mcp-heartbeat";
import { Pairing } from "./pair-anytype";

/** What the service's notices are about. */
const MCP_CHILD = "Anytype MCP child";

export interface AnytypeServiceSettings {
  readonly apiBaseUrl: string;
  readonly backoff: BackoffSettings;
  readonly crashLoop: CrashLoopSettings;
  readonly profile: StabilityProfile;
  /** Where the key is looked for, in words: the no-key state names it. */
  readonly keyLocation: string;
  /** How long after "Anytype did not answer" the health gate is asked again. */
  readonly healthRetryMs: number;
}

export interface AnytypeServiceDeps {
  readonly settings: AnytypeServiceSettings;
  /** Registering: every key it reads or writes is known to the redactor first. */
  readonly secrets: SecretStore;
  readonly api: AnytypeApi;
  readonly launcher: McpChildLauncher;
  /** Where the key goes for the runtime's redactor (the direct channel, §2.2). */
  readonly publishKey: (key: string) => void;
  /** One line the child printed on stderr, with its pid: the one log, at WARNING. */
  readonly childLine: (pid: number, line: string) => void;
  /** What the child's command is, for the log; it carries no credential. */
  readonly command: string;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly notifier: Notifier;
  /** Called each time a child is validated and ready: the gateway opens on the first (WI-0018-19). */
  readonly onReady?: () => void;
}

/**
 * The services process's answer to a shell call (AppApi's Anytype members). A failure is a
 * result carrying its message, which never holds the key.
 */
export async function serveAnytypeCall(
  service: AnytypeService,
  op: CallOp,
  args: unknown,
): Promise<OpResult> {
  try {
    switch (op) {
      case "anytype.status":
        return { ok: true, value: service.status() };
      case "anytype.pair.start":
        await service.startPairing();
        return { ok: true, value: service.status() };
      case "anytype.pair.complete":
        await service.completePairing(args);
        return { ok: true, value: service.status() };
      default:
        return { ok: false, error: `the InnyTypes services process does not serve ${op}` };
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export class AnytypeService {
  readonly #deps: AnytypeServiceDeps;
  readonly #breaker: CrashLoopBreaker;
  readonly #heartbeat: McpHeartbeat;
  readonly #pairing: Pairing;
  #state: AnytypeState = "starting";
  #detail: string | null = null;
  #child: McpChild | null = null;
  #tools: readonly McpTool[] = [];
  #crashesInARow = 0;
  #retry: Cancel | null = null;
  #stopping = false;
  #attempt = 0;

  constructor(deps: AnytypeServiceDeps) {
    this.#deps = deps;
    this.#breaker = new CrashLoopBreaker(deps.settings.crashLoop, () => deps.clock.now());
    this.#heartbeat = new McpHeartbeat({
      clock: deps.clock,
      logger: deps.logger,
      profile: deps.settings.profile,
      onStale: (silentFor) => {
        this.#onStale(silentFor);
      },
    });
    this.#pairing = new Pairing(deps.api, deps.secrets, deps.logger);
  }

  status(): AnytypeStatus {
    return {
      state: this.#state,
      detail: this.#detail,
      childPid: this.#child?.pid ?? null,
      beats: this.#heartbeat.beats,
      pairing: this.#pairing.waiting,
    };
  }

  /** The validated session, for the gateway (WI-0018-19); null unless `ready`. */
  session(): McpSession | null {
    return this.#state === "ready" ? (this.#child?.session ?? null) : null;
  }

  /** The tools the ready child listed when it was validated, for the gateway; null otherwise. */
  tools(): readonly McpTool[] | null {
    return this.session() === null ? null : this.#tools;
  }

  /** Bring the service up. Returns at once: nothing here waits for Anytype. */
  start(): void {
    void this.#bringUp();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#retry?.();
    this.#retry = null;
    this.#heartbeat.stop();
    const child = this.#child;
    this.#child = null;
    this.#setState("stopped", null);
    await child?.stop();
  }

  /** "Pair with Anytype": Anytype shows a four-digit code. */
  startPairing(): Promise<void> {
    return this.#pairing.start();
  }

  /** The code, typed: the key is stored owner-only and the child restarted with it. */
  async completePairing(code: unknown): Promise<void> {
    await this.#pairing.complete(code);
    // A new key is a new start: whatever the old one ran into is not held against it.
    this.#retry?.();
    this.#retry = null;
    this.#heartbeat.stop();
    const child = this.#child;
    this.#child = null;
    await child?.stop();
    this.#breaker.reset();
    this.#crashesInARow = 0;
    await this.#bringUp();
  }

  // ── bringing the child up ───────────────────────────────────────────────────────────────

  async #bringUp(): Promise<void> {
    this.#retry = null;
    // Only the newest attempt may launch: a pairing that lands while the health gate of an
    // older attempt is still waiting must not end with two children.
    const attempt = ++this.#attempt;
    if (this.#stopping) {
      return;
    }
    let key: string | null;
    try {
      key = this.#deps.secrets.read("anytype-api-key");
    } catch (error) {
      this.#setState("no-key", `the Anytype key could not be read: ${(error as Error).message}`);
      return;
    }
    if (key === null) {
      this.#setState(
        "no-key",
        `no Anytype API key in ${this.#deps.settings.keyLocation}: pair with Anytype on the ` +
          `Settings page`,
      );
      return;
    }
    this.#deps.publishKey(key);

    const { apiBaseUrl, healthRetryMs } = this.#deps.settings;
    const reachable = await this.#deps.api.reachable(key);
    if (this.#superseded(attempt)) {
      return;
    }
    if (!reachable) {
      this.#setState(
        "unreachable",
        `Anytype's local API did not answer at ${apiBaseUrl}; start the Anytype desktop app`,
      );
      this.#retry = this.#deps.clock.after(healthRetryMs, () => void this.#bringUp());
      return;
    }
    this.#launch(key);
  }

  /** Quit, or a newer attempt started while this one waited on Anytype. */
  #superseded(attempt: number): boolean {
    return this.#stopping || attempt !== this.#attempt;
  }

  #launch(key: string): void {
    this.#deps.logger.info(
      `starting the Anytype MCP child (${this.#deps.command}) against ${this.#deps.settings.apiBaseUrl}`,
    );
    const child = this.#deps.launcher.launch(
      childEnvironment(key, this.#deps.settings.apiBaseUrl),
      this.#deps.childLine,
    );
    this.#child = child;
    this.#setState("starting", null);
    child.onExit((code, signal) => {
      this.#onExit(child, code, signal);
    });
    child.session.initialize().then(
      (tools) => {
        if (child !== this.#child) {
          return;
        }
        this.#crashesInARow = 0;
        this.#tools = tools;
        this.#setState("ready", null);
        // Serving again: a later stop or restart is news again.
        this.#deps.notifier.clear("mcp-child-restarted", MCP_CHILD);
        this.#deps.notifier.clear("mcp-child-stopped", MCP_CHILD);
        this.#deps.logger.info(
          `the Anytype MCP child (pid ${String(child.pid)}) is ready with ${String(tools.length)} ` +
            `tools, the committed surface`,
        );
        this.#heartbeat.start(child.session);
        this.#deps.onReady?.();
      },
      (error: unknown) => {
        if (child !== this.#child) {
          return;
        }
        this.#child = null;
        void child.stop();
        if (error instanceof ToolSurfaceMismatchError) {
          // Not a crash: a restart would list the same tools. The surface must be re-recorded.
          this.#deps.logger.error(error.message);
          this.#setState("tool-surface-mismatch", error.message);
          return;
        }
        const reason = error instanceof SessionError ? error.message : String(error);
        this.#deps.logger.error(`the Anytype MCP child could not initialize: ${reason}`);
        this.#down(`the Anytype MCP child could not initialize: ${reason}`);
      },
    );
  }

  #onExit(child: McpChild, code: number | null, signal: string | null): void {
    if (child !== this.#child || this.#stopping) {
      return; // one this service stopped itself, or quit
    }
    this.#child = null;
    this.#heartbeat.stop();
    const how = signal === null ? `code ${String(code)}` : `signal ${signal}`;
    this.#deps.logger.warn(
      `the Anytype MCP child (pid ${String(child.pid)}) exited on its own (${how})`,
    );
    this.#down(`the Anytype MCP child exited (${how})`);
  }

  #onStale(silentForMs: number): void {
    const child = this.#child;
    if (child === null || this.#stopping) {
      return;
    }
    this.#child = null;
    const seconds = Math.round(silentForMs / 1000);
    this.#notice(
      "mcp-child-restarted",
      `It (pid ${String(child.pid)}) answered no ping for ${String(seconds)} s, so it was restarted`,
    );
    void child.stop();
    this.#down(`the Anytype MCP child (pid ${String(child.pid)}) stopped answering pings`);
  }

  /** Count one failure against the breaker, then restart after the backoff or stop for good. */
  #down(reason: string): void {
    this.#crashesInARow += 1;
    if (!this.#breaker.recordCrash()) {
      const { maxCrashes, windowMs } = this.#deps.settings.crashLoop;
      const message =
        `The Anytype MCP child stopped ${String(maxCrashes)} times in ` +
        `${String(Math.round(windowMs / 1000))} s, so it is no longer restarted (${reason}).`;
      this.#setState("down-for-good", message);
      this.#notice("mcp-child-stopped", message);
      return;
    }
    const delay = crashRestartDelay(this.#crashesInARow, this.#deps.settings.backoff);
    this.#setState("down", `${reason}; restarting in ${String(delay)} ms`);
    this.#retry = this.#deps.clock.after(delay, () => void this.#bringUp());
  }

  #notice(kind: "mcp-child-stopped" | "mcp-child-restarted", detail: string): void {
    try {
      this.#deps.notifier.raise({ kind, subject: MCP_CHILD, detail });
    } catch (error) {
      this.#deps.logger.error(`a notice could not be raised: ${String(error)}`);
    }
  }

  #setState(state: AnytypeState, detail: string | null): void {
    if (state !== this.#state || detail !== this.#detail) {
      this.#deps.logger.info(`anytype: ${state}${detail === null ? "" : ` (${detail})`}`);
    }
    this.#state = state;
    this.#detail = detail;
  }
}
