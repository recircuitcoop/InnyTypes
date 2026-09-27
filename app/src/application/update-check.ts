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
  type ReleasePlatform,
  type Sha512,
} from "../domain/update/release-metadata";
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
  readonly platform: ReleasePlatform;
  readonly arch: string;
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
   * Check the release feed for a newer version. Off in the settings: no request at all. A
   * network problem is logged and answered, never a notice (a server hiccup is not tampering).
   * A tampered feed or artifact IS a notice, once (application/notices.ts's NoticeBoard).
   */
  async check(): Promise<UpdateOutcome> {
    const { settings, platform, arch, publicKey, feedBaseUrl } = this.#ports;
    const { http, verifier, sha512 } = this.#ports.transport;
    const { notifier, logger } = this.#ports.report;
    this.#staged = false;
    let policy: UpdatePolicy;
    try {
      policy = parseUpdatePolicy(settings.readUpdate());
    } catch (error) {
      return this.#failed(`the update settings cannot be read: ${reasonOf(error)}`);
    }
    if (!policy.autoCheck) {
      logger.info("update check: off in the settings; nothing is asked");
      return { ok: true, message: "Not checked: checking for updates is off in the settings." };
    }

    const fileName = metadataFileName(policy.channel, platform);
    const metadataUrl = joinUrl(feedBaseUrl, fileName);
    const signatureUrl = `${metadataUrl}${METADATA_SIGNATURE_SUFFIX}`;

    const metadata = await http.get(metadataUrl, { maxBytes: MAX_METADATA_BYTES });
    if (!metadata.ok) {
      return this.#failed(`${metadataUrl} could not be read: ${metadata.detail}`);
    }
    const signature = await http.get(signatureUrl, { maxBytes: MAX_SIGNATURE_BYTES });
    if (!signature.ok) {
      return this.#failed(`${signatureUrl} could not be read: ${signature.detail}`);
    }

    if (publicKey === null) {
      // The alternative to refusing is installing whatever a server sends, unverified.
      return this.#refused("this build ships no public key to verify an update with");
    }

    let signatureText: string;
    try {
      signatureText = new TextDecoder("utf-8", { fatal: true }).decode(signature.body);
    } catch {
      return this.#refused(`${signatureUrl} is not UTF-8 text`);
    }
    try {
      verifier.verify(metadata.body, signatureText, publicKey);
    } catch (error) {
      if (error instanceof MinisignError) {
        return this.#refused(`${metadataUrl} did not verify: ${error.message}`);
      }
      throw error;
    }

    let parsed;
    try {
      parsed = parseReleaseMetadata(
        new TextDecoder("utf-8", { fatal: true }).decode(metadata.body),
      );
    } catch (error) {
      if (error instanceof ReleaseMetadataError) {
        // Signed, but not understood: refused all the same, never read in part.
        return this.#refused(`${metadataUrl} is signed but could not be read: ${error.message}`);
      }
      throw error;
    }

    const order = compareVersions(parsed.version, this.#ports.session.currentVersion());
    if (order === null || order <= 0) {
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
    const artifactUrl = joinUrl(feedBaseUrl, file.url);
    const artifact = await http.get(artifactUrl, {
      maxBytes: Math.max(MAX_ARTIFACT_BYTES, file.size),
    });
    if (!artifact.ok) {
      return this.#failed(`${artifactUrl} could not be read: ${artifact.detail}`);
    }
    if (sha512(artifact.body) !== file.sha512) {
      return this.#refused(`${artifactUrl} does not match the sha512 the signed metadata named`);
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
    } catch (error) {
      // The verified feed is good; only the platform updater's own network call failed. Not
      // a refusal (nothing was tampered with), so no notice, but nothing is staged either.
      logger.warn(`update: the platform updater could not be reached: ${reasonOf(error)}`);
    }
    return { ok: true, message: `Checked: InnyTypes ${parsed.version} is available.` };
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

  #failed(why: string): UpdateOutcome {
    this.#ports.report.logger.warn(`update check: ${why}`);
    return { ok: false, error: `Not checked: ${why}.` };
  }

  #refused(why: string): UpdateOutcome {
    const { notifier, logger } = this.#ports.report;
    logger.warn(`update check: refused: ${why}`);
    notifier.clear("core-update-available", NOTICE_SUBJECT);
    notifier.raise({ kind: "core-update-refused", subject: NOTICE_SUBJECT, detail: why });
    return { ok: false, error: `Refused: ${why}.` };
  }
}
