// The catalogue document and its sources (WI-0018-14): helper/catalogue.py format 1 and the
// `[sources.<name>]` rules of helper/config.py, ported. tests/test_plugin_catalogue.py
// "Acceptance 1" is the first describe, test for test.
import { describe, expect, it } from "vitest";
import {
  CATALOGUE_FORMAT,
  CatalogueDocumentError,
  CatalogueError,
  CatalogueSettingsError,
  parseCatalogue,
  parseCatalogueSources,
} from "../../src/domain/packages/catalogue";

// catalogue.py:179, written out so the test does not move with the code.
const MAX_SUMMARY_CHARS = 200;

type Entry = Record<string, unknown>;

function entry(packageId = "monty", options: { summary?: string; source?: string } = {}): Entry {
  return {
    id: packageId,
    summary: options.summary ?? "Watches what you do and files it in Anytype.",
    source: options.source ?? "pypi:monty",
  };
}

function document(entries: Entry[] = [entry()], version: unknown = CATALOGUE_FORMAT) {
  return { catalogue: version, plugins: entries };
}

const ACME = { catalogue: "acme", verified: false };

/** The message of the CatalogueDocumentError `run` throws. */
function refusedWith(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogueDocumentError);
    return (error as Error).message;
  }
  throw new Error("expected a refusal, and the document was accepted");
}

describe("the document format (catalogue.py format 1)", () => {
  it("parses a well-formed catalogue into entries", () => {
    const entries = parseCatalogue(
      document([
        entry("monty", { summary: "Files what you do.", source: "pypi:monty" }),
        entry("whodunnit", { summary: "Says who changed it.", source: "index:whodunnit" }),
        entry("summarize", { summary: "Shortens a page.", source: "git+https://forge/s.git" }),
      ]),
      { catalogue: "acme", verified: true },
    );
    expect(entries).toEqual([
      {
        packageId: "monty",
        summary: "Files what you do.",
        installSource: "pypi:monty",
        catalogue: "acme",
        verified: true,
      },
      {
        packageId: "whodunnit",
        summary: "Says who changed it.",
        installSource: "index:whodunnit",
        catalogue: "acme",
        verified: true,
      },
      {
        packageId: "summarize",
        summary: "Shortens a page.",
        installSource: "git+https://forge/s.git",
        catalogue: "acme",
        verified: true,
      },
    ]);
  });

  it("refuses an entry missing a required field, by where it sits", () => {
    const message = refusedWith(() =>
      parseCatalogue(document([entry("whodunnit"), { id: "monty", source: "pypi:monty" }]), ACME),
    );
    expect(message).toContain("entry 1");
    expect(message).toContain("`summary` is missing");
    expect(message).toContain('"acme"');
  });

  it("refuses an entry field of the wrong type, by where it sits", () => {
    const message = refusedWith(() =>
      parseCatalogue(document([{ id: "monty", summary: 7, source: "pypi:monty" }]), ACME),
    );
    expect(message).toContain("entry 0");
    expect(message).toContain("`summary` must be text");
  });

  it("refuses an entry offering a git source that is not HTTPS", () => {
    const message = refusedWith(() =>
      parseCatalogue(
        document([entry("monty", { source: "git+http://forge.example.invalid/monty.git" })]),
        ACME,
      ),
    );
    expect(message).toContain("entry 0");
    expect(message).toContain("HTTPS");
  });

  it("refuses an entry with an empty field", () => {
    expect(
      refusedWith(() => parseCatalogue(document([entry("monty", { summary: "   " })]), ACME)),
    ).toContain("`summary` is empty");
  });

  it("refuses an entry whose id is not an addon id", () => {
    expect(refusedWith(() => parseCatalogue(document([entry("../../etc")]), ACME))).toContain(
      "well-formed addon id",
    );
  });

  it("refuses an entry summary longer than one line", () => {
    const summary = "x".repeat(MAX_SUMMARY_CHARS + 1);
    expect(
      refusedWith(() => parseCatalogue(document([entry("monty", { summary })]), ACME)),
    ).toContain(String(MAX_SUMMARY_CHARS));
    // The ceiling itself is allowed.
    expect(
      parseCatalogue(document([entry("monty", { summary: "x".repeat(MAX_SUMMARY_CHARS) })]), ACME),
    ).toHaveLength(1);
  });

  it("refuses an entry summary holding a control character", () => {
    for (const summary of ["tidy\u001b[2Jand gone", "line break", "no​width"]) {
      expect(
        refusedWith(() => parseCatalogue(document([entry("monty", { summary })]), ACME)),
      ).toContain("control character");
    }
  });

  it("refuses an entry source the updater could not read", () => {
    for (const [source, message] of [
      ["ftp://somewhere", "names no source kind"],
      ["pypi:", "with nothing after it"],
      ["index:", "with nothing after it"],
      ["git+", "with nothing after it"],
    ] as const) {
      const refused = refusedWith(() =>
        parseCatalogue(document([entry("monty", { source })]), ACME),
      );
      expect(refused).toContain("entry 0");
      expect(refused).toContain(message);
    }
    expect(parseCatalogue(document([entry("monty", { source: "index" })]), ACME)).toHaveLength(1);
  });

  it("refuses a malformed git URL as a catalogue refusal", () => {
    expect(() => parseCatalogue(document([entry("monty", { source: "git+::::" })]), ACME)).toThrow(
      CatalogueError,
    );
  });

  it("refuses an entry that is not an object", () => {
    expect(refusedWith(() => parseCatalogue({ catalogue: 1, plugins: ["monty"] }, ACME))).toContain(
      "entry 0 is not a JSON object",
    );
  });

  it("ignores unknown keys inside an entry", () => {
    const entries = parseCatalogue(
      document([{ ...entry("monty"), homepage: "https://example.invalid", stars: 4 }]),
      ACME,
    );
    expect(entries.map((item) => item.packageId)).toEqual(["monty"]);
  });

  it("refuses an unknown top-level key", () => {
    expect(
      refusedWith(() => parseCatalogue({ ...document([entry("monty")]), mirrors: [] }, ACME)),
    ).toContain("'mirrors'");
  });

  it("refuses a document that is not an object", () => {
    for (const value of [[entry("monty")], null, "catalogue", 1]) {
      expect(refusedWith(() => parseCatalogue(value, ACME))).toContain("not a JSON object");
    }
  });

  it("refuses a document announcing no format version", () => {
    expect(refusedWith(() => parseCatalogue({ plugins: [entry("monty")] }, ACME))).toContain(
      "`catalogue` format version",
    );
  });

  it("refuses a boolean as a format version", () => {
    expect(() => parseCatalogue({ catalogue: true, plugins: [] }, ACME)).toThrow(
      CatalogueDocumentError,
    );
    expect(() => parseCatalogue({ catalogue: 1.5, plugins: [] }, ACME)).toThrow(
      CatalogueDocumentError,
    );
  });

  it("refuses a document announcing a newer format rather than reading it", () => {
    expect(
      refusedWith(() => parseCatalogue(document([entry("monty")], CATALOGUE_FORMAT + 1), ACME)),
    ).toContain(String(CATALOGUE_FORMAT + 1));
  });

  it("refuses a document with no plugins list", () => {
    expect(refusedWith(() => parseCatalogue({ catalogue: CATALOGUE_FORMAT }, ACME))).toContain(
      "no `plugins` list",
    );
  });

  it("refuses a catalogue listing one package twice", () => {
    const message = refusedWith(() =>
      parseCatalogue(
        document([entry("monty"), entry("monty", { source: "pypi:not-monty" })]),
        ACME,
      ),
    );
    expect(message).toContain("monty");
    expect(message).toContain("more than once");
  });

  it("reads an empty catalogue as a catalogue", () => {
    expect(
      parseCatalogue({ catalogue: 1, plugins: [] }, { catalogue: "acme", verified: true }),
    ).toEqual([]);
  });
});

