// The node types the runtime generates and registers (spec §2, §1.3; WI-0018-09).
//
// Every declaration the package store read is judged: the protocol first, then the spec's
// §2.6 schema with a real validator, then the rules beyond it (domain/packages/declaration.ts).
// A package that is refused is left out whole and said, with every reason by field; the
// others still load (spec 1.3: "refuse to install or load a package whose protocol it does
// not implement, with a reason naming the version").
//
// A package a person unregistered (plan 0022 §F, D6) is skipped whole: its files stay where they
// are, and its types are not loaded until it is registered again.

import { parseDeclaration, type LoadedType } from "../domain/packages/declaration";
import { unregisteredOf } from "../domain/packages/versions";
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
  unregistered: readonly string[] = [],
): LoadedType[] {
  const loaded: LoadedType[] = [];
  for (const { name, folder, document } of packages) {
    if (unregistered.includes(name)) {
      logger.info(`node package ${name} is unregistered: its types are not loaded`);
      continue;
    }
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

/**
 * The unregistered packages' names from the `packages` setting as `read` returns it. A setting
 * that cannot be judged unregisters nothing, and says so: every package then loads.
 */
export function unregisteredNames(read: () => unknown, logger: Logger): string[] {
  try {
    return unregisteredOf(read());
  } catch (error) {
    logger.warn(`the packages setting cannot be read, so every package loads: ${String(error)}`);
    return [];
  }
}
