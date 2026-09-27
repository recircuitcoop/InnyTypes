// The `update` setting (plan 0018 §3 update.py; WI-0018-24): whether the application checks
// GitHub Releases for a newer version of itself, and which channel it checks. Pure: parsing
// and judging, in the shape domain/packages/versions.ts's `parsePackagePolicy` already
// established for the sibling `packages` setting.

/** The `update` setting refused as a whole: the setting names what is wrong with it. */
export class UpdateSettingsError extends Error {
  override name = "UpdateSettingsError";
}

export interface UpdatePolicy {
  /** Off: no request is ever made, not even to read a channel's metadata (D14's rule again). */
  readonly autoCheck: boolean;
  /** Which per-platform metadata file is asked for: `latest`, or a prerelease channel. */
  readonly channel: string;
}

/** Off is the safer default for a switch nobody has looked at yet. */
export const DEFAULT_UPDATE_POLICY: UpdatePolicy = { autoCheck: false, channel: "latest" };

const POLICY_KEYS = new Set(["auto_check", "channel"]);
/** A channel becomes half of a file name and a URL path segment: kept to what is safe in both. */
const CHANNEL = /^[a-z][a-z0-9-]*$/;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `update` setting:
 *
 *     { "auto_check": true, "channel": "latest" }
 *
 * Absent is the default (off). Anything it cannot account for is refused whole: a channel
 * misspelled and read as the default would silently check somewhere the person did not choose.
 */
export function parseUpdatePolicy(section: unknown): UpdatePolicy {
  if (section === undefined) {
    return DEFAULT_UPDATE_POLICY;
  }
  if (!isRecord(section)) {
    throw new UpdateSettingsError("the update setting is not an object");
  }
  const unknown = Object.keys(section).filter((key) => !POLICY_KEYS.has(key));
  if (unknown.length > 0) {
    throw new UpdateSettingsError(`the update setting holds unknown keys: ${unknown.join(", ")}`);
  }
  const autoCheck = section["auto_check"];
  if (autoCheck !== undefined && typeof autoCheck !== "boolean") {
    throw new UpdateSettingsError("update.auto_check must be true or false");
  }
  const channel = section["channel"];
  if (channel !== undefined && (typeof channel !== "string" || !CHANNEL.test(channel))) {
    throw new UpdateSettingsError(
      `update.channel (${JSON.stringify(channel)}) must be lowercase letters, digits and hyphens, ` +
        "starting with a letter",
    );
  }
  return {
    autoCheck: autoCheck ?? DEFAULT_UPDATE_POLICY.autoCheck,
    channel: channel ?? DEFAULT_UPDATE_POLICY.channel,
  };
}
