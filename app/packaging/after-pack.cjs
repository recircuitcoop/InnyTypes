// electron-builder's afterPack hook (plan 0018 §1, WI-0018-23): the fuses, and a defensive
// check that npm never made it into the packed app.
//
// Fuses (electron-builder's own addElectronFuses convenience, which resolves the right binary
// for every platform itself):
//   - RunAsNode off: the runtime and services processes are utilityProcesses, and every JS node
//     package and the Anytype MCP child run on the bundled Node (BundledRuntimeLocator), never
//     Electron acting as node. With this fuse off, ELECTRON_RUN_AS_NODE stops working entirely,
//     which is exactly the point: nothing in this app may depend on it once packaged.
//   - NodeCliInspect off: no --inspect surface in a shipped app.
//   - OnlyLoadAppFromAsar + asar integrity on: the app can run only the code its own signed
//     asar carries (docs/tutorial/asar-integrity.md).
//
// npm exclusion: app/packaging/electron-builder.yml's `files` already excludes
// node_modules/npm from what gets packed. This hook re-checks the packed output itself, so a
// config regression that let npm back in fails the build here rather than shipping silently.

const fs = require("node:fs");
const path = require("node:path");

/** Every node_modules/npm path under `dir`, found by walking app.asar.unpacked and the app
 * folder that electron-builder leaves alongside app.asar (there is no such folder here, since
 * `asar: true`, but a future config change that turns it off must still be caught). */
function findNpm(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name === "npm" && dir.endsWith(path.sep + "node_modules")) {
      found.push(full);
      continue;
    }
    if (entry.isDirectory()) {
      found.push(...findNpm(full));
    }
  }
  return found;
}

/** The entitlements plist the ad-hoc re-sign below applies. By default it is
 * local-entitlements.mac.plist, whose get-task-allow lets Playwright attach over CDP in local
 * e2e. A build meant for distribution (INNYTYPES_DISTRIBUTE=1) must never carry get-task-allow,
 * so it gets release-entitlements.mac.plist instead. Pure, so the choice is testable without
 * running codesign. */
function adHocEntitlementsPlist(env) {
  const name =
    env.INNYTYPES_DISTRIBUTE === "1"
      ? "release-entitlements.mac.plist"
      : "local-entitlements.mac.plist";
  return path.join(__dirname, name);
}

async function afterPack(context) {
  const { FuseV1Options, FuseVersion } = require("@electron/fuses");
  await context.packager.addElectronFuses(context, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });

  // Flipping a fuse patches bytes inside the signed Electron Framework binary, which
  // invalidates whatever signature it already carried. With a real Developer ID
  // (identity, WI-0018-24) electron-builder re-signs the whole app AFTER afterPack runs, which
  // covers this; with `identity: null` it skips signing entirely, and macOS's code-signing
  // enforcement then SIGKILLs the app the instant it runs code in that now-invalid binary
  // (crash report: "Code Signature Invalid", faulting in electron::fuses::IsRunAsNodeEnabled).
  //
  // An ad-hoc signature alone (no identity, no entitlements) satisfies that check for the main
  // process, but the renderer's V8 then has no JIT/unsigned-executable-memory entitlement to
  // run under: the window never came up (Playwright's firstWindow() hung indefinitely, though
  // the main process — pure Node, no JIT needed — ran Node-RED to completion regardless). The
  // same entitlements.mac.plist electron-builder itself signs with when a real identity is
  // given (app-builder-lib/templates/entitlements.mac.plist) fixes this even ad-hoc: `--deep`
  // applies it to every nested helper too, which is coarser than electron-builder's own
  // per-component signing but correct for local, unsigned execution (WI-0018-24 does the real,
  // per-component signing with a Developer ID).
  // Only the ad-hoc, unsigned config (packaging/electron-builder.yml, `mac.identity: null`)
  // needs this manual re-sign. The release config (electron-builder.release.yml, WI-0018-24)
  // names no identity at all, so electron-builder finds a real Developer ID and signs the whole
  // app itself, AFTER afterPack runs (the comment above explains why that order matters) — this
  // block must not also touch it, or its own signature would be the last one applied instead.
  const macConfig = context.packager.platformSpecificBuildOptions;
  if (context.electronPlatformName === "darwin" && macConfig?.identity === null) {
    const { execFileSync } = require("node:child_process");
    const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    const entitlements = adHocEntitlementsPlist(process.env);
    execFileSync("codesign", [
      "--force",
      "--deep",
      "--sign",
      "-",
      "--options",
      "runtime",
      "--entitlements",
      entitlements,
      appPath,
    ]);
  }

  // node_modules is unpacked beside app.asar (asarUnpack node_modules/**, for the bundled Node
  // that runs the Anytype MCP child), so this walk of appOutDir sees the real dependency tree in
  // app.asar.unpacked: an npm that slipped past the `files` exclusion lands there as plain files
  // and fails the build here. The npm stub stays inside app.asar (unpacking matches its source
  // path, packaging/npm-stub), where this walk does not look.
  const npmPaths = findNpm(context.appOutDir);
  if (npmPaths.length > 0) {
    throw new Error(
      `packaging: npm is not supposed to be in the bundle (WI-0018-23), but found: ` +
        npmPaths.join(", "),
    );
  }
}

// electron-builder calls the module itself as the hook; the plist choice rides along on it.
module.exports = afterPack;
module.exports.adHocEntitlementsPlist = adHocEntitlementsPlist;
