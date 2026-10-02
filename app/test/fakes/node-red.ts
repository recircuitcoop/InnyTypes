// Node-RED's node-module API and a node instance, as adapters/nodered/registration.ts uses
// them, recording what they are told (moved here from generated-types.test.ts for the views).
import type { NodeRedNode, NodeRedNodeApi } from "../../src/adapters/nodered/registration";
import type { InputMessage, NodeStatus } from "../../src/ports/node-process";

export type Message = Record<string, unknown>;

/** A Node-RED node as the runtime sees one, recording what it is told. */
export class FakeNode implements NodeRedNode {
  id = "";
  name = "";
  credentials: Record<string, unknown> = {};
  readonly statuses: (NodeStatus | Record<string, never>)[] = [];
  readonly sent: (Message | null)[][] = [];
  readonly errors: string[] = [];
  readonly received: InputMessage[] = [];
  readonly answered: { outputs: (Message | null)[][]; ends: (Error | undefined)[] }[] = [];
  #input:
    ((m: Message, s: (x: (Message | null)[]) => void, d: (e?: Error) => void) => void) | null =
    null;
  #close: ((removed: boolean, done: () => void) => void) | null = null;

  status(status: NodeStatus | Record<string, never>): void {
    this.statuses.push(status);
  }
  send(messages: (Message | null)[]): void {
    this.sent.push(messages);
  }
  error(message: string): void {
    this.errors.push(message);
  }
  receive(message: InputMessage): void {
    this.received.push(message);
    this.input(message as unknown as Message);
  }
  on(event: "input" | "close", handler: never): void {
    if (event === "input") {
      this.#input = handler;
    } else {
      this.#close = handler;
    }
  }
  /** Node-RED delivering `message`; its outputs and its end are recorded. */
  input(message: Message): { outputs: (Message | null)[][]; ends: (Error | undefined)[] } {
    const answer = { outputs: [] as (Message | null)[][], ends: [] as (Error | undefined)[] };
    this.answered.push(answer);
    this.#input?.(
      message,
      (messages) => answer.outputs.push(messages),
      (error) => answer.ends.push(error),
    );
    return answer;
  }
  close(removed: boolean): Promise<void> {
    return new Promise((resolve) => this.#close?.(removed, resolve));
  }
}

/** Node-RED's node-module API, as far as registration uses it. */
export class FakeRed implements NodeRedNodeApi {
  readonly constructors = new Map<string, (this: NodeRedNode, config: Message) => void>();
  readonly options = new Map<string, unknown>();
  readonly nodes = {
    createNode: (node: object, config: object): void => {
      const fields = config as Message;
      // Node-RED's createNode also keeps the instance's tab, `z`, when the flow gives one.
      Object.assign(node, {
        id: fields["id"],
        name: fields["name"] ?? "",
        ...(fields["z"] === undefined ? {} : { z: fields["z"] }),
      });
    },
    registerType: (
      type: string,
      constructor: (this: NodeRedNode, config: Message) => void,
      options?: unknown,
    ): void => {
      this.constructors.set(type, constructor);
      this.options.set(type, options);
    },
  };
  readonly util = { cloneMessage: <T>(message: T): T => structuredClone(message) };

  /** Node-RED constructing an instance of `type` from its flow config and credentials. */
  create(type: string, config: Message, credentials: Message = {}): FakeNode {
    const node = new FakeNode();
    node.credentials = credentials;
    const constructor = this.constructors.get(type);
    if (constructor === undefined) {
      throw new Error(`${type} is not registered`);
    }
    constructor.call(node, { type, ...config });
    return node;
  }
}
