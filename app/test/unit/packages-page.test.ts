// The Packages page (WI-0018-16) through AppApi and nothing else, with no DOM: its lists, the
// unsigned mark, the catalogue's offers, and the two presses an unsigned install takes.
import { describe, expect, it } from "vitest";

import type { AppApi, PackageOutcome, PackagesState } from "../../src/ui/contract";
import {
  catalogueHtml,
  mountPackages,
  packageListHtml,
  unsignedQuestionHtml,
} from "../../src/ui/pages/packages";
import type { PageEvent, Section } from "../../src/ui/pages/page";
import { ANYTYPE_UNUSED } from "../fakes/anytype";
import { VIEWS_UNUSED } from "../fakes/views";

class FakeSection implements Section {
  listener: (event: PageEvent) => void = () => undefined;
  on(_type: "click" | "submit", listener: (event: PageEvent) => void): void {
    this.listener = listener;
  }
  click(attributes: Record<string, string>): void {
    this.listener({
      target: { getAttribute: (name: string) => attributes[name] ?? null },
      preventDefault: () => undefined,
    });
  }
}

const settle = async (): Promise<void> => {
  for (let n = 0; n < 10; n += 1) {
    await Promise.resolve();
  }
};

const STATE: PackagesState = {
  packages: [
    { name: "anytype", version: "1.0.0", kind: "shipped", signed: true },
    { name: "pinger", version: "0.1.0", kind: "installed", signed: false },
    { name: "signed", version: "2.0.0", kind: "installed", signed: true },
  ],
  catalogue: [
    {
      id: "pinger",
      name: "pinger",
      summary: "Pings.",
      installable: true,
      installed: true,
      verified: true,
    },
    {
      id: "new-one",
      name: "new_one",
      summary: "New.",
      installable: true,
      installed: false,
      verified: true,
    },
    {
      id: "old",
      name: "old",
      summary: "Old <b>.",
      installable: false,
      installed: false,
      verified: false,
    },
  ],
  catalogueProblem: null,
};

describe("the Packages page's HTML", () => {
  it("lists every package, marks the unsigned one, and offers Remove only for an installed one", () => {
    const html = packageListHtml(STATE.packages);
    expect(html.match(/data-testid="package-item"/g)).toHaveLength(3);
    expect(html.match(/data-testid="package-unsigned"/g)).toHaveLength(1);
    expect(html).toContain(
      'data-name="pinger" data-kind="installed">pinger 0.1.0 (installed) <strong',
    );
    expect(html.match(/data-remove=/g)).toHaveLength(2);
    expect(html).not.toContain('data-remove="anytype"');
    expect(packageListHtml([])).toContain("packages-empty");
  });

  it("offers Install for what is installable and not installed, and escapes what it shows", () => {
    const html = catalogueHtml(STATE.catalogue, null);
    expect(html.match(/data-testid="catalogue-install"/g)).toHaveLength(1);
    expect(html).toContain('data-install="new-one"');
    expect(html).toContain("pinger: Pings. installed");
    expect(html).toContain("old: Old &lt;b&gt;. (unverified catalogue) (not installable");
    expect(catalogueHtml([], null)).toContain("catalogue-empty");
    expect(catalogueHtml([], "no catalogue here")).toContain(
      "No catalogue can be listed: no catalogue here",
    );
    expect(unsignedQuestionHtml("/a/<pkg>")).toContain("/a/&lt;pkg&gt; is not signed");
  });
});

describe("the Packages page", () => {
  function mounted(outcome: PackageOutcome, chosen: string | null = "/dev/pinger") {
    const calls: unknown[][] = [];
    const api: AppApi = {
      ...ANYTYPE_UNUSED,
      ...VIEWS_UNUSED,
      secretStorage: () => Promise.reject(new Error("not used here")),
      childStatus: () => Promise.resolve([]),
      onChildStatus: () => undefined,
      restartChild: () => Promise.resolve(),
      packages: () => {
        calls.push(["packages"]);
        return Promise.resolve(STATE);
      },
      installFromCatalogue: (id) => {
        calls.push(["installFromCatalogue", id]);
        return Promise.resolve(outcome);
      },
      chooseInstallFile: () => {
        calls.push(["chooseInstallFile"]);
        return Promise.resolve(chosen);
      },
      installFromFile: (file, confirmed) => {
        calls.push(["installFromFile", file, confirmed]);
        return Promise.resolve(outcome);
      },
      removePackage: (name) => {
        calls.push(["removePackage", name]);
        return Promise.resolve(outcome);
      },
    };
    const page = {
      section: new FakeSection(),
      list: { innerHTML: "" },
      catalogue: { innerHTML: "" },
      question: { innerHTML: "" },
      message: { innerHTML: "" },
    };
    return { page, calls, refresh: mountPackages(page, api) };
  }

  it("draws both lists when shown, and again on Refresh", async () => {
    const { page, calls, refresh } = mounted({ ok: true, message: "" });
    await refresh();
    expect(page.list.innerHTML).toContain("package-list");
    expect(page.catalogue.innerHTML).toContain("catalogue-list");
    page.section.click({ "data-refresh": "1" });
    await settle();
    expect(calls).toEqual([["packages"], ["packages"]]);
  });

  it("installs from the catalogue and removes, saying what came of it", async () => {
    const { page, calls } = mounted({ ok: true, message: "new_one 1.0 is installed." });
    page.section.click({ "data-install": "new-one" });
    expect(page.message.innerHTML).toBe("Installing new-one…");
    await settle();
    expect(page.message.innerHTML).toBe("new_one 1.0 is installed.");
    page.section.click({ "data-remove": "pinger" });
    await settle();
    expect(calls).toContainEqual(["installFromCatalogue", "new-one"]);
    expect(calls).toContainEqual(["removePackage", "pinger"]);
  });

  it("asks before an unsigned install, installs only on Install unsigned, and Cancel installs nothing", async () => {
    const { page, calls } = mounted({ ok: false, error: "Not installed: broken." });
    page.section.click({ "data-install-file": "1" });
    await settle();
    expect(page.question.innerHTML).toContain("/dev/pinger is not signed");
    expect(calls).toEqual([["chooseInstallFile"]]);
    page.section.click({ "data-cancel-unsigned": "1" });
    expect(page.question.innerHTML).toBe("");
    expect(page.message.innerHTML).toBe("Nothing was installed.");

    page.section.click({ "data-install-file": "1" });
    await settle();
    page.section.click({ "data-confirm-unsigned": "/dev/pinger" });
    expect(page.question.innerHTML).toBe("");
    await settle();
    expect(calls).toContainEqual(["installFromFile", "/dev/pinger", true]);
    expect(page.message.innerHTML).toBe("Not installed: broken.");
  });

  it("a cancelled file chooser asks nothing", async () => {
    const { page, calls } = mounted({ ok: true, message: "" }, null);
    page.section.click({ "data-install-file": "1" });
    await settle();
    expect(page.question.innerHTML).toBe("");
    page.section.click({ other: "1" });
    expect(calls).toEqual([["chooseInstallFile"]]);
  });
});
