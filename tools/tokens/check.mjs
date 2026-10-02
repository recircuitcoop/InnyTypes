// Colour comes from tokens only (plan 0022 §K, §Q): the architecture stage of the gate fails on
// a raw colour anywhere in the UI's sources, so the rule holds by check rather than by
// convention, and dark mode cannot be broken by one hard-coded value.
//
//   node tools/tokens/check.mjs [<dir> ...]        (default: app/src/ui)
//
// Refused, with the file, line and column of each:
//   - a hex colour (#fff, #ffffff, #ffffff80);
//   - a colour function: rgb(), rgba(), hsl(), hsla(), hwb(), lab(), lch(), oklab(), oklch(),
//     color();
//   - in CSS, a named colour keyword used as a value (`color: white`);
//   - in script, a named colour in the string value of a style property
//     (`style={{ color: "white" }}`, `backgroundColor: "red"`);
//   - in SVG, HTML and JSX, a named colour in a `fill`, `stroke`, `color` or `stop-color`
//     attribute (`fill="red"`);
//   - an arbitrary Tailwind class that sets a colour property, whatever its value, with or
//     without a utility prefix (`[color:red]`, `hover:[background:var(--x)]`, `text-[color:...]`),
//     and an arbitrary value that is a raw colour (`bg-[#fff]`, `border-[red]`).
// `transparent`, `currentColor`, `none` and `inherit` are not colours and stay allowed.
//
// Every file under the scanned directories is read; nothing inside app/src/ui is exempt. The
// generated tokens file, where colours do live, is build output in app/dist/generated, outside
// what is scanned. Exits 1 when anything is found.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_DIRS = [path.join(REPO, "app", "src", "ui")];

/** The source files the UI is written in; anything else (fonts, images) is not read. */
const SOURCE_EXTENSIONS = new Set([".css", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".html", ".svg"]);

/** The CSS named colours (CSS Color Module Level 4), lowercase. */
const NAMED_COLOURS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue " +
    "blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk " +
    "crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki " +
    "darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue " +
    "dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite " +
    "gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen " +
    "lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen " +
    "magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen " +
    "mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream " +
    "mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid " +
    "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum " +
    "powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown " +
    "seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen " +
    "steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen"
  ).split(" "),
);

const COLOUR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi;

// A hex colour of 3, 4, 6 or 8 digits that ends there. In CSS every one is a colour. In script
// and markup, `#` also starts a private class member (`#add()`, `this.#feed`), so there a hex is
// one only when it is not preceded by `.` or a word character and not followed by `(` or `=`.
const HEX_CSS = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z_-])/gi;
// An SVG fragment reference, `url(#fade)`, is not a colour either.
const HEX_SCRIPT =
  /(?<![\w.$])(?<!url\()#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])(?!\s*[(=])/gi;

// The CSS properties that take a colour. An arbitrary-property class setting one of them
// (`[color:red]`) is refused whatever its value: colour reaches the UI through the token-bound
// utilities only.
const COLOUR_PROPERTY =
  /^(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left|x|y|inline|block|inline-start|inline-end|block-start|block-end))?(?:-color)?|fill|stroke|(?:box|text)-shadow|outline(?:-color)?|text-decoration(?:-color)?|caret-color|accent-color|column-rule(?:-color)?|stop-color)$/i;

// Any bracket class, with an optional utility prefix: `bg-[#fff]`, `[color:red]`,
// `hover:[background:x]`. Group 1 is the prefix (absent for an arbitrary property), group 2 the
// inside of the brackets.
const BRACKET_CLASS = /(?<![\w-])([a-z][a-z0-9-]*-)?\[([^\]\s]+)\]/gi;

// A raw colour value: a hex, or a colour function.
const RAW_VALUE = /^(?:#[0-9a-f]{3,8}$|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\()/i;

// A style property given a string value in script: `color: "white"`, `"background-color": 'red'`,
// `borderTopColor: \`blue\``. Group 1 is the property, group 3 the value.
const SCRIPT_STYLE =
  /(?<![\w-])["']?(color|background(?:-?color)?|border(?:-?[a-z]+)*|fill|stroke|(?:box|text)-?shadow|outline(?:-?color)?|caret-?color|accent-?color|stop-?color)["']?\s*:\s*(["'`])([^"'`]*)\2/gi;

