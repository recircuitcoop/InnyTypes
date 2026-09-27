// A purpose-scoped reader for the old config.toml (helper/config.py; WI-0018-25), not a general
// TOML parser. It reads exactly what that file ever wrote: comments, blank lines, bare `key =
// value` pairs (booleans, integers, simple decimals, and single- or double-quoted strings), and
// one- or two-level `[section]` / `[section.subsection]` table headers. It refuses anything it
// does not recognise (an array, an inline table, a multi-line string, an array-of-tables header)
// rather than silently reading it as something else — a migration that guesses wrong about a
// value is worse than one that says it could not read it.
//
// The result is a plain nested object, the same shape `json.loads` would hand config.py's own
// parser: legacy-import.ts reads specific paths out of it, the way `_parse_mcp`, `_parse_plugins`
// and friends read them out of the TOML document.

export class LegacyTomlError extends Error {
  override name = "LegacyTomlError";
}

export type TomlValue = string | number | boolean;
export type TomlTable = { [key: string]: TomlValue | TomlTable };

function isTable(value: TomlValue | TomlTable | undefined): value is TomlTable {
  return typeof value === "object";
}

/** Walk (creating as needed) to the table `path` names, refusing to overwrite a scalar. */
function tableAt(root: TomlTable, path: readonly string[]): TomlTable {
  let table = root;
  for (const segment of path) {
    const existing = table[segment];
    if (existing === undefined) {
      const created: TomlTable = {};
      table[segment] = created;
      table = created;
    } else if (isTable(existing)) {
      table = existing;
    } else {
      throw new LegacyTomlError(`"${path.join(".")}" is used as both a value and a table`);
    }
  }
  return table;
}

/** The header between `[` and its matching `]`, split on `.`; refuses `[[...]]` (array tables). */
function parseHeader(line: string): readonly string[] {
  if (line.startsWith("[[")) {
    throw new LegacyTomlError(`array tables are not supported: ${line}`);
  }
  const end = line.lastIndexOf("]");
  if (end === -1) {
    throw new LegacyTomlError(`unterminated table header: ${line}`);
  }
  const inside = line.slice(1, end).trim();
  if (inside === "") {
    throw new LegacyTomlError(`empty table header: ${line}`);
  }
  return inside.split(".").map((part) => part.trim());
}

/** The text of a quoted string starting at index 0 of `text`, and how many characters it took. */
function readQuotedString(text: string): { value: string; length: number } {
  const quote = text[0];
  if (quote !== '"' && quote !== "'") {
    throw new LegacyTomlError(`expected a quoted string: ${text}`);
  }
  let out = "";
  let index = 1;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === quote) {
      return { value: out, length: index + 1 };
    }
    if (quote === '"' && char === "\\") {
      const next = text[index + 1];
      const simple: Record<string, string> = {
        '"': '"',
        "\\": "\\",
        n: "\n",
        t: "\t",
        r: "\r",
        b: "\b",
        f: "\f",
      };
      const escaped = next === undefined ? undefined : simple[next];
      if (escaped !== undefined) {
        out += escaped;
        index += 2;
        continue;
      }
      throw new LegacyTomlError(`unsupported escape in string: \\${next ?? ""}`);
    }
    out += char;
    index += 1;
  }
  throw new LegacyTomlError(`unterminated string: ${text}`);
}

const NUMBER = /^-?\d+(\.\d+)?$/;

/** Everything after `key =` on one logical line, with any trailing comment already removed. */
function parseScalar(text: string): TomlValue {
  const trimmed = text.trim();
  if (trimmed === "true" || trimmed === "false") {
    return trimmed === "true";
  }
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const { value, length } = readQuotedString(trimmed);
    const rest = trimmed.slice(length).trim();
    if (rest !== "") {
      throw new LegacyTomlError(`unexpected text after a quoted string: ${text}`);
    }
    return value;
  }
  if (NUMBER.test(trimmed)) {
    return Number(trimmed);
  }
  throw new LegacyTomlError(
    `cannot read the value ${JSON.stringify(trimmed)}: only booleans, numbers, and quoted ` +
      "strings are understood here",
  );
}

/** `text` with a `#` comment removed, unless the `#` is inside an unterminated quoted string. */
function stripComment(text: string): string {
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === "\\" && quote === '"') {
        index += 1; // skip the escaped character, whatever it is
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#") {
      return text.slice(0, index);
    }
  }
  return text;
}

/** Read the old config.toml's shape: comments, blank lines, `key = value`, `[a]`, `[a.b]`. */
export function parseLegacyToml(text: string): TomlTable {
  const root: TomlTable = {};
  let currentPath: readonly string[] = [];

  const rawLines = text.split(/\r\n|\n|\r/);
  for (const rawLine of rawLines) {
    const line = stripComment(rawLine).trim();
    if (line === "") {
      continue;
    }
    if (line.startsWith("[")) {
      currentPath = parseHeader(line);
      tableAt(root, currentPath); // materialise an empty table even if nothing follows
      continue;
    }
    const equals = line.indexOf("=");
    if (equals === -1) {
      throw new LegacyTomlError(`expected "key = value": ${line}`);
    }
    const key = line.slice(0, equals).trim();
    if (key === "" || /\s/.test(key) || key.includes(".") || key.includes("[")) {
      throw new LegacyTomlError(`not a plain key: ${key || line}`);
    }
    const value = parseScalar(line.slice(equals + 1));
    const table = tableAt(root, currentPath);
    table[key] = value;
  }
  return root;
}
