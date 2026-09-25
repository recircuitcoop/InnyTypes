// The generated types' one implementation in Node-RED (spec §6, §7; WI-0018-09).
//
// Each generated module (generator.ts) calls `register(RED, typeName)` through the global the
// runtime sets. Each instance Node-RED then constructs:
// - takes its declared properties, coerces them from the schema (Node-RED hands back strings)
//   and validates them with its credentials against the type's `config` schema BEFORE any
//   process starts: an instance the schema refuses starts nothing, shows why, and fails every
//   input with the reason (spec 2.5.3);
// - otherwise starts its node process (adapters/process/node-process.ts, through the
//   NodeProcessLauncher port) with that config in the start frame, and attaches it to the
//   runtime's one journal replay (application/journal-replay.ts), which re-sends its journaled
//   inputs through `node.receive` on the next `flows:started` (spec 7.2);
// - hands each input to the process, which journals it before writing it (spec 7.1), and maps
//   the process's `done`/`error` to Node-RED's `done()`, its emits to the right output port,
//   and its `status` to `node.status` (spec 4.2, 5.4).
//
// The spike did this in `runtime/runtime.js` with its own journal and its own listener per
// instance; here the process, the journal and the replay are the runtime's own, handed in.

import { configOf, credentialsOf } from "../../domain/forms/coerce";
import { secretKeys } from "../../domain/forms/form-model";
import type { CloseReason } from "../../domain/journal/entry";
import { portsOf, type LoadedType } from "../../domain/packages/declaration";
import type { Logger } from "../../ports/logger";
import type {
  InputMessage,
  NodeOutput,
  NodeProcess,
  NodeProcessHost,
  NodeProcessLauncher,
  NodeStatus,
} from "../../ports/node-process";
import type { SchemaValidator } from "../../ports/schema-validator";

/** A Node-RED message, as far as the runtime reads or writes it. */
type Message = Record<string, unknown>;

/** What Node-RED's node-module API gives a node file (the public `RED` of a node module). */
export interface NodeRedNodeApi {
  readonly nodes: {
    createNode(node: object, config: object): void;
    registerType(
      type: string,
      constructor: (this: NodeRedNode, config: Message) => void,
      options?: { credentials?: Record<string, { type: "password" | "text" }> },
    ): void;
  };
  readonly util: { cloneMessage<T>(message: T): T };
}

/** A Node-RED node instance, as far as the runtime uses it. */
export interface NodeRedNode {
  readonly id: string;
  readonly name?: string;
  readonly credentials?: Record<string, unknown>;
  status(status: NodeStatus | Record<string, never>): void;
  send(messages: (Message | null)[]): void;
  error(message: string): void;
  receive(message: InputMessage): void;
  on(
    event: "input",
    handler: (
      message: Message,
      send: (messages: (Message | null)[]) => void,
      done: (error?: Error) => void,
    ) => void,
  ): void;
  on(event: "close", handler: (removed: boolean, done: () => void) => void): void;
}

/** What starting a type's process needs beyond its config: spec 2.3 resolved for this OS. */
export interface ProcessCommand {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** The runtime's one journal replay (application/journal-replay.ts), as instances use it. */
export interface InstanceReplay {
  attach(
    instanceId: string,
    node: NodeProcess,
    redeliver: (message: InputMessage) => void,
  ): () => void;
}

export interface RegistrationDeps {
  /** Every loaded type, by its Node-RED type name. */
  readonly types: ReadonlyMap<string, LoadedType>;
  readonly launcher: NodeProcessLauncher;
  readonly validator: SchemaValidator;
  readonly replay: InstanceReplay;
  readonly logger: Logger;
  /** The type's argv, cwd and environment; throws when its command cannot run here. */
  readonly commandFor: (loaded: LoadedType) => ProcessCommand;
  /** The instance's private folder, kept across restarts (spec 4.1 `data_dir`). */
  readonly dataDirFor: (instanceId: string) => string;
  /** Why an instance that is not being removed closes now: the runtime's stop, or a redeploy. */
  readonly closeReason: () => Exclude<CloseReason, "removed">;
}

/** The message on its output port and nothing on the others (spec 5.4.3). */
function onPort(index: number, count: number, message: Message): (Message | null)[] {
  const messages: (Message | null)[] = new Array<Message | null>(count).fill(null);
  messages[index] = message;
  return messages;
}

export class TypeRegistration {
  readonly #deps: RegistrationDeps;

  constructor(deps: RegistrationDeps) {
    this.#deps = deps;
  }

