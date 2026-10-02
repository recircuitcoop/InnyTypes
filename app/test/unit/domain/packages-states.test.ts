import { describe, expect, it } from "vitest";
import {
  INSTALLATION_STATES,
  PACKAGE_UPDATE_STATES,
  REGISTRATION_STATES,
  ROLLBACK_WINDOW_MS,
  advanceInstall,
  checkForChanges,
  finishUpdate,
  install,
  isBusy,
  register,
  remove,
  rollBack,
  rollbackOffered,
  rowActions,
  unregister,
  update,
  type Installation,
  type Outcome,
  type Package,
  type PackageUpdate,
  type Refusal,
  type Registration,
} from "../../../src/domain/packages/states";

const T0 = new Date(2026, 9, 2, 9, 0);
const later = (ms: number) => new Date(T0.getTime() + ms);
const DAY = 24 * 60 * 60 * 1000;

function pkg(overrides: Partial<Package> = {}): Package {
  return {
    name: "innyrize",
    version: "0.3",
    source: { kind: "catalogue" },
    signed: true,
    shipped: false,
    registration: { state: "registered", verifiedAt: T0 },
    installation: { state: "installed", verifiedAt: T0 },
    update: { state: "up-to-date", verifiedAt: T0 },
    ...overrides,
  };
}

function ok(outcome: Outcome): Package {
  if (outcome.kind !== "done") {
    throw new Error(`refused: ${JSON.stringify(outcome.refusal)}`);
  }
  return outcome.package;
}

function refusal(outcome: Outcome): Refusal {
  if (outcome.kind !== "refused") {
    throw new Error("expected a refusal");
  }
  return outcome.refusal;
}

const updated = (at: Date = T0): PackageUpdate => ({
  state: "updated",
  version: "0.4",
  previous: "0.3",
  at,
  rollbackUntil: new Date(at.getTime() + ROLLBACK_WINDOW_MS),
  verifiedAt: at,
});

describe("no state without verifiedAt", () => {
  // Every state of every facet, built the only way the types allow: with its verifiedAt.
  const registrations: Registration[] = [
    { state: "registered", verifiedAt: T0 },
    { state: "not-registered", verifiedAt: T0 },
  ];
  const installations: Installation[] = [
    { state: "installed", verifiedAt: T0 },
    { state: "not-installed", verifiedAt: T0 },
    { state: "installing", progress: 60, verifiedAt: T0 },
    { state: "verifying", verifiedAt: T0 },
    { state: "failed-check", reason: "files", verifiedAt: T0 },
  ];
  const updates: PackageUpdate[] = [
    { state: "up-to-date", verifiedAt: T0 },
    { state: "available", version: "0.4", verifiedAt: T0 },
    { state: "updating", version: "0.4", verifiedAt: T0 },
    updated(),
  ];

  it("every state is constructed, and each one carries verifiedAt", () => {
    expect(registrations.map((s) => s.state)).toEqual(REGISTRATION_STATES);
    expect(installations.map((s) => s.state)).toEqual(INSTALLATION_STATES);
    expect(updates.map((s) => s.state)).toEqual(PACKAGE_UPDATE_STATES);
    for (const state of [...registrations, ...installations, ...updates]) {
      expect(state.verifiedAt).toBeInstanceOf(Date);
    }
  });

  it("a state without verifiedAt does not compile", () => {
    // @ts-expect-error verifiedAt is required on every state
    const missing: Registration = { state: "registered" };
    expect(missing).toBeDefined();
  });

  it("every transition's new facet carries the time it was verified", () => {
    const at = later(1000);
    const fresh = pkg({
      registration: { state: "not-registered", verifiedAt: T0 },
      installation: { state: "not-installed", verifiedAt: T0 },
      update: null,
    });
    const installing = ok(install(fresh, at));
    expect(installing.installation?.verifiedAt).toBe(at);
    const installed = ok(advanceInstall(installing, { kind: "verified" }, at));
    expect(ok(register(installed, at)).registration?.verifiedAt).toBe(at);
    const checked = ok(checkForChanges(installed, { kind: "newer", version: "0.4" }, at));
    expect(checked.update?.verifiedAt).toBe(at);
  });

  it("an unverified facet shows nothing and offers none of its actions", () => {
    const actions = rowActions(pkg({ registration: null, installation: null, update: null }), T0);
    expect(actions).toEqual({ enabled: [], disabled: [] });
  });
});