describe("the sources, from the settings (config.py [sources.<name>], plan 0006 F1 and F2)", () => {
  const KEY = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";

  it("reads any publisher as a source: a name and an HTTPS URL, a key and a switch optional", () => {
    expect(
      parseCatalogueSources({
        acme: { url: "https://acme.example.invalid/catalogue.json" },
        "someone-else": {
          url: "https://someone.example.invalid/c.json",
          public_key: ` ${KEY} `,
          auto_update: true,
        },
      }),
    ).toEqual([
      {
        name: "acme",
        url: "https://acme.example.invalid/catalogue.json",
        publicKey: null,
        autoUpdate: null,
      },
      {
        name: "someone-else",
        url: "https://someone.example.invalid/c.json",
        publicKey: KEY,
        autoUpdate: true,
      },
    ]);
  });

  it.each([
    ["not a table", "a string", "not a table"],
    ["a value that is not a table", { acme: "https://x" }, "expected a [sources.<name>] table"],
    ["a name that is not a name", { "../x": { url: "https://x" } }, "not a well-formed"],
    ["the reserved official name", { official: { url: "https://x" } }, "reserved"],
    ["an unknown key", { acme: { url: "https://x", mirror: "y" } }, "unknown keys: mirror"],
    ["no URL", { acme: {} }, "url is missing"],
    ["a URL in the clear", { acme: { url: "http://x" } }, "not an HTTPS URL"],
    ["a two-line key", { acme: { url: "https://x", public_key: `c\n${KEY}` } }, "single base64"],
    ["an empty key", { acme: { url: "https://x", public_key: "" } }, "single base64"],
    ["a switch that is not a boolean", { acme: { url: "https://x", auto_update: 1 } }, "true or"],
  ])("refuses %s", (_what, section, message) => {
    expect(() => parseCatalogueSources(section)).toThrow(CatalogueSettingsError);
    expect(() => parseCatalogueSources(section)).toThrow(message);
  });
});

describe("an entry's archive (WI-0018-16)", () => {
  const at = { catalogue: "official", verified: true, url: "https://cat.test/a/catalogue.json" };

  it("is resolved against the catalogue's URL, or taken as it is when absolute", () => {
    const [relative, absolute, none] = parseCatalogue(
      document([
        { ...entry("monty"), archive: "packages/monty-0.1.0.tgz" },
        { ...entry("other"), archive: "https://mirror.test/other.tgz" },
        entry("plain"),
      ]),
      at,
    );
    expect(relative?.archive).toBe("https://cat.test/a/packages/monty-0.1.0.tgz");
    expect(absolute?.archive).toBe("https://mirror.test/other.tgz");
    expect(none).not.toHaveProperty("archive");
  });

  it("refuses an archive fetched in the clear, one that is not text, and one that is no URL", () => {
    expect(
      refusedWith(() =>
        parseCatalogue(document([{ ...entry(), archive: "http://cat.test/m.tgz" }]), at),
      ),
    ).toContain("a package is never fetched in the clear");
    expect(refusedWith(() => parseCatalogue(document([{ ...entry(), archive: 3 }]), at))).toContain(
      "`archive` must be a URL or a path, got 3",
    );
    expect(
      refusedWith(() =>
        parseCatalogue(document([{ ...entry(), archive: "no/base" }]), {
          catalogue: "x",
          verified: false,
        }),
      ),
    ).toContain('`archive` is "no/base", which is not a URL');
  });
});
