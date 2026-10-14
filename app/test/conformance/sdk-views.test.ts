// Conformance C10 (action view) and C11 (snapshot view) of spec §12.2, against the two SDKs'
// reference view types: sdk-py's ask/record (Python, innytypes-node) and sdk-ts's ask/record
// (TypeScript, @innytypes/node). Unlike app/test/conformance/views.test.ts, which runs the
// SAME two tests against hand-rolled view nodes that share no code with any SDK, these run
// through Node.present/emit/done/error (Python) and present/emit/done/error (TypeScript) --
// the SDK's own surface, not frames built by hand. C24 (plan 0020) drives the same ask view
// to present media items, an audio sample among them, and checks the runtime gets them intact.
// C16 (plan 0021) has it present a widget with its props, drawn by a widget written with the
// TypeScript SDK's defineView, whose structured answer the runtime's judgement accepts and the
// node emits unchanged. The sandbox itself is proven by app/test/e2e/app-pages.e2e.ts "widget
// views"; here the page's part (handing the element its view, calling `answer()`) is played
// against a stand-in for the browser's custom elements.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodeFrame,
  encodeFrame,
  LineReader,
  type Decoded,
  type NodeFrame,
  type RuntimeFrame,
} from "../../src/adapters/process/codec";
import { AjvSchemaValidator } from "../../src/adapters/schema/ajv-validator";
import { boundsProblem, propsProblem } from "../../src/domain/views/answers";
import { boundedContent } from "../../src/domain/views/views";
import { defineView } from "../../../sdk/ts/src/view";
import { rawNodeEnv, waitFor } from "../fixtures/raw-node/fixture";
import { sdkCommand, SDK_LANGUAGES, type SdkLanguage } from "../fixtures/sdk-nodes";

/** A sample's source: the opening bytes of a WAV file. Intact transport is what C24 checks,
 * not playback, so the bytes need not decode. */
const WAV = `data:audio/wav;base64,${Buffer.from("RIFF$\u0000\u0000\u0000WAVEfmt ").toString("base64")}`;

/** C24's media: an image, a labelled `data:` sample, an unlabelled package-file sample, and a
 * 600 KiB sample (under the 768 KiB bound, and with the rest under the 1 MiB frame bound). */
const MEDIA = [
  { type: "image", src: "pixel.png", alt: "one pixel" },
  { kind: "audio", src: WAV, label: "Listen to speaker 2" },
  { kind: "audio", src: "speaker-2.ogg" },
  { kind: "audio", src: `data:audio/ogg;base64,${"T2dn".repeat((600 * 1024) / 4)}` },
];

/** C16's widget type: its props, and its answer, an array of objects three levels deep. */
const C16_PROPS = {
  type: "object",
  properties: { items: { type: "array", items: { type: "string" } } },
  required: ["items"],
};
const C16_ANSWER = {
  type: "object",
  properties: {
    order: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          rank: { type: "integer" },
          tags: { type: "array", items: { type: "object" } },
        },
        required: ["name", "rank", "tags"],
      },
    },
  },
  required: ["order"],
  additionalProperties: false,
};

interface C16Props {
  readonly items: readonly string[];
}
interface C16Answer {
  readonly order: readonly {
    readonly name: string;
    readonly rank: number;
    readonly tags: readonly { readonly level: number }[];
  }[];
}

/** A drawn widget, as the pop-out page holds it: handed its view, then asked to answer. */
interface DrawnWidget {
  view: unknown;
  connectedCallback(): void;
  answer(): Promise<unknown>;
}

/**
 * Define C16's widget with defineView against a stand-in for the browser (the custom element
 * registry, HTMLElement and the bridge's two widget calls), and draw it handed `view`, as the
 * pop-out page does (ui/view/view-page.ts drawWidget). What it called on the bridge is kept.
 */
