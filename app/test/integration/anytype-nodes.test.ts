// The first-party Anytype node package (plan 0018 §4.2, WI-0018-20), end to end below the app:
// packages/anytype is bundled by esbuild exactly as `npm run build:packages` bundles it, packed
// as a signed archive, installed through WI-0018-15's package environment code, and each of
// its five types is then run from the INSTALLED folder, through the runtime's own node-process
// adapter, against a fake Anytype over real HTTP (test/fakes/anytype.ts).
//
// Never the person's Anytype and never their key: the key is a canary in a scratch file, named
// to the node the way the runtime names it (INNYTYPES_ANYTYPE_KEY_FILE).

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { FsContentHashes } from "../../src/adapters/fs/content-hashes";
import { FsPackageRoots } from "../../src/adapters/fs/package-roots";
import { FsPackageSource } from "../../src/adapters/fs/package-source";
import { minimalEnvironment, resolveCommand } from "../../src/adapters/process/command";
import { PackageEnvironmentBuilder } from "../../src/adapters/process/env-builder";
import { DEFAULT_NODE_PROCESS, nodeProcessLauncher } from "../../src/adapters/process/node-process";
import { processTreeFor } from "../../src/adapters/process/process-tree";
import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { sha256Hex } from "../../src/adapters/signature/digest";
import { MinisignVerifier } from "../../src/adapters/signature/minisign";
import { systemClock } from "../../src/adapters/system/clock";
import { noticeAnytypeRefusals, PAIR_AGAIN_NOTICE } from "../../src/application/anytype-refusals";
import { buildPackageEnvironment } from "../../src/application/package-environment";
import { PAIR_AGAIN_MESSAGE } from "../../src/domain/anytype/errors";
import {
  ANYTYPE_VERSION,
  anytypeKeyEnvironment,
  anytypeKeyVariables,
} from "../../src/domain/anytype/pins";
import {
  parseDeclaration,
  portsOf,
  type DeclaredType,
} from "../../src/domain/packages/declaration";
import type {
  NodeProcess,
  NodeProcessLauncher,
  NodeProcessSpec,
} from "../../src/ports/node-process";
import { FakeAnytypeServer } from "../fakes/anytype";
import { MemoryJournal } from "../fakes/journal";
import { Signer } from "../fakes/minisign-signer";
import { signedArchive } from "../fakes/package-archive";
import {
  RecordingDelivery,
  RecordingHost,
  RecordingLogger,
  RecordingNotifier,
  RecordingSecrets,
  waitFor,
} from "../fixtures/raw-node/fixture";

const REPOSITORY = path.resolve(import.meta.dirname, "..", "..", "..");
const PACKAGE_SOURCE = path.join(REPOSITORY, "packages", "anytype");
/** The canary: a key-shaped value that must never appear anywhere but its own file. */
const KEY = `canary-anytype-key-${randomUUID()}`;
const SPACE = "space-1";

let scratch: string;
let installed: string;
let keyFile: string;
let declaredTypes: readonly DeclaredType[];

