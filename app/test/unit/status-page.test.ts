// The minimal status page, through AppApi and nothing else, with no DOM.
import { describe, expect, it } from "vitest";
import type { AppApi, ChildName, ChildStatus } from "../../src/ui/contract";
import {
  childHtml,
  mountStatusPage,
  restartTarget,
  statusHtml,
  type StatusRoot,
} from "../../src/ui/pages/status";

const RUNNING: ChildStatus = {
  child: "runtime",
  state: "running",
  generation: 2,
  pid: 55,
  port: 18_800,
  error: null,
};

describe("childHtml", () => {
  it("shows the state, generation, pid and port by test id", () => {
    const html = childHtml(RUNNING);
    expect(html).toContain('<p data-testid="child-state-runtime">running</p>');
    expect(html).toContain('<span data-testid="child-generation-runtime">2</span>');
    expect(html).toContain('<span data-testid="child-pid-runtime">55</span>');
    expect(html).toContain('<span data-testid="child-port-runtime">18800</span>');
    expect(html).not.toContain("child-restart");
  });

  it("shows the error and a Restart button when down for good, escaped", () => {
    const html = childHtml({
      ...RUNNING,
      child: "services",
      state: "down-for-good",
      pid: null,
      port: null,
      error: "crashed <5> times & stopped",
    });
    expect(html).toContain(
      '<p role="alert" data-testid="child-error-services">crashed &lt;5&gt; times &amp; stopped</p>',
    );
    expect(html).toContain('data-testid="child-restart-services" data-restart="services"');
    expect(html).toContain('<span data-testid="child-pid-services"></span>');
  });

  it("says a crashed child is being restarted", () => {
    expect(childHtml({ ...RUNNING, state: "down" })).toContain(
      "stopped unexpectedly and is being restarted",
    );
  });
});

describe("statusHtml", () => {
  it("lists the children in a fixed order", () => {
    const html = statusHtml([{ ...RUNNING, child: "services" }, RUNNING]);
    expect(html.indexOf("child-runtime")).toBeLessThan(html.indexOf("child-services"));
  });
});

describe("restartTarget", () => {
  const element = (value: string | null) => ({ getAttribute: () => value });

  it("names the child of a Restart button", () => {
    expect(restartTarget(element("runtime"))).toBe("runtime");
    expect(restartTarget(element("services"))).toBe("services");
  });

  it("is null for anything else", () => {
    for (const target of [null, 1, {}, { getAttribute: 1 }, element(null), element("shell")]) {
      expect(restartTarget(target)).toBeNull();
    }
  });
});

class FakeRoot implements StatusRoot {
  innerHTML = "";
  #click: (event: { readonly target: unknown }) => void = () => undefined;
  addEventListener(_type: "click", listener: (event: { readonly target: unknown }) => void) {
    this.#click = listener;
  }
  click(target: unknown): void {
    this.#click({ target });
  }
}

describe("mountStatusPage", () => {
  it("draws the first answer, redraws on each change, and sends Restart to the shell", async () => {
    const restarts: ChildName[] = [];
    let push: (status: ChildStatus) => void = () => undefined;
    const api: AppApi = {
      childStatus: () => Promise.resolve([RUNNING, { ...RUNNING, child: "services", port: null }]),
      onChildStatus: (listener) => {
        push = listener;
      },
      restartChild: (child) => {
        restarts.push(child);
        return Promise.resolve();
      },
    };
    const root = new FakeRoot();
    await mountStatusPage(root, api);
    expect(root.innerHTML).toContain("child-runtime");
    expect(root.innerHTML).toContain("child-services");

    push({ ...RUNNING, state: "down-for-good", error: "gave up" });
    expect(root.innerHTML).toContain("child-restart-runtime");

    root.click({ getAttribute: () => "runtime" });
    root.click({ getAttribute: () => null });
    expect(restarts).toEqual(["runtime"]);
  });

  it("keeps a change that arrived before the first answer", async () => {
    let push: (status: ChildStatus) => void = () => undefined;
    let answer: (statuses: readonly ChildStatus[]) => void = () => undefined;
    const api: AppApi = {
      childStatus: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      onChildStatus: (listener) => {
        push = listener;
      },
      restartChild: () => Promise.resolve(),
    };
    const root = new FakeRoot();
    const mounted = mountStatusPage(root, api);
    push({ ...RUNNING, generation: 5 });
    answer([RUNNING]);
    await mounted;
    expect(root.innerHTML).toContain('<span data-testid="child-generation-runtime">5</span>');
  });
});
