// Where the runtimes a package environment is built with, and the node a JS node package or
// the Anytype MCP child runs on, are (plan 0018 §1; WI-0018-15, WI-0018-23).
//
// Plan 0018 §1 bundles python-build-standalone 3.13, uv and Node 24, each pinned by version and
// sha256 (WI-0018-23). Until a target's runtimes are fetched (tools/runtimes/fetch.mjs), and in
// development and in tests, the adapter behind this port finds the system's uv, a system
// Python 3.13, and stands Electron's own binary in for node (ELECTRON_RUN_AS_NODE).

/** How a node script is run: the binary, and what its environment needs to act as node. */
export interface NodeRuntime {
  readonly command: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface RuntimeLocator {
  /** The uv executable. */
  uv(): string;
  /** The interpreter for a Python version (`"3.13"`), or undefined when there is none. */
  python(version: string): string | undefined;
  /** The node a JS node package's `{node}` placeholder, or the Anytype MCP child, runs on. */
  node(): NodeRuntime;
}