beforeAll(async () => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inny-anytype-nodes-")));
  // The package as it ships: its declaration and one pre-bundled file (spec 2.3.3).
  const folder = path.join(scratch, "anytype");
  fs.mkdirSync(folder);
  fs.copyFileSync(
    path.join(PACKAGE_SOURCE, "inny-package.json"),
    path.join(folder, "inny-package.json"),
  );
  await build({
    entryPoints: [path.join(PACKAGE_SOURCE, "src", "main.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: path.join(folder, "dist", "anytype.cjs"),
    logLevel: "warning",
  });
  const files = Object.fromEntries(
    ["inny-package.json", "dist/anytype.cjs"].map((file) => [
      file,
      fs.readFileSync(path.join(folder, file)),
    ]),
  );
  const signer = new Signer();
  const archive = path.join(scratch, "anytype.tgz");
  fs.writeFileSync(archive, signedArchive(files, signer));

  // Installed the way every package is: verified, then built into its own environment.
  const base = path.join(scratch, "installed");
  const built = await buildPackageEnvironment(
    { kind: "archive", path: archive, publicKey: signer.publicKeyText },
    {
      source: new FsPackageSource(),
      verifier: new MinisignVerifier(),
      validator: new AjvSchemaValidator(),
      contentHashes: new FsContentHashes(path.join(base, "content-hashes.json")),
      roots: new FsPackageRoots(base),
      builder: new PackageEnvironmentBuilder({
        locator: {
          uv: () => {
            throw new Error("uv was asked for a node package");
          },
          python: () => {
            throw new Error("python was asked for a node package");
          },
        },
        parentEnvironment: {},
        cacheDir: path.join(scratch, "cache"),
        wheels: { kind: "default" },
        timeoutMs: 1,
        platform: process.platform,
      }),
      logger: new RecordingLogger(),
      sha256: sha256Hex,
      target: { platform: process.platform, arch: process.arch },
    },
  );
  installed = path.join(built.live, "package");
  const parsed = parseDeclaration(
    JSON.parse(fs.readFileSync(path.join(installed, "inny-package.json"), "utf8")),
    (value) => new AjvSchemaValidator().declaration(value),
  );
  if (!parsed.ok) {
    throw new Error(parsed.problems.join("; "));
  }
  declaredTypes = parsed.declaration.types;

  keyFile = path.join(scratch, "config", "anytype_api_key");
  fs.mkdirSync(path.dirname(keyFile), { mode: 0o700 });
  fs.writeFileSync(keyFile, KEY, { mode: 0o600 });
}, 60_000);

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

// ── one instance, started as the runtime starts it ──────────────────────────────────────

interface Started {
  readonly node: NodeProcess;
  readonly host: RecordingHost;
  readonly logger: RecordingLogger;
  readonly journal: MemoryJournal;
  readonly spec: NodeProcessSpec;
}

const running: NodeProcess[] = [];
/** The fake Anytype of the running test, and where it listens. */
let current: FakeAnytypeServer | null = null;
let url: string;
let notifier: RecordingNotifier;
let logger: RecordingLogger;
let journal: MemoryJournal;
let launcher: NodeProcessLauncher;

async function openAnytype(): Promise<FakeAnytypeServer> {
  const server = new FakeAnytypeServer(KEY);
  current = server;
  url = await server.start();
  notifier = new RecordingNotifier();
  logger = new RecordingLogger();
  journal = new MemoryJournal();
  // One launcher for every instance of a test, as the runtime has one.
  launcher = noticeAnytypeRefusals(
    nodeProcessLauncher({
      clock: systemClock,
      logger,
      secrets: new RecordingSecrets(),
      notifier,
      tree: processTreeFor(process.platform),
      newId: randomUUID,
      journal,
      settings: DEFAULT_NODE_PROCESS,
    }),
    notifier,
  );
  return server;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((node) => node.close("removed")));
  await current?.close();
  current = null;
});

function typeOf(id: string): DeclaredType {
  const type = declaredTypes.find((declared) => declared.id === id);
  if (type === undefined) {
    throw new Error(`packages/anytype declares no ${id}`);
  }
  return type;
}

function startType(
  typeId: string,
  config: Record<string, unknown>,
  env: Record<string, string> = anytypeKeyEnvironment({ file: keyFile }),
): Started {
  const type = typeOf(typeId);
  const host = new RecordingHost();
  const spec: NodeProcessSpec = {
    identity: {
      id: `a${randomUUID().slice(0, 8)}`,
      package: "anytype",
      typeId,
      type: `inny-anytype-${typeId}`,
      name: "",
      kind: "node",
    },
    ...resolveCommand(type.command, process.platform, {
      python: "python3",
      node: process.execPath,
      package: installed,
    }),
    env: minimalEnvironment(process.env, env),
    config: { api_base_url: url, ...config },
    credentials: {},
    dataDir: fs.mkdtempSync(path.join(scratch, "data-")),
    ports: portsOf(type).map(({ port, event }) => ({ port, event })),
  };
  const node = launcher.start(spec, host);
  running.push(node);
  return { node, host, logger, journal, spec };
}

/** One input through the instance; its delivery once it has ended. */
async function send(started: Started, payload: unknown): Promise<RecordingDelivery> {
  const delivery = new RecordingDelivery();
  started.node.input({ payload, topic: "test.input.v1" }, delivery);
  await waitFor("the input to end", () => delivery.finished, 10_000);
  return delivery;
}

