// The machine id (WI-0018-22; D20): the operating system's own identifier, from its one source on
// each platform, hashed with a fixed key. Every source is injected: no test reads this machine's.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  IOREG,
  LINUX_MACHINE_ID_PATHS,
  MACHINE_GUID_KEY,
  MACHINE_GUID_VALUE,
  MACHINE_ID_KEY,
  machineIdHash,
  osMachineIdentifier,
  readRegistryValue,
  REG,
  type IdentifierSeams,
} from "../../src/adapters/telemetry/machine-id";
import { TelemetryError } from "../../src/domain/telemetry/reports";

const UUID = "4A2B3C4D-1111-2222-3333-444455556666";

/** Seams that refuse everything unless a test says otherwise. */
function seams(platform: string, overrides: Partial<IdentifierSeams> = {}): IdentifierSeams {
  const never = (): never => {
    throw new Error("this seam must not be used here");
  };
  return { platform, run: never, read: never, readRegistry: never, ...overrides };
}

describe("the machine id", () => {
  it("is the HMAC of the injected identifier, keyed with the fixed label", () => {
    expect(machineIdHash(UUID)).toBe(
      createHmac("sha256", "innytypes.machine-id.v1").update(UUID).digest("hex"),
    );
    expect(MACHINE_ID_KEY).toBe("innytypes.machine-id.v1");
  });

  it("is the same every time for the same machine, and different for a different one", () => {
    expect(machineIdHash(UUID)).toBe(machineIdHash(UUID));
    expect(machineIdHash(UUID)).not.toBe(machineIdHash(`${UUID}7`));
  });

  it("neither equals nor contains the raw identifier", () => {
    const id = machineIdHash(UUID);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toContain(UUID.toLowerCase());
    expect(id.toUpperCase()).not.toContain(UUID);
  });
});

describe("the macOS identifier", () => {
  it("is read from ioreg, by its absolute path, and nothing else", () => {
    const asked: unknown[] = [];
    const run = (command: string, args: readonly string[]): string => {
      asked.push([command, ...args]);
      return `+-o IOPlatformExpertDevice\n  "IOPlatformSerialNumber" = "SERIAL"\n  "IOPlatformUUID" = "${UUID}"\n`;
    };
    expect(osMachineIdentifier(seams("darwin", { run }))).toBe(UUID);
    expect(asked).toEqual([[IOREG, "-rd1", "-c", "IOPlatformExpertDevice"]]);
    expect(IOREG).toBe("/usr/sbin/ioreg");
  });

  it("a failing ioreg is refused by name", () => {
    const run = (): string => {
      throw new Error("spawn EACCES");
    };
    expect(() => osMachineIdentifier(seams("darwin", { run }))).toThrow(
      `${IOREG} could not be read for the machine identifier: spawn EACCES`,
    );
  });

  it("ioreg printing no uuid is refused", () => {
    expect(() => osMachineIdentifier(seams("darwin", { run: () => "nothing here" }))).toThrow(
      "printed no IOPlatformUUID",
    );
  });
});

describe("the Linux identifier", () => {
  it("is /etc/machine-id", () => {
    const read = (file: string): string => (file === "/etc/machine-id" ? `${UUID}\n` : "");
    expect(osMachineIdentifier(seams("linux", { read }))).toBe(UUID);
  });

  it("an empty /etc/machine-id falls through to the D-Bus one", () => {
    const read = (file: string): string => (file === "/etc/machine-id" ? "\n" : UUID);
    expect(osMachineIdentifier(seams("linux", { read }))).toBe(UUID);
    expect(LINUX_MACHINE_ID_PATHS).toEqual(["/etc/machine-id", "/var/lib/dbus/machine-id"]);
  });

  it("a machine with no identifier at all is refused by name, saying what was tried", () => {
    const read = (file: string): string => {
      if (file === "/etc/machine-id") {
        return "";
      }
      throw new Error("ENOENT");
    };
    expect(() => osMachineIdentifier(seams("linux", { read }))).toThrow(
      "/etc/machine-id (empty), /var/lib/dbus/machine-id (ENOENT)",
    );
  });
});

describe("the Windows identifier", () => {
  it("is the MachineGuid from the injected registry reader", () => {
    const asked: string[] = [];
    const readRegistry = (key: string, value: string): string => {
      asked.push(`${key}\\${value}`);
      return ` ${UUID} `;
    };
    expect(osMachineIdentifier(seams("win32", { readRegistry }))).toBe(UUID);
    expect(asked).toEqual([`${MACHINE_GUID_KEY}\\${MACHINE_GUID_VALUE}`]);
  });

  it("a MachineGuid that cannot be read is refused by name", () => {
    const readRegistry = (): string => {
      throw new Error("access denied");
    };
    expect(() => osMachineIdentifier(seams("win32", { readRegistry }))).toThrow(
      `${MACHINE_GUID_KEY}\\${MACHINE_GUID_VALUE} could not be read for the machine identifier: access denied`,
    );
    const typed = (): string => {
      throw new TelemetryError("is registry type REG_DWORD");
    };
    expect(() => osMachineIdentifier(seams("win32", { readRegistry: typed }))).toThrow(
      "is registry type REG_DWORD",
    );
  });

  it("an empty MachineGuid is a miss rather than an answer", () => {
    expect(() => osMachineIdentifier(seams("win32", { readRegistry: () => "  " }))).toThrow(
      "is empty",
    );
  });

  it("the registry is read through reg.exe's 64-bit view, and only a string is accepted", () => {
    const asked: unknown[] = [];
    const run = (command: string, args: readonly string[]): string => {
      asked.push([command, ...args]);
      return `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ${UUID}\r\n`;
    };
    expect(readRegistryValue(run, MACHINE_GUID_KEY, MACHINE_GUID_VALUE)).toBe(UUID);
    expect(asked).toEqual([[REG, "query", MACHINE_GUID_KEY, "/v", "MachineGuid", "/reg:64"]]);
    expect(() =>
      readRegistryValue(
        () => "    MachineGuid    REG_DWORD    0x1",
        MACHINE_GUID_KEY,
        MACHINE_GUID_VALUE,
      ),
    ).toThrow("is registry type REG_DWORD, not a string");
    expect(() => readRegistryValue(() => "", MACHINE_GUID_KEY, MACHINE_GUID_VALUE)).toThrow(
      "is not in the registry",
    );
  });
});

describe("every platform InnyTypes ships for has its own identifier source", () => {
  it("and an operating system nobody ships for has none, refused by name", () => {
    expect(() => osMachineIdentifier(seams("freebsd"))).toThrow(
      "no machine identifier source for freebsd",
    );
    expect(() => osMachineIdentifier(seams("freebsd"))).toThrow(TelemetryError);
  });
});