describe("registration (D6)", () => {
  it("registers an installed package", () => {
    const next = ok(
      register(pkg({ registration: { state: "not-registered", verifiedAt: T0 } }), T0),
    );
    expect(next.registration?.state).toBe("registered");
  });

  it("refuses to register what is not installed, already registered, or busy", () => {
    const notInstalled = pkg({
      registration: { state: "not-registered", verifiedAt: T0 },
      installation: { state: "not-installed", verifiedAt: T0 },
    });
    expect(refusal(register(notInstalled, T0))).toEqual({ reason: "not-installed" });
    expect(refusal(register(pkg(), T0))).toEqual({ reason: "nothing-to-do" });
    const busy = pkg({ installation: { state: "verifying", verifiedAt: T0 } });
    expect(refusal(register(busy, T0))).toEqual({ reason: "busy" });
  });

  it("unregisters a package no flow uses, a shipped one included", () => {
    const next = ok(unregister(pkg({ shipped: true }), [], T0));
    expect(next.registration?.state).toBe("not-registered");
  });

  it("refusal names every flow and step that uses it, not only the first", () => {
    const uses = [
      { flow: "Recordings to Anytype", step: "Transcribe" },
      { flow: "Invoices from the mailbox", step: "Read PDF" },
      { flow: "Recordings to Anytype", step: "Transcribe" },
      { flow: "Recordings to Anytype", step: "Diarize" },
    ];
    expect(refusal(unregister(pkg(), uses, T0))).toEqual({
      reason: "in-use",
      action: "unregister",
      uses: [
        { flow: "Recordings to Anytype", step: "Transcribe" },
        { flow: "Invoices from the mailbox", step: "Read PDF" },
        { flow: "Recordings to Anytype", step: "Diarize" },
      ],
    });
  });

  it("refuses to unregister twice, or while busy", () => {
    const off = pkg({ registration: { state: "not-registered", verifiedAt: T0 } });
    expect(refusal(unregister(off, [], T0))).toEqual({ reason: "nothing-to-do" });
    const busy = pkg({ update: { state: "updating", version: "0.4", verifiedAt: T0 } });
    expect(refusal(unregister(busy, [], T0))).toEqual({ reason: "busy" });
  });
});

describe("installation", () => {
  const absent = pkg({
    registration: { state: "not-registered", verifiedAt: T0 },
    installation: { state: "not-installed", verifiedAt: T0 },
    update: null,
  });

  it("goes installing, verifying, installed, with progress clamped to whole percents", () => {
    let current = ok(install(absent, T0));
    expect(current.installation).toEqual({ state: "installing", progress: 0, verifiedAt: T0 });
    current = ok(advanceInstall(current, { kind: "progress", percent: 59.6 }, T0));
    expect(current.installation).toEqual({ state: "installing", progress: 60, verifiedAt: T0 });
    expect(
      ok(advanceInstall(current, { kind: "progress", percent: 140 }, T0)).installation,
    ).toEqual({ state: "installing", progress: 100, verifiedAt: T0 });
    expect(ok(advanceInstall(current, { kind: "progress", percent: -3 }, T0)).installation).toEqual(
      { state: "installing", progress: 0, verifiedAt: T0 },
    );
    current = ok(advanceInstall(current, { kind: "verifying" }, T0));
    expect(current.installation?.state).toBe("verifying");
    expect(isBusy(current)).toBe(true);
    current = ok(advanceInstall(current, { kind: "verified" }, T0));
    expect(current.installation?.state).toBe("installed");
    expect(isBusy(current)).toBe(false);
  });

  it("a failed check keeps its reason and may be installed again", () => {
    const installing = ok(install(absent, T0));
    const failed = ok(
      advanceInstall(installing, { kind: "failed-check", reason: "signature" }, T0),
    );
    expect(failed.installation).toEqual({
      state: "failed-check",
      reason: "signature",
      verifiedAt: T0,
    });
    expect(ok(install(failed, T0)).installation?.state).toBe("installing");
  });

  it("the re-check at start judges an installed package", () => {
    const failed = ok(advanceInstall(pkg(), { kind: "failed-check", reason: "content-moved" }, T0));
    expect(failed.installation?.state).toBe("failed-check");
  });

  it("progress and verifying only move an install under way", () => {
    expect(refusal(advanceInstall(pkg(), { kind: "progress", percent: 10 }, T0))).toEqual({
      reason: "nothing-to-do",
    });
    expect(refusal(advanceInstall(pkg(), { kind: "verifying" }, T0))).toEqual({
      reason: "nothing-to-do",
    });
  });

  it("refuses to install what is installed, or while busy", () => {
    expect(refusal(install(pkg(), T0))).toEqual({ reason: "nothing-to-do" });
    expect(refusal(install(ok(install(absent, T0)), T0))).toEqual({ reason: "busy" });
  });

  it("removes a package no flow uses; it is then not installed and not registered", () => {
    const gone = ok(remove(pkg(), [], T0));
    expect(gone.installation?.state).toBe("not-installed");
    expect(gone.registration?.state).toBe("not-registered");
    expect(gone.update).toBeNull();
  });

  it("a shipped package is never removed", () => {
    expect(refusal(remove(pkg({ shipped: true }), [], T0))).toEqual({ reason: "shipped" });
  });

  it("refuses to remove while used, naming every use, with remove", () => {
    const uses = [{ flow: "Recordings to Anytype", step: "Transcribe" }];
    expect(refusal(remove(pkg(), uses, T0))).toEqual({ reason: "in-use", action: "remove", uses });
  });

  it("refuses to remove what is not installed, or while busy", () => {
    expect(refusal(remove(absent, [], T0))).toEqual({ reason: "not-installed" });
    expect(refusal(remove(pkg({ installation: null }), [], T0))).toEqual({
      reason: "not-installed",
    });
    expect(refusal(remove(ok(install(absent, T0)), [], T0))).toEqual({ reason: "busy" });
  });
});

