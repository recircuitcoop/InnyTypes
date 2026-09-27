// adapters/nodered/examples.ts: silencing @node-red/registry's own missing-examples failure
// (plan 0018 §8.3 WI-0018-23; arch_pivot §5 finding 9), without hiding anything else.
//
// Measured against a real packaged build, the failure is a *synchronous* Error from Electron's
// asar-aware fs (an uncaughtException), not the plain `fs.promises.readdir` ENOENT rejection
// development's real filesystem produces (an unhandledRejection) — so both are exercised here.

import { describe, expect, it } from "vitest";
import {
  guardMissingExamplesFailure,
  isMissingExamplesFailure,
} from "../../src/adapters/nodered/examples";

/** The exact message shape Electron's asar-aware fs produced for a packaged build. */
const ASAR_MESSAGE =
  "ENOENT, node_modules/@node-red/nodes/examples not found in " +
  "/Applications/InnyTypes.app/Contents/Resources/app.asar";

/** The plain Node shape a real filesystem (development) produces. */
function enoentError(path: string): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: no such file or directory, scandir '${path}'`);
  return Object.assign(error, { code: "ENOENT", path });
}

describe("isMissingExamplesFailure", () => {
  it("recognises the packaged app's asar-aware fs error", () => {
    expect(isMissingExamplesFailure(new Error(ASAR_MESSAGE))).toBe(true);
  });

  it("recognises development's plain Node ENOENT for the same folder too, by message content", () => {
    // Development's real filesystem would only ever reject if the folder really were absent
    // there too, but the matcher does not care which fs produced the message — only that it
    // names this exact folder as missing.
    expect(
      isMissingExamplesFailure(enoentError("/repo/node_modules/@node-red/nodes/examples")),
    ).toBe(true);
  });

  it("is not fooled by an unrelated ENOENT, or a non-Error value", () => {
    expect(isMissingExamplesFailure(enoentError("/some/other/path"))).toBe(false);
    expect(isMissingExamplesFailure(new Error("ENOENT, examples not found in nowhere"))).toBe(
      false,
    );
    expect(isMissingExamplesFailure("a string, not an Error")).toBe(false);
    expect(isMissingExamplesFailure(null)).toBe(false);
  });
});

describe("guardMissingExamplesFailure", () => {
  it("silences the exact known failure as an uncaughtException, and calls back once", () => {
    let silenced = 0;
    guardMissingExamplesFailure(() => {
      silenced += 1;
    });
    process.emit("uncaughtException", new Error(ASAR_MESSAGE));
    expect(silenced).toBe(1);
  });

  it("silences the exact known failure as an unhandledRejection", async () => {
    let silenced = 0;
    guardMissingExamplesFailure(() => {
      silenced += 1;
    });
    const rejected = Promise.reject(new Error(ASAR_MESSAGE));
    process.emit("unhandledRejection", new Error(ASAR_MESSAGE), rejected);
    await rejected.catch(() => {});
    expect(silenced).toBe(1);
  });

  it("re-raises any other uncaughtException instead of silencing it", () => {
    let silenced = 0;
    const listeners = process.listeners("uncaughtException");
    guardMissingExamplesFailure(() => {
      silenced += 1;
    });
    const added = process.listeners("uncaughtException").filter((l) => !listeners.includes(l));
    expect(added).toHaveLength(1);
    expect(() => added[0]?.(new Error("a real bug"), "uncaughtException")).toThrow("a real bug");
    expect(silenced).toBe(0);
  });
});
