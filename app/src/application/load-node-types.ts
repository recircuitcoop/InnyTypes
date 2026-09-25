// The node types the runtime generates and registers (spec §2, §1.3; WI-0018-09).
//
// Every declaration the package store read is judged: the protocol first, then the spec's
// §2.6 schema with a real validator, then the rules beyond it (domain/packages/declaration.ts).
// A package that is refused is left out whole and said, with every reason by field; the
// others still load (spec 1.3: "refuse to install or load a package whose protocol it does
// not implement, with a reason naming the version").

import { parseDeclaration, type LoadedType } from "../domain/packages/declaration";
import type { Logger } from "../ports/logger";
import type { SchemaValidator } from "../ports/schema-validator";

/** One package as the store read it. */
export interface ReadPackage {
  readonly name: string;
  readonly folder: string;
  readonly document: unknown;
}

/** Every type of every package whose declaration is accepted, in package then type order. */
export function loadNodeTypes(
  packages: readonly ReadPackage[],
  validator: SchemaValidator,
  logger: Logger,
): LoadedType[] {
  const loaded: LoadedType[] = [];
  for (const { name, folder, document } of packages) {
    const parsed = parseDeclaration(document, (value) => validator.declaration(value));
    if (!parsed.ok) {
      logger.error(
        `node package ${name} (${folder}) is refused and not loaded: ${parsed.problems.join("; ")}`,
      );
      continue;
    }
    for (const type of parsed.declaration.types) {
      loaded.push({ declaration: parsed.declaration, type, folder });
    }
  }
  return loaded;
}