describe("update and check for changes", () => {
  it("a check words what it found", () => {
    expect(ok(checkForChanges(pkg(), { kind: "current" }, T0)).update?.state).toBe("up-to-date");
    expect(ok(checkForChanges(pkg(), { kind: "newer", version: "0.4" }, T0)).update).toEqual({
      state: "available",
      version: "0.4",
      verifiedAt: T0,
    });
  });

  it("a moved version is never applied; an unchecked source keeps the last verified facet", () => {
    expect(
      refusal(checkForChanges(pkg(), { kind: "moved", version: "0.3", hash: "ab" }, T0)),
    ).toEqual({ reason: "content-moved", version: "0.3" });
    expect(refusal(checkForChanges(pkg(), { kind: "unchecked", reason: "offline" }, T0))).toEqual({
      reason: "unchecked",
      detail: "offline",
    });
  });

  it("a check keeps a recent update and its Go back, re-stamped", () => {
    const recent = pkg({ version: "0.4", update: updated() });
    const at = later(DAY);
    expect(ok(checkForChanges(recent, { kind: "current" }, at)).update).toEqual({
      ...updated(),
      verifiedAt: at,
    });
    const old = later(8 * DAY);
    expect(ok(checkForChanges(recent, { kind: "current" }, old)).update?.state).toBe("up-to-date");
  });

  it("refuses a check while busy or not installed", () => {
    const busy = pkg({ update: { state: "updating", version: "0.4", verifiedAt: T0 } });
    expect(refusal(checkForChanges(busy, { kind: "current" }, T0))).toEqual({ reason: "busy" });
    const absent = pkg({ installation: { state: "not-installed", verifiedAt: T0 } });
    expect(refusal(checkForChanges(absent, { kind: "current" }, T0))).toEqual({
      reason: "not-installed",
    });
  });

  it("updates, then offers Go back for seven days", () => {
    const available = pkg({ update: { state: "available", version: "0.4", verifiedAt: T0 } });
    const updating = ok(update(available, T0));
    expect(updating.update).toEqual({ state: "updating", version: "0.4", verifiedAt: T0 });
    const done = ok(finishUpdate(updating, true, T0));
    expect(done.version).toBe("0.4");
    expect(done.update).toEqual(updated());
  });

  it("a failed update keeps the version and offers the update again", () => {
    const updating = ok(
      update(pkg({ update: { state: "available", version: "0.4", verifiedAt: T0 } }), T0),
    );
    const failed = ok(finishUpdate(updating, false, T0));
    expect(failed.version).toBe("0.3");
    expect(failed.update).toEqual({ state: "available", version: "0.4", verifiedAt: T0 });
  });

  it("refuses an update with nothing to update, not installed, or busy", () => {
    expect(refusal(update(pkg(), T0))).toEqual({ reason: "nothing-to-do" });
    expect(refusal(finishUpdate(pkg(), true, T0))).toEqual({ reason: "nothing-to-do" });
    const absent = pkg({ installation: { state: "not-installed", verifiedAt: T0 } });
    expect(refusal(update(absent, T0))).toEqual({ reason: "not-installed" });
    const busy = pkg({ update: { state: "updating", version: "0.4", verifiedAt: T0 } });
    expect(refusal(update(busy, T0))).toEqual({ reason: "busy" });
  });
});

