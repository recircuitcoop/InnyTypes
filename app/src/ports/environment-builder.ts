// Building a package's environment (plan 0018 §3, the helper/environments.py row; WI-0018-15).
//
// The plan (domain/packages/environment.ts) is judged first, on the verified files; a builder
// only carries it out, in a staging folder that nothing runs from until it is swapped in.

import type { EnvironmentPlan } from "../domain/packages/environment";

/** What a built environment gives the command placeholders (spec 2.3.2). */
export interface BuiltEnvironment {
  /** For a uv-python environment, the venv's interpreter relative to the environment folder. */
  readonly python?: string;
}

export interface EnvironmentBuilder {
  /**
   * Build `plan` for the package whose verified files are in `packageDir`, into the empty
   * folder `environmentDir`. Rejects with an Error naming what failed; whatever it left behind
   * is staging scrap.
   */
  build(
    plan: EnvironmentPlan,
    packageDir: string,
    environmentDir: string,
  ): Promise<BuiltEnvironment>;
}
