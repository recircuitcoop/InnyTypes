// Whether a newer InnyTypes exists, and getting it ready to install (helper/update.py and
// swap.py, replaced; plan 0018 §1, §3; WI-0018-24).
//
// Plan 0003 D10, the rule this whole file exists to keep: trust the signature, never the
// server. Before anything from the release feed is trusted, its `latest-*.yml` is fetched
// together with its detached minisign signature and verified against the public key this
// build embeds (adapters/signature/minisign.ts, the same verifier the package catalogue
// uses). Only once that has passed does this code:
//
//   - read the version and the release file's declared sha512 out of the (now trusted) yml;
//   - download that file itself and check its bytes against that sha512, independently of
//     whatever electron-updater will do later — a tampered artifact is refused here, before
//     electron-updater is ever told to touch it;
//   - ask the platform updater (SelfUpdater, adapters/update/) to check the same feed and
//     stage a download in the background. electron-updater does its own, ordinary sha512
//     check when it downloads (belt and suspenders: this application's own check above is
//     what a tampered SERVER cannot pass, never delegated to a library this file cannot see
//     the tests of).
//
// The switch and the channel are the `update` setting (domain/update/policy.ts), read fresh on
// every check: off makes no request at all, not even for the metadata (D14's rule, again).

import { compareVersions } from "../domain/packages/versions";
import { MinisignError } from "../domain/signature/minisign";
import { parseUpdatePolicy, type UpdatePolicy } from "../domain/update/policy";
import {
  metadataFileName,
  parseReleaseMetadata,
  pickReleaseFile,
  ReleaseMetadataError,
  type ReleaseFile,
  type ReleaseMetadata,
  type ReleasePlatform,
  type Sha512,
} from "../domain/update/release-metadata";
import type { CheckFailure, UpdateEvent } from "../domain/updates/machine";
import type { Clock } from "../ports/clock";
import type { HttpClient } from "../ports/http-client";
import type { Logger } from "../ports/logger";
import type { Notifier } from "../ports/notifier";
import type { SelfUpdater } from "../ports/self-updater";
import type { SignatureVerifier } from "../ports/signature-verifier";
import type { UpdateSettingsStore } from "../ports/settings-store";

/** minisign's own suffix (domain/packages/catalogue.ts's SIGNATURE_SUFFIX, the same rule). */
export const METADATA_SIGNATURE_SUFFIX = ".minisig";
/** A `latest-*.yml` is a handful of lines; a huge one is not the real file. */
export const MAX_METADATA_BYTES = 1024 * 1024;
export const MAX_SIGNATURE_BYTES = 4096;
/** electron-builder's mac zip and Linux AppImage artifacts: generous, still bounded. */
export const MAX_ARTIFACT_BYTES = 500 * 1024 * 1024;

const NOTICE_SUBJECT = "InnyTypes";

export type UpdateOutcome =
  { readonly ok: true; readonly message: string } | { readonly ok: false; readonly error: string };

/** How this application talks to the feed: fetches it, and checks what it names. */
export interface UpdateTransport {
  readonly http: HttpClient;
  readonly verifier: SignatureVerifier;
  readonly sha512: Sha512;
}

/** Where a finding goes: the one log, and the once-only notice board. */
export interface UpdateReport {
  readonly notifier: Notifier;
  readonly logger: Logger;
}

/** What this running instance is, for comparing against a feed's version. */
export interface UpdateSession {
  readonly clock: Clock;
  readonly currentVersion: () => string;
}

export interface UpdateCheckPorts {
  readonly transport: UpdateTransport;
  readonly settings: UpdateSettingsStore;
  readonly report: UpdateReport;
  readonly selfUpdater: SelfUpdater;
  readonly session: UpdateSession;
  /** The minisign public key embedded in this build; null when this build ships none (dev). */
  readonly publicKey: string | null;
  /** Where the release feed is published, one path segment short of a metadata file's name. */
  readonly feedBaseUrl: string;
  /** Where one tagged release's files are published (Go back's older release, D4). */
  readonly tagBaseUrl: (tag: string) => string;
  readonly platform: ReleasePlatform;
  readonly arch: string;
  /**
   * Told each step of a check as domain/updates' events (plan 0022 §G), so General's update line
   * follows a check as it goes, the scheduled ones included. Optional: nothing listens in a test
   * that does not ask.
   */
  readonly onEvent?: (event: UpdateEvent) => void;
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** `base` and a path segment (a file name, or a `files[].url`), joined exactly once. */
function joinUrl(base: string, segment: string): string {
  return `${base.replace(/\/+$/, "")}/${segment.replace(/^\/+/, "")}`;
}

export class UpdateCheck {
  readonly #ports: UpdateCheckPorts;
  #staged = false;
  #cancelSchedule: (() => void) | null = null;

  constructor(ports: UpdateCheckPorts) {
    this.#ports = ports;
  }

