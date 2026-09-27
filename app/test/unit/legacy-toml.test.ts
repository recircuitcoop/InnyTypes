// The old config.toml's shape, read without a general TOML library (WI-0018-25).

import { describe, expect, it } from "vitest";
import { LegacyTomlError, parseLegacyToml } from "../../src/domain/migration/legacy-toml";

describe("parseLegacyToml", () => {
  it("reads top-level booleans, integers, floats and quoted strings", () => {
    expect(
      parseLegacyToml(
        [
          "telemetry = true",
          "launch_at_login = false",
          "auto_check_versions = true",
          "count = 12",
          "fraction = 1.5",
          'name = "InnyTypes"',
          "quoted = 'literal string'",
        ].join("\n"),
      ),
    ).toEqual({
      telemetry: true,
      launch_at_login: false,
      auto_check_versions: true,
      count: 12,
      fraction: 1.5,
      name: "InnyTypes",
      quoted: "literal string",
    });
  });

  it("ignores comments and blank lines, full-line and inline", () => {
    const document = parseLegacyToml(
      ["# a comment", "", "telemetry = true # trailing comment", "  ", "#"].join("\n"),
    );
    expect(document).toEqual({ telemetry: true });
  });

  it("does not treat a # inside a quoted string as a comment", () => {
    expect(parseLegacyToml('channel = "beta#1"')).toEqual({ channel: "beta#1" });
  });

  it("reads one- and two-level table headers, building nested tables", () => {
    expect(
      parseLegacyToml(
        [
          "[update]",
          'channel = "stable"',
          "check_interval = 86400",
          "[plugins]",
          "update_mode = 'manual'",
          "[plugins.monty]",
          "update_mode = 'auto'",
          "pinned = true",
          "[sources.acme]",
          'url = "https://acme.example/catalogue.json"',
        ].join("\n"),
      ),
    ).toEqual({
      update: { channel: "stable", check_interval: 86400 },
      plugins: { update_mode: "manual", monty: { update_mode: "auto", pinned: true } },
      sources: { acme: { url: "https://acme.example/catalogue.json" } },
    });
  });

  it("an empty section with nothing under it still materialises the table", () => {
    expect(parseLegacyToml("[mcp]")).toEqual({ mcp: {} });
  });

  it.each([
    ["[[array]]", "array tables are not supported"],
    ["[]", "empty table header"],
    ["[unterminated", "unterminated table header"],
    ["no equals sign here", 'expected "key = value"'],
    ['bad key. = "x"', "not a plain key"],
    ['unterminated = "no closing quote', "unterminated string"],
    ["number = not-a-value", "cannot read the value"],
    ['escape = "bad \\q"', "unsupported escape"],
  ])("refuses %s", (line, message) => {
    expect(() => parseLegacyToml(line)).toThrow(LegacyTomlError);
    expect(() => parseLegacyToml(line)).toThrow(message);
  });

  it("refuses a key used first as a value and then as a table, or the reverse", () => {
    expect(() => parseLegacyToml('mcp = "x"\n[mcp]')).toThrow(
      "is used as both a value and a table",
    );
  });
});