function emitted(delivery: RecordingDelivery): { port: string; data: unknown } {
  expect(delivery.ends).toEqual([undefined]);
  const [output] = delivery.outputs;
  return { port: output?.port ?? "", data: output?.message.payload };
}

/** Everything the node said or sent that the runtime kept, as one text. */
function everything(started: Started, deliveries: RecordingDelivery[]): string {
  return JSON.stringify({
    lines: started.logger.lines,
    nodeLines: started.logger.nodeLines,
    statuses: started.host.statuses,
    errors: started.host.errors,
    journal: started.journal,
    start: { config: started.spec.config, credentials: started.spec.credentials },
    outputs: deliveries.map((delivery) => delivery.outputs),
    ends: deliveries.map((delivery) => delivery.ends.map((end) => end?.message ?? null)),
  });
}

// ── the declaration ──────────────────────────────────────────────────────────────────────

describe("packages/anytype", () => {
  it("declares the five types of §4.2, installs from a signed archive as a node package, and ships one pre-bundled file", () => {
    expect(declaredTypes.map((type) => [type.id, type.kind, type.outputs])).toEqual([
      ["create-object", "node", [{ port: "created", event: "anytype.object.created.v1" }]],
      ["update-object", "node", [{ port: "updated", event: "anytype.object.updated.v1" }]],
      ["read-object", "node", [{ port: "object", event: "anytype.object.read.v1" }]],
      ["read-space", "node", [{ port: "objects", event: "anytype.space.read.v1" }]],
      ["search", "node", [{ port: "results", event: "anytype.search.results.v1" }]],
    ]);
    for (const type of declaredTypes) {
      expect(type.command).toEqual(["{node}", "{package}/dist/anytype.cjs"]);
      // The key is neither config nor a credential (§4.2): no property could carry it.
      const properties = Object.keys(
        (type.config as { properties: Record<string, unknown> }).properties,
      );
      expect(properties.filter((name) => /api_key|token|secret|^key$/i.test(name))).toEqual([]);
      expect(JSON.stringify(type.config)).not.toMatch(/writeOnly|x-secret/);
    }
    // The shared client is bundled in, not a second copy: its own words are in the one file.
    const bundle = fs.readFileSync(path.join(installed, "dist", "anytype.cjs"), "utf8");
    expect(bundle).toContain("returned no object with an id");
    expect(bundle).not.toMatch(/require\("(?!node:|fs|readline|path)[^"]+"\)/);
  });
});

// ── each type against the fake Anytype ───────────────────────────────────────────────────

describe("each type against a fake Anytype over HTTP", () => {
  it("Create object: one object per input, named and filled from the payload, with a link", async () => {
    const anytype = await openAnytype();
    const node = startType("create-object", { space_id: SPACE, name_field: "/file/name" });
    const delivery = await send(node, { file: { name: "notes.md" }, body: "# Notes" });
    const created = emitted(delivery);
    expect(created.port).toBe("created");
    expect(created.data).toEqual({
      space_id: SPACE,
      object_id: "obj1",
      name: "notes.md",
      link: `anytype://object?objectId=obj1&spaceId=${SPACE}`,
    });
    const [request] = anytype.to("POST", `/v1/spaces/${SPACE}/objects`);
    expect(request).toMatchObject({
      authorization: `Bearer ${KEY}`,
      version: ANYTYPE_VERSION,
      body: { type_key: "page", name: "notes.md", body: "# Notes" },
    });
    // Nothing at the pointer: the static default name.
    const untitled = emitted(await send(node, { other: 1 }));
    expect(untitled.data).toMatchObject({ name: "Untitled" });
    expect(everything(node, [delivery])).not.toContain(KEY);
  });

  it("Update object: sets text, number and checkbox properties of the object the payload names", async () => {
    const anytype = await openAnytype();
    const object = anytype.put(SPACE, "Task");
    const node = startType("update-object", {
      space_id: SPACE,
      properties: [
        { key: "status", value_field: "/status" },
        { key: "hours", value_field: "/hours" },
        { key: "done", value_field: "/done" },
        { key: "absent", value_field: "/nowhere" },
      ],
    });
    const updated = emitted(
      await send(node, { object_id: object["id"], status: "open", hours: 3, done: true }),
    );
    expect(updated).toEqual({
      port: "updated",
      data: {
        space_id: SPACE,
        object_id: object["id"],
        name: "Task",
        link: `anytype://object?objectId=${String(object["id"])}&spaceId=${SPACE}`,
        properties: ["status", "hours", "done"],
      },
    });
    expect(anytype.to("PATCH", `/v1/spaces/${SPACE}/objects/`)[0]?.body).toEqual({
      properties: [
        { key: "status", text: "open" },
        { key: "hours", number: 3 },
        { key: "done", checkbox: true },
      ],
    });
    // No object id in the payload: the input fails and says where it looked.
    const missing = await send(node, { status: "open" });
    expect(missing.ends[0]?.message).toBe("the payload has no object id at /object_id");
  });

  it("Read object: the object the payload names, with its whole answer", async () => {
    const anytype = await openAnytype();
    const object = anytype.put(SPACE, "Meeting notes", "note");
    const node = startType("read-object", { space_id: SPACE, object_id_field: "/id" });
    const read = emitted(await send(node, { id: object["id"] }));
    expect(read.port).toBe("object");
    expect(read.data).toMatchObject({
      space_id: SPACE,
      object_id: object["id"],
      name: "Meeting notes",
      type_key: "note",
      object: { id: object["id"], name: "Meeting notes" },
    });
    // An object Anytype does not have: a named failure, and nothing emitted.
    const gone = await send(node, { id: "nope" });
    expect(gone.outputs).toEqual([]);
    expect(gone.ends[0]?.message).toMatch(/objects\/nope answered HTTP 404$/);
  });

  it("Read space: its objects up to the limit, of one type when filtered", async () => {
    const anytype = await openAnytype();
    anytype.put(SPACE, "one", "page");
    anytype.put(SPACE, "two", "task");
    anytype.put(SPACE, "three", "task");
    anytype.put("elsewhere", "four", "task");
    const all = startType("read-space", { space_id: SPACE, limit: "2" });
    const listed = emitted(await send(all, {}));
    expect(listed.port).toBe("objects");
    expect((listed.data as { objects: { name: string }[] }).objects.map((o) => o.name)).toEqual([
      "one",
      "two",
    ]);
    expect(anytype.to("GET", `/v1/spaces/${SPACE}/objects?`)[0]?.url).toContain("limit=2");
    const tasks = startType("read-space", { space_id: SPACE, type_filter: "task" });
    const filtered = emitted(await send(tasks, {}));
    expect(filtered.data).toMatchObject({
      type_filter: "task",
      objects: [{ name: "two" }, { name: "three" }],
    });
  });

  it("Search: one space or every space, the query set on the node or taken from the payload", async () => {
    const anytype = await openAnytype();
    anytype.put(SPACE, "Budget 2026", "page");
    anytype.put("other", "Budget draft", "task");
    const everywhere = startType("search", { query_field: "/q", types: ["page", "task"] });
    const found = emitted(await send(everywhere, { q: "budget" }));
    expect(found.port).toBe("results");
    expect(found.data).toMatchObject({
      query: "budget",
      space_id: null,
      results: [
        { name: "Budget 2026", space_id: SPACE },
        { name: "Budget draft", space_id: "other" },
      ],
    });
    expect(anytype.to("POST", "/v1/search")[0]?.body).toEqual({
      query: "budget",
      types: ["page", "task"],
    });
    const oneSpace = startType("search", { space_id: SPACE, query: "budget" });
    const inSpace = emitted(await send(oneSpace, {}));
    expect(inSpace.data).toMatchObject({ space_id: SPACE, results: [{ name: "Budget 2026" }] });
  });
});

// ── the key ──────────────────────────────────────────────────────────────────────────────

describe("the key", () => {
  it("a 401 fails the input with the pair-again message, once per input, never retried, and one notice however many inputs meet it", async () => {
    const anytype = await openAnytype();
    anytype.refuseEveryKey = true;
    const first = startType("create-object", { space_id: SPACE });
    const second = startType("read-object", { space_id: SPACE });
    const deliveries = [
      await send(first, { name: "a" }),
      await send(first, { name: "b" }),
      await send(second, { object_id: "obj9" }),
    ];
    for (const delivery of deliveries) {
      expect(delivery.outputs).toEqual([]);
      expect(delivery.ends.map((end) => end?.message)).toEqual([PAIR_AGAIN_MESSAGE]);
    }
    // Each input asked Anytype exactly once: a refused key is not tried again.
    expect(anytype.to("POST", `/v1/spaces/${SPACE}/objects`)).toHaveLength(2);
    expect(anytype.to("GET", `/v1/spaces/${SPACE}/objects/obj9`)).toHaveLength(1);
    expect(notifier.notices).toEqual([PAIR_AGAIN_NOTICE]);
    await waitFor("the red status", () =>
      first.host.statuses.some((status) => status.text === "Anytype refused the key"),
    );
    expect(everything(first, deliveries)).not.toContain(KEY);
    expect(everything(second, deliveries)).not.toContain(KEY);

    // Paired again: the next input works, and a later refusal is said again.
    anytype.refuseEveryKey = false;
    emitted(await send(first, { name: "c" }));
    anytype.refuseEveryKey = true;
    await send(first, { name: "d" });
    expect(notifier.notices).toEqual([PAIR_AGAIN_NOTICE, PAIR_AGAIN_NOTICE]);
  });

  it("is registered with the node's redactor as it is read, so a key that turns up in an error is never echoed", async () => {
    await openAnytype();
    // A payload that carries the key where an object id belongs: Anytype's 404 names the URL.
    const node = startType("read-object", { space_id: SPACE });
    const delivery = await send(node, { object_id: KEY });
    const message = delivery.ends[0]?.message ?? "";
    expect(message).toMatch(/objects\/\[redacted\] answered HTTP 404$/);
    await waitFor("the red status", () => node.host.statuses.some((s) => s.fill === "red"));
    expect(everything(node, [delivery])).not.toContain(KEY);
  });

  it("is read from the file the runtime names, at run time: none there fails the input with the pairing message, and a new one is used at once", async () => {
    const anytype = await openAnytype();
    const later = path.join(scratch, "later", "anytype_api_key");
    const node = startType(
      "create-object",
      { space_id: SPACE },
      anytypeKeyEnvironment({ file: later }),
    );
    const unpaired = await send(node, { name: "x" });
    expect(unpaired.ends[0]?.message).toBe(
      "InnyTypes is not paired with Anytype yet; pair in Settings",
    );
    expect(anytype.received).toEqual([]);
    fs.mkdirSync(path.dirname(later), { mode: 0o700 });
    fs.writeFileSync(later, KEY, { mode: 0o600 });
    emitted(await send(node, { name: "x" }));
    // Not told where a key is: not a first-party Anytype node, and it says so.
    const stranger = startType("create-object", { space_id: SPACE }, {});
    const refused = await send(stranger, { name: "x" });
    expect(refused.ends[0]?.message).toMatch(/gave this node no Anytype key file/);
  });
});

describe("what a node process is started with", () => {
  /** The environment a process really gets, built the way runtime/main.ts builds it. */
  function environmentOf(pkg: string, firstParty: boolean): Record<string, string> {
    const secretFiles = {
      "anytype-api-key": { file: keyFile },
      "mcp-proxy-token": { file: path.join(scratch, "config", "mcp_proxy_token") },
    };
    const env = minimalEnvironment(process.env, anytypeKeyVariables(pkg, firstParty, secretFiles));
    const printed = execFileSync(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      {
        env,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    return JSON.parse(printed) as Record<string, string>;
  }

  it("only the first-party Anytype package's processes get the key's path; none gets the proxy token's, or any key", () => {
    const anytypeNode = environmentOf("anytype", true);
    expect(anytypeNode["INNYTYPES_ANYTYPE_KEY_FILE"]).toBe(keyFile);
    for (const [pkg, firstParty] of [
      ["anytype", false],
      ["monty", true],
      ["folderflow", true],
      ["viewts", false],
    ] as const) {
      const other = environmentOf(pkg, firstParty);
      expect(Object.keys(other).filter((name) => name.includes("ANYTYPE"))).toEqual([]);
      expect(JSON.stringify(other)).not.toContain(keyFile);
    }
    for (const env of [anytypeNode, environmentOf("monty", true)]) {
      expect(JSON.stringify(env)).not.toContain("mcp_proxy_token");
      expect(JSON.stringify(env)).not.toContain(KEY);
    }
  });
});