  /**
   * Check the release feed for a newer version. Off in the settings: no request at all, unless the
   * person asked (Check now; plan 0003: a manual check still works with the switch off). A
   * network problem is logged and answered, never a notice (a server hiccup is not tampering).
   * A tampered feed or artifact IS a notice, once (application/notices.ts's NoticeBoard).
   */
  async check(options: { readonly manual?: boolean } = {}): Promise<UpdateOutcome> {
    const { notifier, logger } = this.#ports.report;
    this.#staged = false;
    const policy = this.#policy();
    if (!policy.ok) {
      return this.#failed(policy.why);
    }
    if (!policy.value.autoCheck && options.manual !== true) {
      logger.info("update check: off in the settings; nothing is asked");
      return { ok: true, message: "Not checked: checking for updates is off in the settings." };
    }

    this.#emit({ kind: "check" });
    const { feedBaseUrl, arch } = this.#ports;
    const signed = await this.#readSigned(feedBaseUrl, policy.value.channel, "unreadable");
    if (!signed.ok) {
      return signed.outcome;
    }
    const { parsed, metadataUrl } = signed;

    const order = compareVersions(parsed.version, this.#ports.session.currentVersion());
    if (order === null || order <= 0) {
      this.#emit({ kind: "found", version: null, at: this.#now() });
      notifier.clear("core-update-available", NOTICE_SUBJECT);
      notifier.clear("core-update-refused", NOTICE_SUBJECT);
      return { ok: true, message: "Checked: InnyTypes is up to date." };
    }

    let file;
    try {
      file = pickReleaseFile(parsed.files, arch);
    } catch (error) {
      if (error instanceof ReleaseMetadataError) {
        return this.#refused(`${metadataUrl}: ${error.message}`);
      }
      throw error;
    }
    this.#emit({ kind: "found", version: parsed.version, at: this.#now() });
    const fetched = await this.#checkArtifact(feedBaseUrl, file);
    if (fetched !== null) {
      return fetched;
    }

    notifier.clear("core-update-refused", NOTICE_SUBJECT);
    notifier.raise({
      kind: "core-update-available",
      subject: NOTICE_SUBJECT,
      version: parsed.version,
    });
    try {
      await this.#ports.selfUpdater.checkForUpdates();
      this.#staged = true;
      this.#emit({ kind: "progress", percent: 100 });
      this.#emit({ kind: "downloaded" });
    } catch (error) {
      this.#emit({ kind: "failed", reason: "no-connection" });
      // The verified feed is good; only the platform updater's own network call failed. Not
      // a refusal (nothing was tampered with), so no notice, but nothing is staged either.
      logger.warn(`update: the platform updater could not be reached: ${reasonOf(error)}`);
    }
    return { ok: true, message: `Checked: InnyTypes ${parsed.version} is available.` };
  }

  /**
   * Go back (plan 0022 §G, D4; plan 0003 D10: going back is as verified as going forward). The
   * older release's own `latest-*.yml` and `.minisig` are fetched from its tag, verified with the
   * key this build embeds, and must name exactly the version asked for; its artifact's bytes are
   * checked against the signed sha512. Only then is the platform updater pinned to that release
   * with downgrades allowed; it installs at quit. Anything refused is a safety-check failure: an
   * older release that does not verify is never installed, whoever serves it.
   */
  async goBack(to: { readonly version: string; readonly tag: string }): Promise<UpdateOutcome> {
    const { logger } = this.#ports.report;
    this.#staged = false;
    const policy = this.#policy();
    if (!policy.ok) {
      return this.#failed(policy.why);
    }
    const base = this.#ports.tagBaseUrl(to.tag);
    const signed = await this.#readSigned(base, policy.value.channel, "safety-check");
    if (!signed.ok) {
      return signed.outcome;
    }
    const { parsed, metadataUrl } = signed;
    if (parsed.version !== to.version) {
      return this.#refused(
        `${metadataUrl} names ${parsed.version}, not ${to.version}`,
        "safety-check",
      );
    }
    let file;
    try {
      file = pickReleaseFile(parsed.files, this.#ports.arch);
    } catch (error) {
      if (error instanceof ReleaseMetadataError) {
        return this.#refused(`${metadataUrl}: ${error.message}`, "safety-check");
      }
      throw error;
    }
    const fetched = await this.#checkArtifact(base, file, "safety-check");
    if (fetched !== null) {
      return fetched;
    }
    logger.info(`update: going back to ${to.version}: ${metadataUrl} and its artifact verified`);
    try {
      await this.#ports.selfUpdater.downloadRelease(base);
    } catch (error) {
      return this.#failed(
        `the platform updater could not fetch ${to.version}: ${reasonOf(error)}`,
        "no-connection",
      );
    }
    this.#staged = true;
    return { ok: true, message: `Verified: InnyTypes ${to.version} installs when you quit.` };
  }

