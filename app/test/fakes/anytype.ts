// Fakes for the Anytype core service: an MCP child whose session answers what a test says, a
// launcher that hands them out, Anytype's API as plain answers, and a secret store in memory.

import { SessionError } from "../../src/domain/anytype/errors";
import type {
  AnytypeApi,
  McpChild,
  McpChildLauncher,
  McpSession,
  McpTool,
} from "../../src/ports/anytype";
import type { SecretName, SecretStore } from "../../src/ports/secret-store";
import type { AnytypeStatus, McpEndpointStatus } from "../../src/ui/contract";

/** AppApi's Anytype and MCP endpoint members for a page test that never calls them. */
export const ANYTYPE_UNUSED = {
  anytypeStatus: (): Promise<AnytypeStatus> => Promise.reject(new Error("not used here")),
  startAnytypePairing: (): Promise<AnytypeStatus> => Promise.reject(new Error("not used here")),
  completeAnytypePairing: (): Promise<AnytypeStatus> => Promise.reject(new Error("not used here")),
  mcpEndpoint: (): Promise<McpEndpointStatus> => Promise.reject(new Error("not used here")),
  moveMcpEndpoint: (): Promise<McpEndpointStatus> => Promise.reject(new Error("not used here")),
};

/** How a fake child answers pings: at once, never, or with a refusal. */
export type PingMode = "answer" | "silent" | "refuse";

export class FakeSession implements McpSession {
  closed = false;
  pings = 0;
  pingMode: PingMode = "answer";
  /** What initialize does: resolve with these tools, or reject with this error. */
  initializeWith: readonly McpTool[] | Error = [];
  readonly requests: string[] = [];
  readonly #waiting: ((error: SessionError) => void)[] = [];

  initialize(): Promise<readonly McpTool[]> {
    if (this.initializeWith instanceof Error) {
      return Promise.reject(this.initializeWith);
    }
    return Promise.resolve(this.initializeWith);
  }

  ping(): Promise<void> {
    this.pings += 1;
    if (this.closed) {
      return Promise.reject(new SessionError("the Anytype MCP child session is closed"));
    }
    switch (this.pingMode) {
      case "answer":
        return Promise.resolve();
      case "refuse":
        return Promise.reject(new SessionError("the Anytype MCP child refused ping: no"));
      case "silent":
        return new Promise((_resolve, reject) => {
          this.#waiting.push(reject);
        });
    }
  }

  request(method: string): Promise<unknown> {
    this.requests.push(method);
    if (this.closed) {
      return Promise.reject(new SessionError("the Anytype MCP child session is closed"));
    }
    return new Promise((_resolve, reject) => {
      this.#waiting.push(reject);
    });
  }

  /** A silent ping's own timeout firing. */
  timeOutPings(): void {
    for (const reject of this.#waiting.splice(0)) {
      reject(new SessionError("the Anytype MCP child timed out answering ping"));
    }
  }

  close(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const reject of this.#waiting.splice(0)) {
      reject(new SessionError(reason));
    }
  }
}

export class FakeMcpChild implements McpChild {
  readonly session = new FakeSession();
  stops = 0;
  exited = false;
  readonly #listeners: ((code: number | null, signal: string | null) => void)[] = [];

  constructor(readonly pid: number) {}

  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.#listeners.push(listener);
  }

  stop(): Promise<void> {
    this.stops += 1;
    this.exit(null, "SIGTERM");
    return Promise.resolve();
  }

  /** The child is gone: its session fails everything pending, as the real adapter does. */
  exit(code: number | null, signal: string | null = null): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.session.close(`the Anytype MCP child exited (code ${String(code)})`);
    for (const listener of this.#listeners) {
      listener(code, signal);
    }
  }
}

export class FakeMcpLauncher implements McpChildLauncher {
  readonly children: FakeMcpChild[] = [];
  readonly envs: Readonly<Record<string, string>>[] = [];
  /** Set up each new child before the service sees it. */
  prepare: (child: FakeMcpChild) => void = () => undefined;
  #nextPid = 5000;

  launch(env: Readonly<Record<string, string>>): McpChild {
    const child = new FakeMcpChild(this.#nextPid++);
    this.prepare(child);
    this.envs.push(env);
    this.children.push(child);
    return child;
  }

  get current(): FakeMcpChild {
    const child = this.children.at(-1);
    if (child === undefined) {
      throw new Error("no MCP child was launched");
    }
    return child;
  }
}

export class FakeAnytypeApi implements AnytypeApi {
  up = true;
  readonly probes: (string | null)[] = [];
  challenge = "challenge-1";
  issuedKey = "paired-key-0123456789";

  reachable(apiKey: string | null): Promise<boolean> {
    this.probes.push(apiKey);
    return Promise.resolve(this.up);
  }

  startPairing(): Promise<string> {
    return Promise.resolve(this.challenge);
  }

  completePairing(challengeId: string, code: string): Promise<string> {
    if (challengeId !== this.challenge || code !== "1234") {
      return Promise.reject(new Error("Anytype rejected the pairing code."));
    }
    return Promise.resolve(this.issuedKey);
  }
}

export class MemorySecretStore implements SecretStore {
  readonly values = new Map<SecretName, string>();

  read(name: SecretName): string | null {
    return this.values.get(name) ?? null;
  }

  write(name: SecretName, value: string): void {
    this.values.set(name, value.trim());
  }
}

/** Let every promise already settled run its callbacks. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}