describe("Go back (D5)", () => {
  const recent = pkg({ version: "0.4", update: updated() });

  it("is offered for seven days after an update, not after", () => {
    expect(rollbackOffered(updated(), later(7 * DAY - 1))).toBe(true);
    expect(rollbackOffered(updated(), later(7 * DAY))).toBe(false);
    expect(rollbackOffered({ state: "up-to-date", verifiedAt: T0 }, T0)).toBe(false);
    expect(rollbackOffered(null, T0)).toBe(false);
  });

  it("goes back within seven days and offers the version it left as an update", () => {
    const back = ok(rollBack(recent, later(DAY)));
    expect(back.version).toBe("0.3");
    expect(back.update).toEqual({ state: "available", version: "0.4", verifiedAt: later(DAY) });
  });

  it("is refused after seven days, or without an update", () => {
    expect(refusal(rollBack(recent, later(7 * DAY)))).toEqual({ reason: "rollback-expired" });
    expect(refusal(rollBack(pkg(), T0))).toEqual({ reason: "rollback-expired" });
  });

  it("is refused while busy or not installed", () => {
    const absent = pkg({
      installation: { state: "not-installed", verifiedAt: T0 },
      update: updated(),
    });
    expect(refusal(rollBack(absent, T0))).toEqual({ reason: "not-installed" });
    const busy = pkg({ installation: { state: "verifying", verifiedAt: T0 }, update: updated() });
    expect(refusal(rollBack(busy, T0))).toEqual({ reason: "busy" });
  });
});

describe("rowActions (design-system Package row)", () => {
  it("a registered, installed, up-to-date catalogue package", () => {
    expect(rowActions(pkg(), T0)).toEqual({
      enabled: ["unregister", "remove"],
      disabled: ["update"],
    });
  });

  it("an update available is enabled; a shipped package never offers Remove", () => {
    const available = pkg({
      shipped: true,
      update: { state: "available", version: "0.4", verifiedAt: T0 },
    });
    expect(rowActions(available, T0)).toEqual({
      enabled: ["unregister", "update"],
      disabled: ["remove"],
    });
  });

  it("not installed: Install; Register waits for the install", () => {
    const absent = pkg({
      registration: { state: "not-registered", verifiedAt: T0 },
      installation: { state: "not-installed", verifiedAt: T0 },
      update: null,
    });
    expect(rowActions(absent, T0)).toEqual({ enabled: ["install"], disabled: ["register"] });
  });

  it("while installing nothing new starts", () => {
    const installing = pkg({
      registration: { state: "not-registered", verifiedAt: T0 },
      installation: { state: "installing", progress: 60, verifiedAt: T0 },
      update: null,
    });
    expect(rowActions(installing, T0)).toEqual({ enabled: [], disabled: ["register", "install"] });
  });

  it("a folder offers Check for changes instead of Update", () => {
    const folder = pkg({ source: { kind: "folder", path: "~/packages/innyrize" }, signed: false });
    expect(rowActions(folder, T0)).toEqual({
      enabled: ["unregister", "remove", "check-for-changes"],
      disabled: [],
    });
  });

  it("Go back for seven days after an update, then gone", () => {
    const recent = pkg({ version: "0.4", update: updated() });
    expect(rowActions(recent, later(DAY))).toEqual({
      enabled: ["unregister", "remove", "go-back"],
      disabled: ["update"],
    });
    expect(rowActions(recent, later(7 * DAY))).toEqual({
      enabled: ["unregister", "remove"],
      disabled: ["update"],
    });
  });

  it("while updating every action waits", () => {
    const updating = pkg({ update: { state: "updating", version: "0.4", verifiedAt: T0 } });
    expect(rowActions(updating, T0)).toEqual({
      enabled: [],
      disabled: ["unregister", "remove", "update"],
    });
  });
});