  #policy():
    | { readonly ok: true; readonly value: UpdatePolicy }
    | { readonly ok: false; readonly why: string } {
    try {
      return { ok: true, value: parseUpdatePolicy(this.#ports.settings.readUpdate()) };
    } catch (error) {
      return { ok: false, why: `the update settings cannot be read: ${reasonOf(error)}` };
    }
  }

  /**
   * A release's `latest-*.yml` under `base`, read only once its minisign signature verified
   * against the embedded key. `refusal` is the reason a refused document is reported with.
   */
  async #readSigned(
    base: string,
    channel: string,
    refusal: CheckFailure | "safety-check",
  ): Promise<
    | { readonly ok: true; readonly parsed: ReleaseMetadata; readonly metadataUrl: string }
    | { readonly ok: false; readonly outcome: UpdateOutcome }
  > {
    const { platform, publicKey } = this.#ports;
    const { http, verifier } = this.#ports.transport;
    const metadataUrl = joinUrl(base, metadataFileName(channel, platform));
    const signatureUrl = `${metadataUrl}${METADATA_SIGNATURE_SUFFIX}`;
    const failed = (outcome: UpdateOutcome) => ({ ok: false as const, outcome });

    const metadata = await http.get(metadataUrl, { maxBytes: MAX_METADATA_BYTES });
    if (!metadata.ok) {
      return failed(
        this.#failed(`${metadataUrl} could not be read: ${metadata.detail}`, "no-connection"),
      );
    }
    const signature = await http.get(signatureUrl, { maxBytes: MAX_SIGNATURE_BYTES });
    if (!signature.ok) {
      return failed(
        this.#failed(`${signatureUrl} could not be read: ${signature.detail}`, "no-connection"),
      );
    }
    if (publicKey === null) {
      // The alternative to refusing is installing whatever a server sends, unverified.
      return failed(
        this.#refused("this build ships no public key to verify an update with", refusal),
      );
    }

    let signatureText: string;
    try {
      signatureText = new TextDecoder("utf-8", { fatal: true }).decode(signature.body);
    } catch {
      return failed(this.#refused(`${signatureUrl} is not UTF-8 text`, refusal));
    }
    try {
      verifier.verify(metadata.body, signatureText, publicKey);
    } catch (error) {
      if (error instanceof MinisignError) {
        return failed(this.#refused(`${metadataUrl} did not verify: ${error.message}`, refusal));
      }
      throw error;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(metadata.body);
      return { ok: true, parsed: parseReleaseMetadata(text), metadataUrl };
    } catch (error) {
      if (error instanceof ReleaseMetadataError) {
        // Signed, but not understood: refused all the same, never read in part.
        return failed(
          this.#refused(`${metadataUrl} is signed but could not be read: ${error.message}`, refusal),
        );
      }
      throw error;
    }
  }

  /** The artifact the signed metadata names, fetched and checked against its sha512; null when good. */
  async #checkArtifact(
    base: string,
    file: ReleaseFile,
    refusal: CheckFailure | "safety-check" = "safety-check",
  ): Promise<UpdateOutcome | null> {
    const { http, sha512 } = this.#ports.transport;
    const artifactUrl = joinUrl(base, file.url);
    const artifact = await http.get(artifactUrl, {
      maxBytes: Math.max(MAX_ARTIFACT_BYTES, file.size),
    });
    if (!artifact.ok) {
      return this.#failed(`${artifactUrl} could not be read: ${artifact.detail}`, "no-connection");
    }
    if (sha512(artifact.body) !== file.sha512) {
      return this.#refused(
        `${artifactUrl} does not match the sha512 the signed metadata named`,
        refusal,
      );
    }
    return null;
  }

  /** Install the verified update now; a no-op unless the last check staged one. */
  installAtQuit(): void {
    if (this.#staged) {
      this.#ports.selfUpdater.quitAndInstall();
    }
  }

  /** The first check, after `firstMs`; then once a day, whatever this check found. */
  schedule(firstMs: number): void {
    const { clock } = this.#ports.session;
    const tick = (): void => {
      void this.check().then((outcome) => {
        if (!outcome.ok) {
          this.#ports.report.logger.warn(`update check: ${outcome.error}`);
        }
        this.#cancelSchedule = clock.after(24 * 60 * 60 * 1000, tick);
      });
    };
    this.#cancelSchedule = clock.after(firstMs, tick);
  }

  stop(): void {
    this.#cancelSchedule?.();
    this.#cancelSchedule = null;
  }

  #emit(event: UpdateEvent): void {
    this.#ports.onEvent?.(event);
  }

  #now(): Date {
    return new Date(this.#ports.session.clock.now());
  }

  #failed(why: string, reason: CheckFailure = "unreadable"): UpdateOutcome {
    this.#emit({ kind: "failed", reason });
    this.#ports.report.logger.warn(`update check: ${why}`);
    return { ok: false, error: `Not checked: ${why}.` };
  }

  /** A feed or an artifact this build will not trust: a safety-check failure once a version was found. */
  #refused(why: string, reason: CheckFailure | "safety-check" = "unreadable"): UpdateOutcome {
    this.#emit({ kind: "failed", reason });
    const { notifier, logger } = this.#ports.report;
    logger.warn(`update check: refused: ${why}`);
    notifier.clear("core-update-available", NOTICE_SUBJECT);
    notifier.raise({ kind: "core-update-refused", subject: NOTICE_SUBJECT, detail: why });
    return { ok: false, error: `Refused: ${why}.` };
  }
}
