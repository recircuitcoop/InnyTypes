// The machine id (D20; telemetry.py:145-381, ported): HMAC-SHA256 of the operating system's own
// machine identifier, keyed with a fixed label, and nothing else about the machine. Never the user
// name, the host name, a network hardware address or a serial number. A platform with no source
// refuses by name rather than falling back to one of those.
//
// The three sources are three different acts, and each is a seam, so the parsing and every
// refusal are proven on a machine whose own identifier is never read: macOS's identifier is a
// command's output, Linux's a file's contents, Windows's a registry value.

import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { TelemetryError } from "../../domain/telemetry/reports";

/**
 * The HMAC key. NOT a secret: it ships in every copy. Its job is domain separation, so this hash of
 * a machine's identifier matches no other software's hash of the same identifier.
 */
export const MACHINE_ID_KEY = "innytypes.machine-id.v1";

/** The machine id: the keyed hash of the raw identifier, as hex. */
export function machineIdHash(raw: string): string {
  return createHmac("sha256", MACHINE_ID_KEY).update(raw, "utf8").digest("hex");
}

/** Absolute, never a bare name resolved through PATH, which a shell profile can change. */
export const IOREG = "/usr/sbin/ioreg";
export const REG = "C:\\Windows\\System32\\reg.exe";
/** systemd's, then the older D-Bus one: an empty first file is a miss, not an answer. */
export const LINUX_MACHINE_ID_PATHS = ["/etc/machine-id", "/var/lib/dbus/machine-id"] as const;
/** Machine-wide, so it names the machine without naming the account. */
export const MACHINE_GUID_KEY = "HKLM\\SOFTWARE\\Microsoft\\Cryptography";
export const MACHINE_GUID_VALUE = "MachineGuid";

const IOPLATFORM_UUID = /"IOPlatformUUID"\s*=\s*"([0-9A-Za-z-]+)"/;

export interface IdentifierSeams {
  readonly platform: string;
  /** A command's standard output. */
  readonly run: (command: string, args: readonly string[]) => string;
  /** A file's contents, as text. */
  readonly read: (file: string) => string;
  /** One string value of the registry (`key`, `value`). */
  readonly readRegistry: (key: string, value: string) => string;
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The operating system's own machine identifier. Throws TelemetryError, naming why, otherwise. */
export function osMachineIdentifier(seams: IdentifierSeams): string {
  switch (seams.platform) {
    case "darwin":
      return macosPlatformUuid(seams.run);
    case "linux":
      return linuxMachineId(seams.read);
    case "win32":
      return windowsMachineGuid(seams.readRegistry);
    default:
      throw new TelemetryError(
        `no machine identifier source for ${seams.platform}: macOS, Linux and Windows each have ` +
          "one, and telemetry stays off anywhere else rather than identifying the machine " +
          "some other way",
      );
  }
}

function macosPlatformUuid(run: IdentifierSeams["run"]): string {
  let output: string;
  try {
    output = run(IOREG, ["-rd1", "-c", "IOPlatformExpertDevice"]);
  } catch (error) {
    throw new TelemetryError(
      `${IOREG} could not be read for the machine identifier: ${reasonOf(error)}`,
    );
  }
  const found = IOPLATFORM_UUID.exec(output)?.[1];
  if (found === undefined) {
    throw new TelemetryError(
      `${IOREG} printed no IOPlatformUUID, so this machine has no identifier to derive a ` +
        "machine id from",
    );
  }
  return found;
}

function linuxMachineId(read: IdentifierSeams["read"]): string {
  const attempts: string[] = [];
  for (const file of LINUX_MACHINE_ID_PATHS) {
    let value: string;
    try {
      value = read(file).trim();
    } catch (error) {
      attempts.push(`${file} (${reasonOf(error)})`);
      continue;
    }
    if (value !== "") {
      return value;
    }
    attempts.push(`${file} (empty)`);
  }
  throw new TelemetryError(
    "this machine has no readable machine identifier, so there is nothing to derive a machine " +
      `id from: ${attempts.join(", ")}`,
  );
}

function windowsMachineGuid(readRegistry: IdentifierSeams["readRegistry"]): string {
  const where = `${MACHINE_GUID_KEY}\\${MACHINE_GUID_VALUE}`;
  let value: string;
  try {
    value = readRegistry(MACHINE_GUID_KEY, MACHINE_GUID_VALUE).trim();
  } catch (error) {
    if (error instanceof TelemetryError) {
      throw error;
    }
    throw new TelemetryError(
      `${where} could not be read for the machine identifier: ${reasonOf(error)}`,
    );
  }
  if (value === "") {
    throw new TelemetryError(
      `${where} is empty, so this machine has no identifier to derive a machine id from`,
    );
  }
  return value;
}

/**
 * One string value, through reg.exe. `/reg:64` is not optional: a 32-bit process is otherwise
 * redirected to the WOW6432Node copy, whose MachineGuid differs, and one machine would count as two.
 */
export function readRegistryValue(run: IdentifierSeams["run"], key: string, value: string): string {
  const output = run(REG, ["query", key, "/v", value, "/reg:64"]);
  const found = new RegExp(`${value}\\s+(REG_\\w+)\\s+(\\S+)`).exec(output);
  if (found === null) {
    throw new TelemetryError(`${key}\\${value} is not in the registry`);
  }
  if (found[1] !== "REG_SZ") {
    throw new TelemetryError(
      `${key}\\${value} is registry type ${String(found[1])}, not a string; that is not the ` +
        "machine identifier this platform keeps there",
    );
  }
  return found[2] ?? "";
}

/** The real seams: this machine's own sources. Used only by the composition root. */
export function systemSeams(platform: string): IdentifierSeams {
  const run = (command: string, args: readonly string[]): string =>
    execFileSync(command, args, { encoding: "utf8", timeout: 5_000, windowsHide: true });
  return {
    platform,
    run,
    read: (file) => fs.readFileSync(file, "utf8"),
    readRegistry: (key, value) => readRegistryValue(run, key, value),
  };
}
