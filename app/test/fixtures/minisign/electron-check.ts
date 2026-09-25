// Run under Electron (ELECTRON_RUN_AS_NODE=1) by test/e2e/minisign-electron.e2e.ts:
// the production verifier over the old helper's vectors, in the crypto the app really has.
// Prints one JSON line: what each case came to.
import fs from "node:fs";
import { MinisignVerifier } from "../../../src/adapters/signature/minisign";
import { MinisignError } from "../../../src/domain/signature/minisign";

interface Vectors {
  publicKey: string;
  contentBase64: string;
  prehashed: string;
  legacy: string;
}

const vectors = JSON.parse(fs.readFileSync(process.argv[2] ?? "", "utf8")) as Vectors;
const content = Buffer.from(vectors.contentBase64, "base64");
const tampered = Buffer.concat([content, Buffer.from("!")]);
const verifier = new MinisignVerifier();

function outcome(run: () => unknown): string {
  try {
    run();
    return "verified";
  } catch (error) {
    return error instanceof MinisignError ? error.reason : `crashed: ${String(error)}`;
  }
}

console.log(
  JSON.stringify({
    electron: process.versions["electron"] ?? null,
    prehashed: outcome(() => verifier.verify(content, vectors.prehashed, vectors.publicKey)),
    legacy: outcome(() => verifier.verify(content, vectors.legacy, vectors.publicKey)),
    tampered: outcome(() => verifier.verify(tampered, vectors.prehashed, vectors.publicKey)),
  }),
);
