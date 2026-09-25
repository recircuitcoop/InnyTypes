// The loopback MCP endpoint's address, served and saved (plan 0018 §4.1 points 3 and 4; plans
// 0007 and 0008): where it is served, how it is moved from the Settings page, and what the page
// is told about it.
//
// * The saved address is the stored setting, then INNYTYPES_MCP_HOST and INNYTYPES_MCP_PORT, then
//   the default (domain/endpoint/address.ts), read afresh each time so nothing caches a stale one.
// * The endpoint opens once the MCP child has first been validated (plan 0007's order: a URL a
//   client can configure exists only for a child whose surface was checked), and stays up across
//   child restarts, answering 503 while the child is unavailable.
// * A collision, or a saved address that cannot be served, degrades the endpoint alone, with the
//   address and the reason named, once in the log and once as a notice. No other port is tried.
// * A move binds the new address before the old one closes; one that cannot be served is refused
//   with its reason, costs the endpoint nothing, and stores nothing. Only an address that is being
//   served is stored, so the next start binds what this one did. Saving the address already
//   served stores it and moves nothing.

import type { CallOp, OpResult } from "../domain/channel/messages";
import {
  checkedAddress,
  configuredEndpoint,
  EndpointError,
  endpointUrl,
  type ConfiguredEndpoint,
} from "../domain/endpoint/address";
import { CLIENTS_MUST_BE_UPDATED, type McpEndpointStatus } from "../domain/endpoint/status";
import type { Logger } from "../ports/logger";
import type { McpListener } from "../ports/mcp-gateway";
import type { Notifier } from "../ports/notifier";
import type { SettingsStore } from "../ports/settings-store";

export interface McpEndpointDeps {
  readonly settings: SettingsStore;
  /** INNYTYPES_MCP_HOST and INNYTYPES_MCP_PORT as the process was given them. */
  readonly variables: Readonly<Record<string, string | undefined>>;
  readonly listener: McpListener;
  readonly logger: Logger;
  readonly notifier: Notifier;
}

export const NOT_YET_OPEN =
  "the MCP endpoint opens once the Anytype MCP child has been started and validated";

/** The host and port a move asks for, or the reason the request names none. */
function requestedAddress(args: unknown): { host: string; port: number } {
  if (typeof args === "object" && args !== null) {
    const { host, port } = args as Record<string, unknown>;
    if (typeof host === "string" && typeof port === "number") {
      return { host: host.trim(), port };
    }
  }
  throw new EndpointError("a new MCP endpoint needs a host and a port");
}

export class McpEndpoint {
  readonly #deps: McpEndpointDeps;
  #started = false;
  /** Why nothing is being served, once a start or a move has said. */
  #problem: string | null = null;
  /** Moves one at a time: two at once would race for the listener and the setting. */
  #moves: Promise<unknown> = Promise.resolve();

  constructor(deps: McpEndpointDeps) {
    this.#deps = deps;
  }

  /** Open the endpoint at the saved address. Called when the child is first ready; once only. */
  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    this.#started = true;
    let configured: ConfiguredEndpoint;
    try {
      configured = this.#configured();
    } catch (error) {
      this.#degrade((error as Error).message);
      return;
    }
    try {
      await this.#deps.listener.serveAt(configured.host, configured.port);
    } catch (error) {
      this.#degrade((error as Error).message);
      return;
    }
    this.#problem = null;
    this.#deps.logger.info(`the MCP endpoint serves ${configured.url}`);
  }

  /** Served against saved, for the Settings page. It never holds a credential. */
  status(): McpEndpointStatus {
    let configured: ConfiguredEndpoint | null = null;
    let savedProblem: string | null = null;
    try {
      configured = this.#configured();
    } catch (error) {
      savedProblem = (error as Error).message;
    }
    const address = this.#deps.listener.serving;
    const served = address === null ? null : endpointUrl(address.host, address.port);
    const saved = configured?.url ?? null;
    let problem: string | null;
    if (served === null) {
      problem = this.#started ? (this.#problem ?? savedProblem) : NOT_YET_OPEN;
    } else if (savedProblem !== null) {
      problem = savedProblem;
    } else {
      problem = saved === served ? null : `${String(saved)} is saved, but ${served} is served`;
    }
    return {
      served,
      saved,
      stored: configured?.stored ?? false,
      ignoredVariables: configured?.ignoredVariables ?? [],
      problem,
      warning: CLIENTS_MUST_BE_UPDATED,
    };
  }

  /** Move the endpoint, from the Settings page. Rejects with the reason; nothing then changed. */
  move(args: unknown): Promise<McpEndpointStatus> {
    const moved = this.#moves.then(() => this.#move(args));
    this.#moves = moved.catch(() => undefined);
    return moved;
  }

  /** Close the listener. The services process calls this before it stops the MCP child. */
  stop(): Promise<void> {
    return this.#deps.listener.stop();
  }

  async #move(args: unknown): Promise<McpEndpointStatus> {
    const { host, port } = requestedAddress(args);
    // The one rule, before anything is bound or stored: a non-loopback address is refused here.
    checkedAddress(host, port);
    const url = endpointUrl(host, port);
    const serving = this.#deps.listener.serving;
    const alreadyServed = serving !== null && serving.host === host && serving.port === port;
    if (!alreadyServed && this.#started) {
      // Bind-before-close is the listener's; a failure rejects here with the address named,
      // the old endpoint still serving and nothing stored.
      await this.#deps.listener.serveAt(host, port);
      this.#problem = null;
      this.#deps.logger.info(`the MCP endpoint moved to ${url}`);
    }
    try {
      this.#deps.settings.writeEndpoint({ host, port });
    } catch (error) {
      const reason = `the MCP endpoint setting could not be saved: ${(error as Error).message}`;
      this.#deps.logger.error(reason);
      throw new EndpointError(reason);
    }
    return this.status();
  }

  #configured(): ConfiguredEndpoint {
    return configuredEndpoint(this.#deps.settings.readEndpoint(), this.#deps.variables);
  }

  #degrade(reason: string): void {
    this.#problem = reason;
    this.#deps.logger.warn(`the MCP endpoint is not served: ${reason}`);
    try {
      this.#deps.notifier.raise({
        title: "MCP endpoint not served",
        body: `InnyTypes could not open its MCP endpoint: ${reason}. Choose another address in Settings.`,
      });
    } catch (error) {
      this.#deps.logger.error(`a notice could not be raised: ${String(error)}`);
    }
  }
}

/** The services process's answer to a shell call for the endpoint (AppApi's endpoint members). */
export async function serveEndpointCall(
  endpoint: McpEndpoint,
  op: CallOp,
  args: unknown,
): Promise<OpResult> {
  try {
    switch (op) {
      case "mcp.endpoint":
        return { ok: true, value: endpoint.status() };
      case "mcp.endpoint.move":
        return { ok: true, value: await endpoint.move(args) };
      default:
        return { ok: false, error: `the MCP endpoint does not serve ${op}` };
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** Quit: the listener closes first, so a client meets a refused connection, not a dead child. */
export async function stopServing(
  endpoint: { stop(): Promise<void> },
  service: { stop(): Promise<void> } | null,
): Promise<void> {
  await endpoint.stop();
  await service?.stop();
}
