// ui/strings.ts (plan 0022 §O): every ux-writing.md line has a key, no line carries an internal,
// the slots fill as typed, and the sentences the runtime words for the canvas are the same words.
import fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import * as flows from "../../src/application/flows";
import * as options from "../../src/domain/forms/node-options";
import { plural, sentence, STRINGS, t, type StringKey } from "../../src/ui/strings";

const UX_WRITING = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "docs",
  "ux",
  "ux-writing.md",
);

/** The two keys whose slot carries an internal value on purpose (plan 0022 §O). */
const MAY_CARRY_AN_INTERNAL: readonly StringKey[] = [
  "general.aiApps.line",
  "packages.fromFolder.caption",
];

/** Each pattern of an internal the person must never see, with an example it must catch. */
const INTERNALS: readonly (readonly [string, RegExp, string])[] = [
  [
    "a UUID",
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
    "run 3f2a9c1e-0b7d-4c4e-9a51-1d2e3f4a5b6c",
  ],
  [
    "an id of 8 or more hex digits",
    /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/i,
    "input 8f2c0a9d",
  ],
  ["a pid", /\bpid\b|\bprocess \d+/i, "child pid 4242"],
  [
    "a port",
    /\b(?:127\.0\.0\.1|localhost)(?::\d+)?\b|:\d{2,5}\b|\bport \d+/i,
    "ECONNREFUSED 127.0.0.1:31009",
  ],
  [
    "a path",
    /(?:^|[\s(*`"])(?:~|\.{1,2})?\/[\w.-]+\/|[A-Z]:\\|\.(?:json|ts|js|py|sqlite)\b/,
    "no key in /Users/me/anytype_api_key",
  ],
  ["a type key", /\binny-[a-z0-9-]+|\buser\.[a-z0-9_]+\.v\d+/i, "inny-innyrize-diarize"],
  [
    "a package-internal name",
    /\b(?:node-?red|utilityProcess|services process|mcp child|journal|sqlite|generation \d+|innyrize-[a-z]+|monty-[a-z]+|anytype-mcp)\b/i,
    "innyrize-diarize (n1): 71%",
  ],
];

describe("no string carries an internal", () => {
  it.each(INTERNALS.map(([name, pattern, example]) => [name, pattern, example] as const))(
    "the %s pattern catches its example",
    (_name, pattern, example) => {
      expect(example).toMatch(pattern);
    },
  );

  it("no template matches any pattern, apart from the two keys that may", () => {
    const found: string[] = [];
    for (const [key, template] of Object.entries(STRINGS)) {
      if (MAY_CARRY_AN_INTERNAL.includes(key as StringKey)) {
        continue;
      }
      for (const [name, pattern] of INTERNALS) {
        if (pattern.test(template)) {
          found.push(`${key}: ${name} in ${JSON.stringify(template)}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("the two exceptions exist and carry their internal only in a slot", () => {
    expect(STRINGS["general.aiApps.line"]).toContain("`{address}`");
    expect(STRINGS["packages.fromFolder.caption"]).toBe("From a folder: *{path}*");
  });
});

/** ux-writing's quoted, bold and bracketed words from "Navigation and page titles" on. */
function uxWritingLines(): string[] {
  const text = fs.readFileSync(UX_WRITING, "utf8");
  const body = text.slice(text.indexOf("## Navigation and page titles")).replace(/\s+/g, " ");
  const found = [
    ...[...body.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? ""),
    ...[...body.matchAll(/\*\*([^*|"]{1,60})\*\*/g)].map((match) => match[1] ?? ""),
    ...[...body.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1] ?? ""),
  ];
  return [...new Set(found.map((line) => line.replace(/\*\*/g, "").trim()))].filter(
    (line) => line !== "",
  );
}

/**
 * Words ux-writing quotes that are not the app's own lines: the doc's own labels, the flows' and
 * steps' data (a recording's name, a note a step wrote, a result line, an answer's choices), and
 * lines ui/words.ts composes from several keys (held by the wording fixture row by row).
 */
const NOT_A_LINE: ReadonlySet<string> = new Set([
  // The doc's own labels for its sections.
  "Card title:",
  "Step line",
  "One card per source event, per flow",
  "The Done badge.",
  "Result lines.",
  "Result actions",
  "In a notification",
  "In a pop-out window:",
  "Anytype:",
  "Recorders and folders:",
  "Start at login:",
  "Packages:",
  "Update:",
  "Advanced:",
  "Top of the board:",
  "The Setup sidebar",
  "Step n of N",
  "Edit layout:",
  "New flow ▾ → From a template",
  "← Flows", // the arrow is an icon; the words are history.back
  "New flow ▾",
  "⋯",
  "remove",
  "checked *when*",
  // Data: what a step wrote, what a flow did, a question's choices, a recording's name.
  "Speaker 3 was not named",
  "Summary shortened to fit the type's limit",
  "Sent to *Fritte Reinvention* without approval: the approval step is off",
  "Transcription used the fallback model",
  "Meeting notes → *Renaissance*",
  "Customer brief → *Fritte Reinvention*",
  "Follow up on pricing · due Thursday",
  "Moved recording to *Archive*",
  "Deleted the recording",
  "Sent the summary to *Fritte Reinvention*",
  "Summarise again",
  "Send to *space*",
  "Re-run from transcription",
  "Who is speaker 2?",
  "Send the customer brief to *Fritte Reinvention*?",
  "Which customer is this?",
  "*2026-09-27 client call*",
  "Marie-Lise",
  "Valerie",
  "Fritte",
  "Renaissance",
  "BOYA · watching",
  "Recordings to Anytype: transcribe, summarise, file, approve, send, schedule.",
  "Mistral refused the key. Check the key in the *Transcribe* step.",
  "Tuesday",
  "Tuesday 14:20",
  "Delete 3 runs? …",
  // Composed by ui/words.ts from several keys; the wording fixture holds each sentence.
  "*2026-09-27 client call* · 48 min",
  "Copying from BOYA…",
  "Transcribing, about 12 minutes left.",
  "Summarising (2 of 3).",
  "Filing in *Renaissance*…",
  "Waiting for you: who spoke?",
  "Waiting for you: send to *Fritte Reinvention*?",
  "Failed at *Transcribe*: Mistral refused the key. Check the key in the *Transcribe* step.",
  "Resumed after restart.",
  "Done. 3 summaries in *Renaissance*, 2 next steps scheduled.",
  "Done. Recording moved to *Archive*.",
  "Failed at *Transcribe*: Mistral refused the key.",
  "Couldn't check for updates: no connection. Last checked Monday.",
  "Can't unregister *innyrize*: the flow *Recordings to Anytype* uses its *Transcribe* step. Remove that step first.",
  "4 installed · 1 update",
  "Run history",
  "Copy setup for Codex",
  "Go back to 0.2.1",
  "Go back to 0.3",
  // Names of states and words a person reads elsewhere under a key of their own.
  "Transcribing",
  "Summarising",
  "Filing",
]);

/**
 * Setup lines owner decisions 1 and 8 removed: no "Choose your packages" step, no "Start with a
 * simple flow?" choice. ux-writing is being updated in parallel, so these are tolerated whether
 * or not it still quotes them, and strings.ts must not hold them.
 */
const REMOVED_BY_THE_OWNER: ReadonlySet<string> = new Set([
  "Choose your packages",
  "These come with InnyTypes. Each one adds steps you can use in your flows. You can add others later in Configuration › General.",
  "*anytype*: files notes, tasks and links in Anytype.",
  "*monty*: watches your recorder and folders.",
  "*innyrize*: transcribes and tells who spoke.",
  "Start with a simple flow?",
  "InnyTypes can install a ready-made flow now: your recordings are transcribed, summarised and filed. You can change every step later. Or build your own from scratch.",
  "Install the simple flow",
]);

/** A template as a pattern: each slot matches any words, the rest matches as written. */
const asPattern = (template: string) =>
  new RegExp(
    `^${template
      .replace(/[.*+?^$()|[\]\\]/g, "\\$&")
      .replace(/\\\{[a-zA-Z]+\\\}|\{[a-zA-Z]+\}/g, ".+?")}$`,
  );

/**
 * A template that is mostly slots ("{day} {time}", "{list} and {last}") would match almost any
 * line, so one that starts and ends with a slot, or has fewer than two letters of its own, cannot
 * account for a line.
 */
const ownLetters = (template: string) =>
  template.replace(/\{[a-zA-Z]+\}/g, "").replace(/[^\p{L}]/gu, "").length;
const PATTERNS = Object.values(STRINGS)
  .filter(
    (template) => ownLetters(template) >= 2 && !/^\{[a-zA-Z]+\}.*\{[a-zA-Z]+\}$/.test(template),
  )
  .map((template) => asPattern(template));
const matches = (line: string) =>
  PATTERNS.some((pattern) => pattern.test(line) || pattern.test(line.replace(/\*/g, "")));
/** A dialog's title and body, quoted together by ux-writing: two keys. */
const matchesTwo = (line: string) =>
  [...line.matchAll(/[.?] /g)].some((boundary) => {
    const at = boundary.index + 1;
    return matches(line.slice(0, at)) && matches(line.slice(at + 1));
  });

describe("strings.ts holds every ux-writing.md line", () => {
  it("each quoted, bold or bracketed line is a template, or is listed as not a line", () => {
    const missing = uxWritingLines().filter(
      (line) =>
        !NOT_A_LINE.has(line) &&
        !REMOVED_BY_THE_OWNER.has(line) &&
        !matches(line) &&
        !matchesTwo(line),
    );
    expect(missing).toEqual([]);
  });

  it("holds none of the Setup lines the owner removed", () => {
    expect([...REMOVED_BY_THE_OWNER].filter((line) => matches(line))).toEqual([]);
  });

  it("lists as not a line only what ux-writing really quotes", () => {
    const lines = new Set(uxWritingLines());
    expect([...NOT_A_LINE].filter((line) => !lines.has(line))).toEqual([]);
  });
});

describe("the words the runtime gives the canvas are the same", () => {
  it("flow refusals", () => {
    expect(STRINGS["flows.refused.dirty"]).toBe(flows.DIRTY_SENTENCE);
    expect(STRINGS["flows.refused.loading"]).toBe(flows.LOADING_SENTENCE);
    expect(STRINGS["flows.refused.gone"]).toBe(flows.GONE_SENTENCE);
    expect(STRINGS["flows.refused.name"]).toBe(flows.NAME_SENTENCE);
    expect(STRINGS["flows.refused.noTemplate"]).toBe(flows.NO_TEMPLATE_SENTENCE);
    expect(STRINGS["flows.refused.noStep"]).toBe(flows.NO_STEP_SENTENCE);
    expect(STRINGS["flows.refused.noForm"]).toBe(flows.NO_FORM_SENTENCE);
  });

  it("a step form's options", () => {
    expect(STRINGS["form.notPaired"]).toBe(options.NOT_PAIRED_SENTENCE);
    expect(STRINGS["form.unreachable"]).toBe(options.UNREACHABLE_SENTENCE);
    expect(STRINGS["form.unavailable"]).toBe(options.UNAVAILABLE_SENTENCE);
    expect(STRINGS["form.readingSpaces"]).toBe(options.READING_SPACES);
    expect(STRINGS["form.readingTypes"]).toBe(options.READING_TYPES);
  });
});

describe("filling a line", () => {
  it("fills every slot", () => {
    expect(t("setup.form.progress", { step: 3, of: 7 })).toBe("Step 3 of 7.");
    expect(t("nav.live")).toBe("Live");
  });

  it("picks one or other by the count", () => {
    expect(plural(1, "flows.health.notSetUp")).toBe("1 step not set up");
    expect(plural(2, "flows.health.notSetUp")).toBe("2 steps not set up");
    expect(plural(3, "history.selected")).toBe("3 runs selected");
  });

  it("words a Sentence that crossed IPC, and leaves an unfilled slot as written", () => {
    expect(sentence({ key: "flows.refused.dirty" })).toBe(flows.DIRTY_SENTENCE);
    expect(sentence({ key: "error.formIncomplete", params: { step: "*Summarise*" } })).toBe(
      "**Summarise** isn't set up yet: {what}.",
    );
  });
});
