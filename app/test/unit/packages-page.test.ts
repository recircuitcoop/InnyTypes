// The Packages page (WI-0018-16, -17) through AppApi and nothing else, with no DOM: its three
// lists, the unsigned mark, the catalogue's offers, the two presses an unsigned install takes,
// the update lines with Apply, and the registered sources.
import { describe, expect, it } from "vitest";

import type {
  AppApi,
  CatalogueOffer,
  ListedPackage,
  PackageOutcome,
  PackagesState,
  SourceListing,
} from "../../src/ui/contract";
import {
  catalogueHtml,
  checkedHtml,
  mountPackages,
  packageListHtml,
  sourcesHtml,
  unsignedQuestionHtml,
  updateHtml,
} from "../../src/ui/pages/packages";
import type { PageEvent, Section } from "../../src/ui/pages/page";
import { ANYTYPE_UNUSED } from "../fakes/anytype";
import { VIEWS_UNUSED } from "../fakes/views";

class FakeSection implements Section {
  readonly listeners = new Map<string, (event: PageEvent) => void>();
  on(type: "click" | "submit", listener: (event: PageEvent) => void): void {
    this.listeners.set(type, listener);
  }
  click(attributes: Record<string, string>): void {
    this.listeners.get("click")?.({
      target: { getAttribute: (name: string) => attributes[name] ?? null },
      preventDefault: () => undefined,
    });
  }
  /** Submit a form: its `data-form` and the values its fields hold. */
  submit(form: string, values: Record<string, string>): void {
    this.listeners.get("submit")?.({
      target: {
        getAttribute: (name: string) => (name === "data-form" ? form : null),
        elements: Object.entries(values).map(([name, value]) => ({
          name,
          value,
          getAttribute: () => null,
        })),
      },
      preventDefault: () => undefined,
    });
  }
}

const listed = (
  name: string,
  version: string,
  kind: "shipped" | "installed",
  signed: boolean,
  extra: Partial<ListedPackage> = {},
): ListedPackage => ({
  name,
  version,
  kind,
  signed,
  from: null,
  mode: null,
  update: null,
  ...extra,
});

const offer = (
  id: string,
  fields: Pick<CatalogueOffer, "summary" | "installable" | "installed" | "verified"> &
    Partial<CatalogueOffer>,
): CatalogueOffer => ({
  id,
  name: id.replace(/-/g, "_"),
  source: "official",
  version: null,
  shadowedBy: null,
  ...fields,
});

const settle = async (): Promise<void> => {
  for (let n = 0; n < 10; n += 1) {
    await Promise.resolve();
  }
};

const STATE: PackagesState = {
  packages: [
    listed("anytype", "1.0.0", "shipped", true),
    listed("pinger", "0.1.0", "installed", false),
    listed("signed", "2.0.0", "installed", true),
  ],
  catalogue: [
    offer("pinger", { summary: "Pings.", installable: true, installed: true, verified: true }),
    offer("new-one", { summary: "New.", installable: true, installed: false, verified: true }),
    offer("old", { summary: "Old <b>.", installable: false, installed: false, verified: false }),
  ],
  catalogueProblem: null,
  sources: [],
  sourcesProblem: null,
  checkedAt: null,
};

const ACME: SourceListing = {
  name: "acme",
  url: "https://acme.test/catalogue.json",
  publisher: "acme.test",
  keyed: false,
  autoUpdate: true,
  offers: [
    offer("whodunnit", {
      summary: "Finds authors.",
      source: "acme",
      version: "1.0.0",
      installable: true,
      installed: false,
      verified: false,
    }),
    offer("pinger", {
      summary: "Impostor.",
      source: "acme",
      installable: false,
      installed: true,
      verified: false,
      shadowedBy: "official",
    }),
    offer("monty", {
      summary: "Also official.",
      source: "acme",
      installable: false,
      installed: false,
      verified: false,
      shadowedBy: "official",
    }),
  ],
  problem: null,
};