  /** Called by a generated module as Node-RED loads it. */
  register(RED: NodeRedNodeApi, typeName: string): void {
    const loaded = this.#deps.types.get(typeName);
    if (loaded === undefined) {
      throw new Error(`${typeName} is not a type of any loaded node package`);
    }
    // Every declared secret is a password credential (spec 2.5.2).
    const credentials = Object.fromEntries(
      secretKeys(loaded.type.config).map((key) => [key, { type: "password" as const }]),
    );
    const construct = (node: NodeRedNode, config: Message): void => {
      this.#construct(RED, node, config, typeName, loaded);
    };
    // Node-RED calls this with `new`, as the node's constructor.
    function InnyNode(this: NodeRedNode, config: Message): void {
      RED.nodes.createNode(this, config);
      construct(this, config);
    }
    RED.nodes.registerType(typeName, InnyNode, { credentials });
  }

  #construct(
    RED: NodeRedNodeApi,
    node: NodeRedNode,
    raw: Message,
    typeName: string,
    loaded: LoadedType,
  ): void {
    const { validator, logger } = this.#deps;
    const who = `[${typeName} ${node.id}]`;
    const schema = loaded.type.config;
    const config = configOf(schema, raw);
    const credentials = credentialsOf(schema, node.credentials ?? {});
    // Validated with its credentials, so a required secret never set is refused too.
    const problems = validator.check(schema, { ...config, ...credentials });
    let refusal: string | null =
      problems.length === 0
        ? null
        : `its configuration is refused: ${problems
            .map((p) => `${p.path === "" ? "config" : p.path.slice(1)} ${p.message}`)
            .join("; ")}`;
    let command: ProcessCommand | null = null;
    if (refusal === null) {
      try {
        command = this.#deps.commandFor(loaded);
      } catch (error) {
        refusal = `its command cannot run: ${(error as Error).message}`;
      }
    }
    if (refusal !== null || command === null) {
      this.#refuse(node, who, refusal ?? "it cannot start");
      return;
    }

    const ports = portsOf(loaded.type);
    const host: NodeProcessHost = {
      status: (status) => {
        node.status(status);
      },
      send: (output) => {
        node.send(onPort(output.index, ports.length, { ...output.message }));
      },
      present: (inputId) => {
        logger.warn(`${who} presented input ${inputId}; views are not shown yet (WI-0018-10)`);
      },
      snapshot: () => {
        logger.warn(`${who} took a snapshot; snapshots are not kept yet (WI-0018-10)`);
      },
      nodeError: (message) => {
        node.error(message);
      },
    };
    const child = this.#deps.launcher.start(
      {
        identity: {
          id: node.id,
          package: loaded.declaration.package,
          typeId: loaded.type.id,
          type: typeName,
          name: node.name ?? "",
          kind: loaded.type.kind,
        },
        argv: command.argv,
        cwd: command.cwd,
        env: command.env,
        config,
        credentials,
        dataDir: this.#deps.dataDirFor(node.id),
        ports: ports.map(({ port, event }) => ({ port, event })),
      },
      host,
    );
    const detach = this.#deps.replay.attach(node.id, child, (message) => {
      node.receive(message);
    });

    node.on("input", (message, send, done) => {
      child.input(message as unknown as InputMessage, {
        // An output caused by this input: a clone of it, so `_msgid` is kept (spec 5.4.1).
        send: (output: NodeOutput) => {
          const caused = RED.util.cloneMessage(message);
          caused["payload"] = output.message.payload;
          caused["topic"] = output.message.topic;
          caused["inny"] = output.message.inny;
          send(onPort(output.index, ports.length, caused));
        },
        done: (error?: Error) => {
          if (error === undefined) {
            done();
          } else {
            done(error);
          }
        },
      });
    });
    node.on("close", (removed, done) => {
      detach();
      const reason: CloseReason = removed ? "removed" : this.#deps.closeReason();
      child.close(reason).then(done, (error: unknown) => {
        logger.error(`${who} did not close cleanly: ${String(error)}`);
        done();
      });
    });
  }

  /** An instance that cannot start: said on the canvas and in the log; its inputs fail. */
  #refuse(node: NodeRedNode, who: string, refusal: string): void {
    this.#deps.logger.error(`${who} not started: ${refusal}`);
    node.status({ fill: "red", shape: "ring", text: "invalid configuration" });
    node.error(`not started: ${refusal}`);
    node.on("input", (_message, _send, done) => {
      done(new Error(`not started: ${refusal}`));
    });
    node.on("close", (_removed, done) => {
      done();
    });
  }
}
