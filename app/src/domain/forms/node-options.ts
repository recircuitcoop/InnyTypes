// A step's dynamic options (plan 0022 §B, decision D9): what a form asks for when a property
// declares `innytype.spaces` or `innytype.types.of`, and what it is answered.
//
// One shape for every hop: the canvas form's admin route `/red/inny/options`, Setup's
// `AppApi.nodeOptions`, and the runtime's resolver (application/node-options.ts), which asks the
// services process over the direct peer channel. The answer carries ids and names only; the
// Anytype key never leaves the services process.
//
// Pure: no I/O, no library.

/** What a form asks for: the paired Anytype's spaces, or one space's types. */
export type OptionsQuery =
  { readonly source: "spaces" } | { readonly source: "types"; readonly spaceId: string };

/** One option: the plain string the node stores, and the name a person reads. */
export interface NodeOption {
  readonly value: string;
  readonly label: string;
}

/** Why options could not be listed, and the sentence that says so in place of them. */
export interface OptionsRefusal {
  readonly refused: {
    readonly reason: "not-paired" | "unreachable" | "unavailable";
    readonly sentence: string;
  };
}

/** The answer to an OptionsQuery: the options in Anytype's order, or a refusal. */
export type OptionsAnswer = { readonly options: readonly NodeOption[] } | OptionsRefusal;

/** docs/ux/ux-writing.md, "A step's form": no key, or a key Anytype no longer accepts. */
export const NOT_PAIRED_SENTENCE =
  "Pair with Anytype in Configuration › General to choose a space.";
/** docs/ux/ux-writing.md's Connect Anytype line, for an Anytype that is not running. */
export const UNREACHABLE_SENTENCE = "Open Anytype, then come back.";
/** Any other failure: the details are in the log, never in the form. */
export const UNAVAILABLE_SENTENCE = "Couldn't read from Anytype. Open this step's form again.";

/** docs/ux/ux-writing.md, "A step's form": shown while the spaces are read. */
export const READING_SPACES = "Reading your spaces…";
/** The same, while one space's types are read. */
export const READING_TYPES = "Reading the space's types…";

/** The refusal of `reason`, with its sentence. */
export function refusal(reason: OptionsRefusal["refused"]["reason"]): OptionsRefusal {
  const sentence = {
    "not-paired": NOT_PAIRED_SENTENCE,
    unreachable: UNREACHABLE_SENTENCE,
    unavailable: UNAVAILABLE_SENTENCE,
  }[reason];
  return { refused: { reason, sentence } };
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A query as it arrives, from the page (`{source, spaceId}`) or the admin route's search
 * parameters (`{source, space}`); null when it is not one.
 */
export function parseOptionsQuery(raw: unknown): OptionsQuery | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (raw["source"] === "spaces") {
    return { source: "spaces" };
  }
  const spaceId = raw["spaceId"] ?? raw["space"];
  if (raw["source"] === "types" && typeof spaceId === "string" && spaceId !== "") {
    return { source: "types", spaceId };
  }
  return null;
}

/** An answer as it arrives over a channel or HTTP; null when it is not one. */
export function parseOptionsAnswer(raw: unknown): OptionsAnswer | null {
  if (!isRecord(raw)) {
    return null;
  }
  const refused = raw["refused"];
  if (isRecord(refused)) {
    const reason = refused["reason"];
    return reason === "not-paired" || reason === "unreachable" || reason === "unavailable"
      ? refusal(reason)
      : null;
  }
  const options = raw["options"];
  if (!Array.isArray(options)) {
    return null;
  }
  const valid = options.every(
    (option: unknown) =>
      isRecord(option) &&
      typeof option["value"] === "string" &&
      typeof option["label"] === "string",
  );
  return valid ? { options: options as NodeOption[] } : null;
}