describe("the Packages page's HTML", () => {
  it("lists every package, marks the unsigned one, and offers Remove only for an installed one", () => {
    const html = packageListHtml(STATE.packages);
    expect(html.match(/data-testid="package-item"/g)).toHaveLength(3);
    expect(html.match(/data-testid="package-unsigned"/g)).toHaveLength(1);
    expect(html).toContain(
      'data-name="pinger" data-kind="installed">pinger 0.1.0 (installed) <strong',
    );
    expect(
      packageListHtml([listed("from", "1", "installed", true, { from: "acme", mode: "auto" })]),
    ).toContain('from 1 (installed, from acme) <span data-testid="package-mode">auto</span>');
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
  function mounted(
    outcome: PackageOutcome,
    chosen: string | null = "/dev/pinger",
    sourceOutcome: PackageOutcome = outcome,
  ) {
    const calls: unknown[][] = [];
    const api: AppApi = {
      ...ANYTYPE_UNUSED,
      ...VIEWS_UNUSED,
      secretStorage: () => Promise.reject(new Error("not used here")),
      launchAtLogin: () => Promise.reject(new Error("not used here")),
      setLaunchAtLogin: () => Promise.reject(new Error("not used here")),
      telemetry: () => Promise.reject(new Error("not used here")),
      setTelemetry: () => Promise.reject(new Error("not used here")),
      legacyPackages: () => Promise.resolve([]),
      deleteLegacyPackages: () => Promise.resolve([]),
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
      checkPackageUpdates: () => {
        calls.push(["checkPackageUpdates"]);
        return Promise.resolve(outcome);
      },
      applyPackageUpdate: (name) => {
        calls.push(["applyPackageUpdate", name]);
        return Promise.resolve(outcome);
      },
      installFromSource: (source, id, confirmed) => {
        calls.push(["installFromSource", source, id, confirmed]);
        return Promise.resolve(confirmed ? outcome : sourceOutcome);
      },
      registerSource: (name, url, key) => {
        calls.push(["registerSource", name, url, key]);
        return Promise.resolve(outcome);
      },
      removeSource: (name) => {
        calls.push(["removeSource", name]);
        return Promise.resolve(outcome);
      },
      setSourceAutoUpdate: (name, on) => {
        calls.push(["setSourceAutoUpdate", name, on]);
        return Promise.resolve(outcome);
      },
    };
    const page = {
      section: new FakeSection(),
      list: { innerHTML: "" },
      catalogue: { innerHTML: "" },
      sources: { innerHTML: "" },
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

  it("checks for updates, applies one, and draws when the last check ran", async () => {
    const { page, calls } = mounted({
      ok: true,
      message: "pinger is updated from 0.1.0 to 0.2.0.",
    });
    await Promise.resolve();
    page.section.click({ "data-check": "1" });
    expect(page.message.innerHTML).toBe("Checking for updates…");
    await settle();
    page.section.click({ "data-apply": "pinger" });
    await settle();
    expect(calls).toContainEqual(["checkPackageUpdates"]);
    expect(calls).toContainEqual(["applyPackageUpdate", "pinger"]);
    expect(page.message.innerHTML).toBe("pinger is updated from 0.1.0 to 0.2.0.");
    expect(page.list.innerHTML).toContain("No update check has run yet.");
  });

  it("registers a source from its form, switches it, removes it, and says each outcome", async () => {
    const { page, calls } = mounted({ ok: false, error: "Not changed: bad key." });
    page.section.submit("source", { name: "acme", url: "https://acme.test/c.json", key: "k" });
    page.section.submit("endpoint", { name: "ignored" });
    await settle();
    expect(page.message.innerHTML).toBe("Not changed: bad key.");
    page.section.click({ "data-source-auto": "acme", "data-on": "0" });
    page.section.click({ "data-source-remove": "acme" });
    await settle();
    expect(calls.filter(([name]) => name !== "packages")).toEqual([
      ["registerSource", "acme", "https://acme.test/c.json", "k"],
      ["setSourceAutoUpdate", "acme", false],
      ["removeSource", "acme"],
    ]);
  });

  it("asks before installing from a keyless source, and installs only once confirmed", async () => {
    const { page, calls } = mounted({ ok: true, message: "whodunnit 1.0.0 is installed." }, null, {
      ok: false,
      error: "whodunnit comes from acme, a source registered with no public key.",
      needsConfirmation: true,
    });
    page.section.click({ "data-install-source": "whodunnit", "data-source": "acme" });
    await settle();
    expect(page.question.innerHTML).toContain("a source registered with no public key");
    expect(page.question.innerHTML).toContain('data-confirm-source="acme" data-id="whodunnit"');
    page.section.click({ "data-confirm-source": "acme", "data-id": "whodunnit" });
    await settle();
    expect(calls).toContainEqual(["installFromSource", "acme", "whodunnit", false]);
    expect(calls).toContainEqual(["installFromSource", "acme", "whodunnit", true]);
    expect(page.message.innerHTML).toBe("whodunnit 1.0.0 is installed.");
  });

  it("says a signed source's install outcome at once", async () => {
    const { page } = mounted({ ok: true, message: "one is installed." });
    page.section.click({ "data-install-source": "one", "data-source": "signed" });
    await settle();
    expect(page.message.innerHTML).toBe("one is installed.");
    expect(page.question.innerHTML).toBe("");
  });
});

describe("the update lines and the sources", () => {
  it("shows a newer version with Apply, and holds a pinned, moved, failed or unchecked one without", () => {
    expect(updateHtml("p", null)).toBe("");
    const newer = updateHtml("p", { kind: "newer", version: "0.2.0", detail: null, apply: true });
    expect(newer).toContain('data-kind="newer">update available: 0.2.0</span>');
    expect(newer).toContain('data-apply="p" data-testid="package-apply"');
    const pinned = updateHtml("p", {
      kind: "newer",
      version: "0.2.0",
      detail: "p is pinned at 0.1.0",
      apply: false,
    });
    expect(pinned).toContain("update available: 0.2.0: p is pinned at 0.1.0");
    expect(pinned).not.toContain("data-apply");
    for (const [kind, said] of [
      ["moved", "not updated: 0.1.0 changed without a new version: why"],
      ["failed", "the update to 0.1.0 was rolled back and is held back: why"],
      ["unchecked", "not checked: why"],
    ] as const) {
      const html = updateHtml("p", { kind, version: "0.1.0", detail: "why", apply: false });
      expect(html).toContain(said);
      expect(html).not.toContain("data-apply");
    }
    expect(checkedHtml(0)).toContain("Last checked");
  });

  it("lists each source with its publisher, marks a keyless one unverified, and never hides a shadow", () => {
    const html = sourcesHtml(
      [ACME, { ...ACME, name: "down", offers: [], problem: "unreachable <x>" }],
      null,
    );
    expect(html).toContain('published by <span data-testid="source-publisher">acme.test</span>');
    expect(html).toContain("no public key: unverified");
    expect(html).toContain('data-install-source="whodunnit" data-source="acme"');
    expect(html).toContain("whodunnit 1.0.0: Finds authors. (unverified catalogue)");
    expect(html).toContain("the official catalogue's monty is the one installed");
    expect(html).toContain("unreachable &lt;x&gt;");
    expect(html).toContain('data-source-auto="acme" data-on="0"');
    expect(html).toContain('data-testid="source-form"');
    const keyed = sourcesHtml([{ ...ACME, keyed: true, autoUpdate: null, offers: [] }], null);
    expect(keyed).toContain("verified with its public key");
    expect(keyed).toContain('Auto-update: <span data-testid="source-auto">the default</span>');
    expect(keyed).toContain("It offers no packages.");
    expect(sourcesHtml([{ ...ACME, autoUpdate: false }], null)).toContain(">off</span>");
    expect(sourcesHtml([], null)).toContain("No other source is registered.");
    expect(sourcesHtml([], "unreadable")).toContain('data-testid="sources-problem">unreadable');
  });
});
