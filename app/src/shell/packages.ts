// The Packages page's calls in the shell (WI-0018-16, -17): install, install from file, removal,
// the update check and Apply, and the registered catalogue sources, wired to the page's IPC. shell/main.ts builds the adapters and hands them in; this
// file imports none (plan 0018 §2.3), which keeps the composition root under its 600 lines.
//
// Install and removal restart ONLY the runtime (arch_pivot P9f, P11a): the shell, the app page,
// the services process and every pop-out stay as they are, and the time from the restart to
// the new generation running is what the installer logs. An update also waits, after the
// restart, for every deployed instance of the package's types to send `ready` (the runtime's
// `package.ready`), and swaps the old version back when they do not within 30 s.

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
import type { CatalogueReads } from "../application/package-catalogues";
import { PackageSources, readSources } from "../application/package-sources";
import { PackageRemover } from "../application/remove-package";
import type { Supervisor } from "../application/supervisor";
import { PackageUpdates, type Readiness } from "../application/update-package";
import { OFFICIAL_SOURCE_NAME } from "../domain/packages/catalogue";
import { parsePackagePolicy } from "../domain/packages/versions";
import type { BlockedUpdates } from "../ports/blocked-updates";
import type { CatalogueCacheStore } from "../ports/catalogue-cache";
import type { Clock } from "../ports/clock";
import type { EditorNodes } from "../ports/editor";
import type { Logger } from "../ports/logger";
import type { Notifier } from "../ports/notifier";
import type { PackageSettingsStore } from "../ports/settings-store";
import type * as Contract from "../ui/contract";
import { IPC } from "./ipc";

export interface ShellPackagesOptions extends Omit<
  PackageInstallerPorts,
  keyof CatalogueReads | "restartRuntime" | "shipped"
> {
  readonly http: CatalogueReads["http"];
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
  /** The `packages` and `sources` settings (WI-0018-17). */
  readonly settings: PackageSettingsStore;
  /** The versions whose update failed here and was rolled back. */
  readonly blocked: BlockedUpdates;
  /** Where "update available" and "rolled back" are told, once (WI-0018-21's NoticeBoard). */
  readonly notifier: Notifier;
}

/** The first update check, after the start; then every interval the settings name. */
const FIRST_CHECK_MS = 60_000;

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
  const policy = () => parsePackagePolicy(options.settings.readPackages());
  /** A reader whose kept copies are fresh for `maxAgeSeconds`. */
  const reader = (maxAgeSeconds: () => number) =>
    new CatalogueReader({
      http: options.http,
      cache: options.catalogueCache,
      verifier: options.environment.verifier,
      now: () => Date.now(),
      maxAgeSeconds,
      officialUrl: options.catalogueUrl,
      officialKey: options.catalogueKey,
    });
  /** The catalogue reads over one reader: the page's, and the update check's. */
  const reads = (catalogues: CatalogueReader): CatalogueReads => ({
    http: options.http,
    saveDownload,
    catalogueKey: options.catalogueKey,
    catalogue: () =>
      options.catalogueUrl === ""
        ? Promise.reject(new Error("this build is configured with no package catalogue"))
        : catalogues.official(),
    sources: () => readSources(options.settings),
    registered: (source) => catalogues.registered(source),
  });
  // The page lists kept copies for as long as the update check's interval (catalogue.py:469);
  // the check itself always asks the servers, and keeps what it read for the page.
  const pageReads = reads(
    reader(() => {
      try {
        return policy().checkIntervalSeconds;
      } catch {
        return 3600;
      }
    }),
  );
  const installer = new PackageInstaller(
    { ...options, ...pageReads, restartRuntime, shipped },
    one,
  );
  const readiness = async (packages: readonly string[]): Promise<Readiness> => {
    const result = await options.runtime.call("package.ready", { packages });
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result.value as Readiness;
  };
  const updates = new PackageUpdates(
    {
      ...options,
      ...reads(reader(() => 0)),
      policy,
      restartRuntime,
      readiness,
      now: () => Date.now(),
    },
    one,
  );
  const sources = new PackageSources(options.settings, logger);
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

  ipc.handle(IPC.packages, async (): Promise<Contract.PackagesState> =>
    updates.decorate(await installer.state()),
  );
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
  wireUpdates(ipc, installer, updates, sources);
  updates.schedule(FIRST_CHECK_MS);
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The update check, Apply, and the registered sources (WI-0018-17). */
function wireUpdates(
  ipc: Pick<IpcMain, "handle">,
  installer: PackageInstaller,
  updates: PackageUpdates,
  sources: PackageSources,
): void {
  const unnamed = (what: string): Promise<Contract.PackageOutcome> =>
    Promise.resolve({ ok: false, error: `No ${what} was named.` });
  ipc.handle(IPC.packageCheck, (): Promise<Contract.PackageOutcome> => updates.check());
  ipc.handle(IPC.packageUpdate, (_event, name: unknown): Promise<Contract.PackageOutcome> =>
    text(name) === "" ? unnamed("package") : updates.apply(text(name), "person"),
  );
  ipc.handle(
    IPC.packageInstallSource,
    (_event, source: unknown, id: unknown, confirmed: unknown): Promise<Contract.PackageOutcome> =>
      text(id) === ""
        ? unnamed("package")
        : installer.installFromSource(
            text(source) === "" ? OFFICIAL_SOURCE_NAME : text(source),
            text(id),
            confirmed === true,
          ),
  );
  ipc.handle(
    IPC.sourceRegister,
    (_event, name: unknown, url: unknown, key: unknown): Contract.PackageOutcome =>
      sources.register(text(name), text(url), text(key)),
  );
  ipc.handle(IPC.sourceRemove, (_event, name: unknown): Contract.PackageOutcome =>
    sources.remove(text(name)),
  );
  ipc.handle(IPC.sourceAutoUpdate, (_event, name: unknown, on: unknown): Contract.PackageOutcome =>
    sources.setAutoUpdate(text(name), on === true),
  );
}
