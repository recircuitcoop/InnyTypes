// The secret store through the real app (WI-0018-06): Node-RED's credential secret is made
// once, kept by the keychain adapter, handed to every runtime generation in init, and found
// nowhere on disk in plaintext afterwards. The keychain is Chromium's mock one, so no run
// touches this user's real keychain (INNYTYPES_MOCK_KEYCHAIN, set by the harness).
import { createHash } from "node:crypto";
import fs from "node:fs";
import * as path from "node:path";
import { expect, test, type ElectronApplication } from "@playwright/test";
import {
  launchApp,
  processesNaming,
  quit,
  scratchDirectories,
  waitForRunning,
} from "./app-harness";

/** The line the runtime writes when init carried the credential secret. */
function arrivalLine(secret: string): string {
  const fingerprint = createHash("sha256").update(secret).digest("hex").slice(0, 8);
  return `the credential secret arrived (sha256 ${fingerprint})`;
}

/** Every regular file below `root` whose bytes hold `needle`. */
function filesHolding(root: string, needle: string): string[] {
  return fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((relative) => path.join(root, relative))
    .filter((file) => fs.lstatSync(file).isFile())
    .filter((file) => fs.readFileSync(file).includes(needle));
}

/** The secret, decrypted by the running app's own safeStorage from what it stored. */
async function decryptStored(app: ElectronApplication, ciphertextFile: string): Promise<string> {
  const stored = fs.readFileSync(ciphertextFile, "utf8");
  return app.evaluate(
    ({ safeStorage }, blob) => safeStorage.decryptString(Buffer.from(blob, "base64")),
    stored,
  );
}

test("the credential secret is made once, reaches every runtime's init, and is never on disk in plaintext", async () => {
  const { scratch, userData, env } = scratchDirectories();
  const logFile = path.join(scratch, "secrets.log");
  const secretsDirectory = path.join(userData, "secrets");
  const ciphertextFile = path.join(secretsDirectory, "node-red-credential-secret.enc");
  try {
    // First launch: the secret is generated and handed to generation 1, and to generation 2
    // after a crash.
    const first = await launchApp({ ...env, INNYTYPES_LOG_FILE: logFile });
    const runtime = await waitForRunning(first.window, "runtime");
    const storage = await first.window.evaluate(() =>
      (
        window as unknown as { inny: { app: { secretStorage(): Promise<unknown> } } }
      ).inny.app.secretStorage(),
    );
    expect(storage).toEqual({ backend: "keychain", reason: null });

    const secret = await decryptStored(first.app, ciphertextFile);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    await expect
      .poll(() => fs.readFileSync(logFile, "utf8"), { timeout: 10_000 })
      .toContain(arrivalLine(secret));

    process.kill(runtime.pid, "SIGKILL");
    await waitForRunning(first.window, "runtime", runtime.generation + 1);
    await expect
      .poll(() => fs.readFileSync(logFile, "utf8").split(arrivalLine(secret)).length - 1, {
        timeout: 10_000,
      })
      .toBe(2);
    const ciphertextBefore = fs.readFileSync(ciphertextFile, "utf8");
    await quit(first.app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);

    // Second launch: the stored secret is read, not made again.
    const second = await launchApp({ ...env, INNYTYPES_LOG_FILE: logFile });
    await waitForRunning(second.window, "runtime");
    expect(await decryptStored(second.app, ciphertextFile)).toBe(secret);
    await expect
      .poll(() => fs.readFileSync(logFile, "utf8").split(arrivalLine(secret)).length - 1, {
        timeout: 10_000,
      })
      .toBe(3);
    await quit(second.app);
    await expect.poll(() => processesNaming(userData), { timeout: 10_000 }).toEqual([]);
    expect(fs.readFileSync(ciphertextFile, "utf8")).toBe(ciphertextBefore);

    // Owner-only, and only the ciphertext: no plaintext fallback file was written.
    expect(fs.readdirSync(secretsDirectory)).toEqual(["node-red-credential-secret.enc"]);
    if (process.platform !== "win32") {
      expect(fs.statSync(secretsDirectory).mode & 0o777).toBe(0o700);
      expect(fs.statSync(ciphertextFile).mode & 0o777).toBe(0o600);
    }

    // The canary scan: the secret in bytes, anywhere under userData, the log and the scratch
    // home, and in everything the processes printed.
    expect(filesHolding(scratch, secret)).toEqual([]);
    expect([...first.output, ...second.output].join("")).not.toContain(secret);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