function drawC16Widget(view: unknown): {
  widget: DrawnWidget;
  valid: boolean[];
  drafts: unknown[];
} {
  const defined = new Map<string, new () => DrawnWidget>();
  const valid: boolean[] = [];
  const drafts: unknown[] = [];
  // HTMLElement's stand-in: the widget is connected by calling connectedCallback, as a
  // document would once the page appends it.
  vi.stubGlobal(
    "HTMLElement",
    class {
      readonly isConnected = true;
    },
  );
  vi.stubGlobal("customElements", {
    define: (name: string, constructor: new () => DrawnWidget) => defined.set(name, constructor),
  });
  vi.stubGlobal("window", {
    inny: {
      setValid: (value: boolean) => valid.push(value),
      draft: (values: unknown) => {
        drafts.push(values);
        return Promise.resolve({ ok: true, value: null });
      },
    },
  });
  // The person's order is the reverse of the props', each name ranked and tagged: what an
  // ordering widget keeps as its draft while the person works, and answers with on Continue.
  defineView<C16Props, C16Answer>("c16-order", {
    render: (context) => {
      const order = [...context.props.items]
        .reverse()
        .map((name, rank) => ({ name, rank, tags: [{ level: rank + 1 }] }));
      void context.saveDraft({ order });
      context.setValid(order.length > 0);
    },
    answer: (context) => context.draft ?? { order: [] },
  });
  const Widget = defined.get("c16-order");
  if (Widget === undefined) {
    throw new Error("defineView defined no c16-order");
  }
  const widget = new Widget();
  widget.view = view;
  widget.connectedCallback();
  return { widget, valid, drafts };
}

/** The runtime's side of one conversation with an SDK reference view node. */
class Session {
  readonly child: ChildProcessWithoutNullStreams;
  readonly decoded: Decoded[] = [];
  stderr = "";

