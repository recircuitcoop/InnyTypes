// The TypeScript SDK reference node (WI-0018-26): built on @innytypes/node
// (sdk/ts/src/node.ts), not a raw hand-rolled speaker of the protocol like the viewts/
// folderflow/popoutkit fixtures. Node's standard library only, run as-is by a Node that
// strips types (Node 22.18+, or Electron as Node); it is not meant to be built.
//
// Three types, chosen by argv[2] (the runtime always calls with this fixed, spec 2.3.1):
// - kitchen (a node): the same do-dispatched actions as the raw fixture (rawnode), wired
//   through emit/done/error/status/log instead of hand-built frames, so both conformance
//   suites read the same way.
// - ask (an action view): present, then answer or dismiss (C10).
// - record (a snapshot view): snapshot, pass through, and answer a trigger (C11).

import {
  declarePorts,
  done,
  emit,
  error,
  log,
  present,
  progress,
  run,
  snapshot,
  start,
  status,
  type DoneNote,
  type DoneResult,
} from "../../../../sdk/ts/src/node.ts";

/** A string that makes an `emit {port: out, in: inputId}` frame exactly `size` bytes. */
function sizedValue(inputId: string, size: number): string {
  const overhead = Buffer.byteLength(
    JSON.stringify({ t: "emit", port: "out", data: "", in: inputId }),
    "utf8",
  );
  return "x".repeat(size - overhead);
}

async function runKitchen(): Promise<void> {
  declarePorts(["out"]);
  const info = await start();
  const cancels = new Map<string, () => void>();

  await run({
    input: async (id, event) => {
      const data = (event.data ?? {}) as Record<string, unknown>;
      const action = typeof data["do"] === "string" ? data["do"] : "echo";
      if (action === "echo") {
        emit("out", data["value"], id);
        done(id);
      } else if (action === "burst") {
        const frames = data["frames"] as number;
        const threads = data["threads"] as number;
        const each = Math.floor(frames / threads);
        // No real threads in JS: each "thread" runs to completion in turn. What C2 checks
        // here (every frame present, uniquely) still holds; only the interleaving risk,
        // which cannot arise in a single-threaded writer, does not apply.
        for (let thread = 0; thread < threads; thread += 1) {
          for (let n = 0; n < each; n += 1) {
            emit("out", { thread, n }, id);
          }
        }
        done(id);
      } else if (action === "sized") {
        emit("out", sizedValue(id, data["bytes"] as number), id);
        done(id);
      } else if (action === "undeclared") {
        emit("nope", 1, id); // throws: the SDK refuses at the call site (C5)
        done(id); // unreachable
      } else if (action === "new-run") {
        emit("out", data["value"]); // no input id: a new run (spec 5.4.2)
        done(id);
      } else if (action === "twice") {
        done(id);
        done(id);
      } else if (action === "fail") {
        error(id, typeof data["message"] === "string" ? data["message"] : "failed");
      } else if (action === "report") {
        // Revision 2.1 (spec 4.2.1): notes and results on done, through the SDK.
        done(id, {
          ...(Array.isArray(data["notes"]) ? { notes: data["notes"] as DoneNote[] } : {}),
          ...(Array.isArray(data["results"]) ? { results: data["results"] as DoneResult[] } : {}),
        });
      } else if (action === "progress") {
        // Revision 2.1 (spec 4.2.2): a status naming this input, then its done.
        const etaS = typeof data["eta_s"] === "number" ? data["eta_s"] : undefined;
        const text = typeof data["text"] === "string" ? data["text"] : undefined;
        progress(id, data["done"] as number, data["total"] as number, etaS, text);
        done(id);
      } else if (action === "slow") {
        status("working", "blue", "dot");
        const cancelled = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 10_000);
          cancels.set(id, () => {
            clearTimeout(timer);
            resolve(true);
          });
        });
        cancels.delete(id);
        if (cancelled) {
          error(id, "cancelled while running");
        } else {
          done(id);
        }
      } else if (action === "credential") {
        // start() already protected every credential value (spec 11.1): even a handler
        // that logs it outright never leaks it (C13).
        const token = info.credentials["token"] ?? "";
        emit("out", token.length, id);
        log(`used a credential: ${token}`);
        done(id);
      } else if (action === "noise") {
        // console.log is redirected to stderr, redacted, once the SDK has started (C3): it
        // never reaches the frame channel the runtime decodes.
        console.log("this is not a frame"); // eslint-disable-line no-console -- the thing under test
        log("a log frame", "warn");
        error(undefined, "an error of no input");
        done(id);
      } else if (action === "crash") {
        process.exit(typeof data["code"] === "number" ? data["code"] : 3);
      } else if (action === "done-then-crash") {
        done(id);
        process.exit(4);
      } else {
        error(id, `unknown action ${JSON.stringify(action)}`);
      }
    },
    cancel: (id) => {
      cancels.get(id)?.();
    },
    fire: (data) => {
      emit("out", data); // no input id: a new run (C12, spec 4.1 fire)
    },
  });
}

async function runAsk(): Promise<void> {
  declarePorts(["answer"]);
  await start();
  await run({
    input: (id, event) => {
      present(id, {
        title: "Answer the TypeScript SDK view",
        text: JSON.stringify(event.data),
        form: { type: "object", properties: { answer: { type: "string" } } },
      });
    },
    action: (id, values) => {
      if (values["__dismiss__"] === true) {
        error(id, "dismissed by the person");
      } else {
        emit("answer", values, id);
        done(id);
      }
    },
  });
}

async function runRecord(): Promise<void> {
  declarePorts(["passed", "again"]);
  await start();
  await run({
    input: (id, event) => {
      const data = event.data;
      snapshot(
        { title: "Recorded by the TypeScript SDK", fields: { data: JSON.stringify(data) } },
        data,
        id,
      );
      emit("passed", data, id);
      done(id);
    },
    trigger: (action, triggerSnapshot, values) => {
      emit(action, { state: triggerSnapshot.state, values });
    },
  });
}

const kind = process.argv[2];
const runners: Record<string, () => Promise<void>> = {
  kitchen: runKitchen,
  ask: runAsk,
  record: runRecord,
};
const runner = kind === undefined ? undefined : runners[kind];
if (runner === undefined) {
  process.stderr.write(`unknown sdk-ts type ${JSON.stringify(kind)}\n`);
  process.exit(2);
} else {
  void runner();
}
