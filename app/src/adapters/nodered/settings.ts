// Node-RED's settings for the embedded runtime (spec 11.4, 11.5, 11.6; WI-0018-08).
//
// The palette lock (D1): no install route, no palette manager, no module from
// userDir/node_modules, and of Node-RED's own nodes only `core/common`, the plumbing that runs
// no user code. The excluded files are computed from Node-RED's own core folders, so a node
// added to a later Node-RED is excluded too, with nothing to keep in step by hand.

import * as fs from "node:fs";
import * as path from "node:path";
import type { NodeRedLoggingSettings } from "./logging";

/** Node-RED's own folder of nodes that stay (spec 11.5). */
export const CORE_COMMON = "common";

/** Where the editor and the admin API are mounted (spec 10.1). */
export const ADMIN_ROOT = "/red";

/**
 * Every core node file outside `core/common`, by file name, which is what Node-RED's
 * `nodesExcludes` compares: function, exec and template above all (spec 11.5).
 */
export function coreNodesOutsideCommon(coreNodesDir: string): string[] {
  const core = path.join(coreNodesDir, "core");
  return fs
    .readdirSync(core, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== CORE_COMMON)
    .flatMap((entry) =>
      fs.readdirSync(path.join(core, entry.name)).filter((file) => /\.c?js$/.test(file)),
    )
    .sort();
}

export interface NodeRedSettingsInput {
  /** Node-RED's own folder: flows.json, flows_cred.json, its package.json and node_modules. */
  readonly userDir: string;
  /** Where the generated node types are written (WI-0018-09). */
  readonly generatedDir: string;
  /** Node-RED's credential secret (WI-0018-06). */
  readonly credentialSecret: string;
  /** The folder of @node-red/nodes, whose `core/` holds Node-RED's own nodes. */
  readonly coreNodesDir: string;
  readonly logging: NodeRedLoggingSettings;
}

/** The whole `settings` object `RED.init` is given. */
export function nodeRedSettings(input: NodeRedSettingsInput): Record<string, unknown> {
  return {
    userDir: input.userDir,
    flowFile: "flows.json",
    credentialSecret: input.credentialSecret,
    httpAdminRoot: ADMIN_ROOT,
    // No HTTP-in nodes exist (they are excluded), so Node-RED serves no node routes at all.
    httpNodeRoot: false,
    coreNodesDir: input.coreNodesDir,
    nodesDir: [input.generatedDir],
    // Spec 11.5: only core/common survives.
    nodesExcludes: coreNodesOutsideCommon(input.coreNodesDir),
    // Spec 11.4: Node-RED then mounts no install route (404) and shows no palette manager, and
    // the deny-all palette list keeps every module out of the node list, even one listed in
    // userDir/package.json.
    functionExternalModules: false,
    externalModules: {
      autoInstall: false,
      palette: { allowInstall: false, allowUpload: false, allowList: [], denyList: ["*"] },
      modules: { allowInstall: false, allowList: [], denyList: ["*"] },
    },
    editorTheme: {
      page: { title: "InnyTypes" },
      header: { title: "InnyTypes" },
      projects: { enabled: false },
      tours: false,
      multiplayer: { enabled: false },
    },
    diagnostics: { enabled: false },
    telemetry: { enabled: false },
    logging: input.logging,
  };
}
