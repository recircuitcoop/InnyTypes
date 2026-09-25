// sha256, the digest a package's files, its content hash and an executable's binary are
// judged by (domain/packages/archive.ts; WI-0018-15). node:crypto has it in Node and in every
// Electron process (BoringSSL lacks BLAKE2b, not SHA-256).

import { createHash } from "node:crypto";
import type { Sha256 } from "../../domain/packages/archive";

export const sha256Hex: Sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
