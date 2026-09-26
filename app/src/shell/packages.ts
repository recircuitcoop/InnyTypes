// The Packages page's calls in the shell (WI-0018-16): install, install from file, and
// removal, wired to the page's IPC. shell/main.ts builds the adapters and hands them in; this
// file imports none (plan 0018 §2.3), which keeps the composition root under its 600 lines.
//
// Install and removal restart ONLY the runtime (arch_pivot P9f, P11a): the shell, the app page,
// the services process and every pop-out stay as they are, and the time from the restart to
// the new generation running is what the installer logs.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Dialog, IpcMain } from "electron";
import { CatalogueReader } from "../application/catalogue-reader";
import { typesNamedIn } from "../application/deploy-guard";
import {
  OneAtATime,
  PackageInstaller,
  type PackageInstallerPorts,
  type RestartRuntime,
} from "../application/install-package";
import { PackageRemover } from "../application/remove-package";
import type { Supervisor } from "../application/supervisor";
import type { CatalogueCacheStore } from "../ports/catalogue-cache";
import type { Clock } from "../ports/clock";
import type { EditorNodes } from "../ports/editor";
import type { Logger } from "../ports/logger";
import type * as Contract from "../ui/contract";
import { IPC } from "./ipc";

export interface ShellPackagesOptions extends Omit<
  PackageInstallerPorts,
  "restartRuntime" | "saveDownload" | "shipped" | "catalogue" | "catalogueKey"
> {
  readonly ipc: Pick<IpcMain, "handle">;
  readonly dialog: Pick<Dialog, "showOpenDialog">;
  /** The app's data folder: Node-RED's flows and generated modules, downloads. */
  readonly userDir: string;
  /** The packages shipped with the app, as the declared-package store reads them. */
  readonly shippedStore: { documents(): readonly { name: string; document: unknown }[] };
  /** The official catalogue's HTTPS URL; empty in a build that has none. */
  readonly catalogueUrl: string;
  /** The official catalogue's minisign public key; null in a build that has none. */
  readonly catalogueKey: string | null;
  readonly catalogueCache: CatalogueCacheStore;
  readonly runtime: Supervisor;
  readonly editor: EditorNodes;
  readonly forgetGenerated: (name: string) => void;
  readonly clock: Clock;
}

/** How long a restart for new types may take before it is said to have failed. */
const RESTART_MS = 60_000;

/** Restart only the runtime, and resolve with the ms until its next generation runs. */
export function runtimeRestarter(
  runtime: Supervisor,
  clock: Clock,
  logger: Logger,
): RestartRuntime {
  const waiting = new Set<(status: Contract.ChildStatus) => void>();
  runtime.onStatus((status) => {
    for (const waiter of [...waiting]) {
      waiter(status);
    }
  });
  return (reason) =>
    new Promise((resolve) => {
      const before = runtime.status().generation;
      const started = clock.now();
      let cancel = (): void => undefined;
      const done = (took: number | null): void => {
        if (!waiting.delete(waiter)) {
          return; // already settled
        }
        cancel();
        resolve(took);
      };
      const waiter = (status: Contract.ChildStatus): void => {
        if (status.generation > before && status.state === "running") {
          done(clock.now() - started);
        } else if (status.state === "down-for-good") {
          done(null);
        }
      };
      waiting.add(waiter);
      cancel = clock.after(RESTART_MS, () => {
        logger.error(`the runtime did not come back within ${String(RESTART_MS)} ms`);
        done(null);
      });
      logger.info(`restarting only the runtime: ${reason}`);
      if (!runtime.restart("types")) {
        // Not running: it reads the packages when it next starts.
        done(null);
      }
    });
}

/** The types the deployed flows name, from Node-RED's saved flows; none before a deploy. */
export function deployedTypes(flowsFile: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(flowsFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  // A file that is not JSON throws: whether a flow uses the package cannot then be told.
  return typesNamedIn("flows", JSON.parse(text) as unknown);
}

/** A declaration's `version`, as far as a list needs it. */
function versionOf(document: unknown): string {
  const version =
    typeof document === "object" && document !== null
      ? (document as Record<string, unknown>)["version"]
      : undefined;
  return typeof version === "string" ? version : "?";
}

export function wirePackages(options: ShellPackagesOptions): void {
  const { ipc, logger, userDir } = options;
  const restartRuntime = runtimeRestarter(options.runtime, options.clock, logger);
  const one = new OneAtATime();
  const shipped = () =>
    options.shippedStore
      .documents()
      .map(({ name, document }) => ({ name, version: versionOf(document) }));
  const downloads = path.join(userDir, "node-packages", "downloads");
  const saveDownload = (name: string, bytes: Uint8Array): string => {
    fs.mkdirSync(downloads, { recursive: true });
    const file = path.join(downloads, `${name}.tgz`);
    fs.writeFileSync(file, bytes);
    return file;
  };
  const catalogues = new CatalogueReader({
    http: options.http,
    cache: options.catalogueCache,
    verifier: options.environment.verifier,
    now: () => Date.now(),
    // A kept catalogue is fresh for an hour; the update check's interval is WI-0018-17's.
    maxAgeSeconds: () => 3600,
    officialUrl: options.catalogueUrl,
    officialKey: options.catalogueKey,
  });
  const installer = new PackageInstaller(
    {
      ...options,
      restartRuntime,
      shipped,
      saveDownload,
      catalogueKey: options.catalogueKey,
      catalogue: () =>
        options.catalogueUrl === ""
          ? Promise.reject(new Error("this build is configured with no package catalogue"))
          : catalogues.official(),
    },
    one,
  );
  const remover = new PackageRemover(
    {
      roots: options.environment.roots,
      typesInUse: async () => {
        const nodes = await options.editor.nodes();
        return {
          deployed: deployedTypes(path.join(userDir, "node-red", "flows.json")),
          undeployed: nodes === null ? null : nodes.map((node) => node.type),
        };
      },
      forgetGenerated: options.forgetGenerated,
      shipped: () => shipped().map((listed) => listed.name),
      restartRuntime,
      logger,
    },
    one,
  );

  ipc.handle(IPC.packages, (): Promise<Contract.PackagesState> => installer.state());
  ipc.handle(IPC.packageInstall, (_event, id: unknown): Promise<Contract.PackageOutcome> =>
    typeof id === "string" && id !== ""
      ? installer.installFromCatalogue(id)
      : Promise.resolve({ ok: false, error: "No package was named." }),
  );
  ipc.handle(IPC.packageChooseFile, async (): Promise<string | null> => {
    const chosen = await options.dialog.showOpenDialog({
      title: "Install a node package from a file",
      properties: ["openFile", "openDirectory"],
    });
    return chosen.canceled ? null : (chosen.filePaths[0] ?? null);
  });
  ipc.handle(
    IPC.packageInstallFile,
    (_event, file: unknown, confirmed: unknown): Promise<Contract.PackageOutcome> =>
      typeof file === "string" && file !== ""
        ? installer.installFromFile(file, confirmed === true)
        : Promise.resolve({ ok: false, error: "No file was named." }),
  );
  ipc.handle(IPC.packageRemove, (_event, name: unknown): Promise<Contract.PackageOutcome> =>
    typeof name === "string" && name !== ""
      ? remover.remove(name)
      : Promise.resolve({ ok: false, error: "No package was named." }),
  );
}
