// Where the runtimes a package environment is built with are (plan 0018 §1; WI-0018-15).
//
// Plan 0018 §1 bundles python-build-standalone 3.13 and uv, each pinned by version and sha256.
// Bundling them is WI-0018-23; until then the adapter behind this port finds the system's uv
// and a system Python 3.13, in development and in tests.

export interface RuntimeLocator {
  /** The uv executable. */
  uv(): string;
  /** The interpreter for a Python version (`"3.13"`), or undefined when there is none. */
  python(version: string): string | undefined;
}
