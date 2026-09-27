// sha256, the digest a package's files, its content hash and an executable's binary are
// judged by (domain/packages/archive.ts; WI-0018-15). node:crypto has it in Node and in every
// Electron process (BoringSSL lacks BLAKE2b, not SHA-256).
//
// sha512, base64: the digest a release's `latest-*.yml` names each artifact by (electron-builder's
// own convention; WI-0018-24). node:crypto has it everywhere the same way.

import { createHash } from "node:crypto";
import type { Sha256 } from "../../domain/packages/archive";
import type { Sha512 } from "../../domain/update/release-metadata";

export const sha256Hex: Sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const sha512Base64: Sha512 = (bytes) => createHash("sha512").update(bytes).digest("base64");