// A colour attribute in SVG, HTML or JSX: `fill="red"`, `stroke='white'`, `stopColor="navy"`.
const COLOUR_ATTRIBUTE = /(?<![\w-])(fill|stroke|color|stop-?color)\s*=\s*(["'])([^"']*)\2/gi;

/** Every file under `dir` the check reads, sorted so its report is stable. */
function sourceFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full));
      continue;
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      found.push(full);
    }
  }
  return found.sort();
}

/** Comments replaced by spaces, so positions stay right and commented-out code is not judged. */
function blankComments(text, isCss) {
  const pattern = isCss ? /\/\*[\s\S]*?\*\//g : /\/\*[\s\S]*?\*\/|(?<![:"'`\\])\/\/[^\n]*/g;
  return text.replace(pattern, (comment) => comment.replace(/[^\n]/g, " "));
}

/** 1-based line and column of an offset. */
function position(text, offset) {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n");
  return `${String(line)}:${String(column)}`;
}

/** Every raw colour in one file's text, as { at, what }. */
function rawColours(text, isCss) {
  const source = blankComments(text, isCss);
  const findings = [];
  const add = (offset, what) => findings.push({ offset, what });

  for (const match of source.matchAll(isCss ? HEX_CSS : HEX_SCRIPT)) {
    add(match.index, match[0]);
  }
  for (const match of source.matchAll(COLOUR_FUNCTION)) {
    add(match.index, match[0]);
  }
  for (const match of source.matchAll(BRACKET_CLASS)) {
    const prefix = match[1];
    const inside = match[2] ?? "";
    const property = /^([a-z-]+):/i.exec(inside);
    // `[color:red]`, `text-[color:var(--x)]`: a colour property, or Tailwind's `color:` hint.
    const setsColour = property !== null && COLOUR_PROPERTY.test(property[1] ?? "");
    // `bg-[#fff]`, `border-[red]`: a prefixed arbitrary value that is a raw colour. Without a
    // prefix a bracket is an index or a selector (`row[0]`, `[hidden]`), so only the property
    // form is judged there.
    const rawValue =
      prefix !== undefined && (RAW_VALUE.test(inside) || NAMED_COLOURS.has(inside.toLowerCase()));
    if (setsColour || rawValue) {
      add(match.index, match[0]);
    }
  }
  if (!isCss) {
    // Named colours given as a string to a style property, or to a colour attribute.
    for (const pattern of [SCRIPT_STYLE, COLOUR_ATTRIBUTE]) {
      for (const match of source.matchAll(pattern)) {
        const value = match[3] ?? "";
        const valueStart = match.index + match[0].length - value.length - 1;
        for (const word of value.matchAll(/-?[a-z_][\w-]*/gi)) {
          if (NAMED_COLOURS.has(word[0].toLowerCase())) {
            add(valueStart + word.index, word[0]);
          }
        }
      }
    }
  }
  if (isCss) {
    // Named colours only as declaration values: every identifier after a `:` up to `;` or `}`.
    // Identifiers are matched whole, so `var(--inny-color-red-3)` is not `red`.
    for (const declaration of source.matchAll(/:([^;{}]*)/g)) {
      const valueStart = declaration.index + 1;
      for (const word of declaration[1].matchAll(/-?[a-z_][\w-]*/gi)) {
        if (NAMED_COLOURS.has(word[0].toLowerCase())) {
          add(valueStart + word.index, word[0]);
        }
      }
    }
  }

  // One finding per place: a hex inside an arbitrary class is reported once, as the class,
  // which starts first and so comes first once sorted.
  let coveredUntil = -1;
  return findings
    .sort((a, b) => a.offset - b.offset)
    .filter((finding) => {
      const covered = finding.offset < coveredUntil;
      coveredUntil = Math.max(coveredUntil, finding.offset + finding.what.length);
      return !covered;
    })
    .map((finding) => ({ at: position(text, finding.offset), what: finding.what }));
}

function main(args) {
  const dirs = args.length > 0 ? args.map((dir) => path.resolve(dir)) : DEFAULT_DIRS;
  const refusals = [];
  for (const dir of dirs) {
    for (const file of sourceFiles(dir)) {
      const isCss = path.extname(file) === ".css";
      for (const finding of rawColours(fs.readFileSync(file, "utf8"), isCss)) {
        refusals.push(`  ${path.relative(REPO, file)}:${finding.at}: ${finding.what}`);
      }
    }
  }
  if (refusals.length > 0) {
    console.error(
      `tokens: ${String(refusals.length)} raw colour(s) in the UI; use a token (plan 0022 §K):`,
    );
    for (const line of refusals) {
      console.error(line);
    }
    process.exit(1);
  }
  console.log("tokens: no raw colour in the UI");
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2));
}
