// The telemetry question and switch on the app page (WI-0018-22), through AppApi and no DOM: asked
// with its notice while unanswered, closed by an answer, and the Settings switch answering too.
import { describe, expect, it } from "vitest";
import type { AppApi, TelemetryStatus } from "../../src/ui/contract";
import type { PageEvent, Section } from "../../src/ui/pages/page";
import { mountTelemetry, questionHtml, switchHtml } from "../../src/ui/pages/telemetry";

class FakeSection implements Section {
  readonly listeners: ((event: PageEvent) => void)[] = [];
  innerHTML = "";
  hidden = true;
  on(_type: "click" | "submit", listener: (event: PageEvent) => void): void {
    this.listeners.push(listener);
  }
  click(attributes: Record<string, string>): void {
    for (const listener of this.listeners) {
      listener({
        target: { getAttribute: (name: string) => attributes[name] ?? null },
        preventDefault: () => undefined,
      });
    }
  }
}

const settle = async (): Promise<void> => {
  for (let n = 0; n < 10; n += 1) {
    await Promise.resolve();
  }
};

const STATUS: TelemetryStatus = {
  answer: "unset",
  question: "Send <reports>?",
  notice: "Line one.\n\nLine <two>.",
  problem: null,
  queued: 0,
};

function world(first: TelemetryStatus) {
  let current = first;
  const calls: unknown[] = [];
  let failing: Error | null = null;
  const api = {
    telemetry: () => Promise.resolve(current),
    setTelemetry: (on: boolean) => {
      calls.push(on);
      if (failing !== null) {
        return Promise.reject(failing);
      }
      current = { ...current, answer: on ? "on" : "off" };
      return Promise.resolve(current);
    },
  } as unknown as AppApi;
  const dom = {
    question: new FakeSection(),
    settings: new FakeSection(),
    message: { innerHTML: "" },
  };
  return {
    dom,
    calls,
    refresh: mountTelemetry(dom, api),
    fail: (error: Error) => {
      failing = error;
    },
  };
}

describe("the telemetry question", () => {
  it("the question carries the privacy notice, escaped, and both answers", () => {
    const html = questionHtml(STATUS);
    expect(html).toContain("Send &lt;reports&gt;?");
    expect(html).toContain("<p>Line one.</p><p>Line &lt;two&gt;.</p>");
    expect(html).toContain('data-telemetry="on"');
    expect(html).toContain('data-telemetry="off"');
    expect(questionHtml({ ...STATUS, answer: "off" })).toBe("");
  });

  it("is shown while unanswered, and an answer closes it", async () => {
    const { dom, calls, refresh } = world(STATUS);
    await refresh();
    expect(dom.question.hidden).toBe(false);
    expect(dom.question.innerHTML).toContain("telemetry-notice");
    dom.question.click({ "data-telemetry": "on" });
    await settle();
    expect(calls).toEqual([true]);
    expect(dom.question.hidden).toBe(true);
    expect(dom.question.innerHTML).toBe("");
    expect(dom.settings.innerHTML).toContain('data-testid="settings-telemetry-state">on</span>');
  });

  it("the telemetry switch answers the question too", async () => {
    const { dom, calls, refresh } = world(STATUS);
    await refresh();
    expect(dom.settings.innerHTML).toContain(">not answered yet</span>");
    dom.settings.click({ "data-telemetry": "off" });
    await settle();
    expect(calls).toEqual([false]);
    expect(dom.question.hidden).toBe(true);
    expect(dom.settings.innerHTML).toContain(">off</span>");
    // A click that is not an answer answers nothing.
    dom.settings.click({});
    await settle();
    expect(calls).toEqual([false]);
  });

  it("the switches reflect an off and an unanswered configuration, and a problem", () => {
    expect(switchHtml({ ...STATUS, answer: "off" })).toContain('data-telemetry="on"');
    expect(switchHtml({ ...STATUS, answer: "on", queued: 3 })).toContain(
      'data-testid="settings-telemetry-queued">3</span>',
    );
    expect(switchHtml({ ...STATUS, answer: "on" })).toContain('data-telemetry="off"');
    expect(switchHtml({ ...STATUS, problem: "the <file> is broken" })).toContain(
      "the &lt;file&gt; is broken",
    );
  });

  it("an answer that could not be stored is said, and the question stays", async () => {
    const { dom, refresh, fail } = world(STATUS);
    await refresh();
    fail(new Error("could not write shell-settings.json: EACCES"));
    dom.question.click({ "data-telemetry": "on" });
    await settle();
    expect(dom.message.innerHTML).toBe("could not write shell-settings.json: EACCES");
    expect(dom.question.hidden).toBe(false);
    fail("plain" as unknown as Error);
    dom.question.click({ "data-telemetry": "on" });
    await settle();
    expect(dom.message.innerHTML).toBe("plain");
  });
});