  constructor(language: SdkLanguage, typeId: "ask" | "record") {
    const { argv, cwd } = sdkCommand(language, typeId);
    this.child = spawn(argv[0] as string, argv.slice(1), {
      cwd,
      env: rawNodeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = new LineReader();
    this.child.stdout.on("data", (chunk: Buffer) => {
      for (const line of lines.push(chunk)) {
        if (line.kind === "line") {
          this.decoded.push(decodeFrame(line.bytes));
        }
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
    });
    this.send({
      t: "start",
      protocol: 2,
      node: { id: "conformance", type: `inny-sdk${language}-${typeId}`, name: "" },
      config: {},
      credentials: {},
      data_dir: "/nonexistent-data-dir",
    });
  }

  send(frame: RuntimeFrame): void {
    this.child.stdin.write(encodeFrame(frame));
  }

  get frames(): NodeFrame[] {
    return this.decoded.flatMap((decoded) => (decoded.kind === "frame" ? [decoded.frame] : []));
  }

  get rejected(): Decoded[] {
    return this.decoded.filter((decoded) => decoded.kind !== "frame");
  }

  /** The frames about input `id`, in order, `ready` and new-run emits left out. */
  about(id: string): NodeFrame[] {
    return this.frames.filter((frame) => "in" in frame && frame.in === id);
  }
}

const sessions: Session[] = [];

function session(language: SdkLanguage, typeId: "ask" | "record"): Session {
  const opened = new Session(language, typeId);
  sessions.push(opened);
  return opened;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const opened of sessions.splice(0)) {
    opened.child.kill("SIGKILL");
  }
});

describe.each(SDK_LANGUAGES)("conformance: the %s SDK's reference view node", (language) => {
  it("C10 action view: present, then action, gives emit {in} + done; __dismiss__ gives error", async () => {
    const node = session(language, "ask");
    node.send({ t: "input", id: "i1", event: { type: "t.v1", data: { n: 1 }, run: "r1" } });
    await waitFor("present", () => node.about("i1").length === 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(node.about("i1")).toEqual([
      {
        t: "present",
        in: "i1",
        content: expect.objectContaining({ title: expect.any(String) as unknown }) as unknown,
      },
    ]);

    node.send({ t: "action", in: "i1", values: { answer: "yes" } });
    await waitFor("done", () => node.about("i1").length === 3);
    expect(node.about("i1").slice(1)).toEqual([
      { t: "emit", port: "answer", data: { answer: "yes" }, in: "i1" },
      { t: "done", in: "i1" },
    ]);

    node.send({ t: "input", id: "i2", event: { type: "t.v1", data: { n: 2 } } });
    await waitFor("present", () => node.about("i2").length === 1);
    node.send({ t: "action", in: "i2", values: { __dismiss__: true } });
    await waitFor("error", () => node.about("i2").length === 2);
    expect(node.about("i2")[1]).toEqual({
      t: "error",
      in: "i2",
      message: "dismissed by the person",
    });
    expect(node.rejected).toEqual([]);
    expect(node.stderr).not.toMatch(/Traceback|Error:/);
  });

  it("C24 audio media: present carries image and audio items, and the runtime receives them intact", async () => {
    const node = session(language, "ask");
    node.send({ t: "input", id: "m1", event: { type: "t.v1", data: { media: MEDIA } } });
    await waitFor("present", () => node.about("m1").length === 1);
    const [presented] = node.about("m1");
    expect(presented).toEqual({
      t: "present",
      in: "m1",
      content: expect.objectContaining({ media: MEDIA }) as unknown,
    });
    // What the runtime does with it (spec 8.1.4): nothing is under the bound to refuse, so the
    // content it keeps and presents is the content the SDK sent.
    if (presented?.t !== "present") {
      throw new Error("C24: no present frame");
    }
    expect(boundedContent(presented.content)).toEqual({ content: presented.content, refused: 0 });
    expect(node.rejected).toEqual([]);
    expect(node.stderr).not.toMatch(/Traceback|Error:/);
  });

  it("C16 structured submit: a widget written with defineView, handed the props this SDK presents, answers nested JSON the runtime accepts, and the node emits it unchanged", async () => {
    const node = session(language, "ask");
    const component = { element: "c16-order", props: { items: ["Ada", "Grace", "Linus"] } };
    node.send({ t: "input", id: "w1", event: { type: "t.v1", data: { component } } });
    await waitFor("present", () => node.about("w1").length === 1);
    const [presented] = node.about("w1");
    if (presented?.t !== "present") {
      throw new Error("C16: no present frame");
    }
    expect(presented.content).toEqual(expect.objectContaining({ component }));

    // The runtime judges the props at present (spec 8.1.5), by the bounds and the props schema.
    const validator = new AjvSchemaValidator();
    expect(
      propsProblem(presented.content, (props) =>
        validator.firstFailure(C16_PROPS, props) === null ? null : "refused",
      ),
    ).toBeNull();

    // The page hands the widget its view, the props and no draft with it (spec 8.5.6).
    const view = { kind: "view", id: "w1", content: presented.content, draft: null };
    const { widget, valid, drafts } = drawC16Widget(view);
    const expected = {
      order: [
        { name: "Linus", rank: 0, tags: [{ level: 1 }] },
        { name: "Grace", rank: 1, tags: [{ level: 2 }] },
        { name: "Ada", rank: 2, tags: [{ level: 3 }] },
      ],
    };
    expect(valid).toEqual([true]);
    expect(drafts).toEqual([expected]);

    // Continue: the widget's answer, judged as the runtime judges every answer (spec 8.5.7).
    const values = (await widget.answer()) as Record<string, unknown>;
    expect(values).toEqual(expected);
    expect(boundsProblem(values)).toBeNull();
    expect(validator.firstFailure(C16_ANSWER, values)).toBeNull();

    node.send({ t: "action", in: "w1", values });
    await waitFor("done", () => node.about("w1").length === 3);
    expect(node.about("w1").slice(1)).toEqual([
      { t: "emit", port: "answer", data: expected, in: "w1" },
      { t: "done", in: "w1" },
    ]);
    expect(node.rejected).toEqual([]);
    expect(node.stderr).not.toMatch(/Traceback|Error:/);
  });

  it("C11 snapshot view: snapshot + pass-through emit + done; trigger gives emit with no in on the action port", async () => {
    const node = session(language, "record");
    node.send({ t: "input", id: "s1", event: { type: "t.v1", data: { n: 7 } } });
    await waitFor("done", () => node.about("s1").some((frame) => frame.t === "done"));
    expect(node.about("s1")).toEqual([
      { t: "snapshot", content: expect.any(Object) as unknown, state: { n: 7 }, in: "s1" },
      { t: "emit", port: "passed", data: { n: 7 }, in: "s1" },
      { t: "done", in: "s1" },
    ]);

    node.send({
      t: "trigger",
      action: "again",
      snapshot: { id: "snap-1", state: { n: 7 } },
      values: { why: "again" },
    });
    const newRun = (): NodeFrame[] =>
      node.frames.filter((frame) => frame.t === "emit" && !("in" in frame));
    await waitFor("the triggered emit", () => newRun().length === 1);
    expect(newRun()).toEqual([
      { t: "emit", port: "again", data: { state: { n: 7 }, values: { why: "again" } } },
    ]);
    expect(node.rejected).toEqual([]);
  });
});
