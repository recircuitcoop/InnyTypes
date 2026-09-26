// The Packages page (WI-0018-16, -17): three lists in the settings' order (what is installed,
// the official catalogue, then each registered source), install from a catalogue, "Install from
// file…" for developers, Remove, the update check with Apply, and the registered sources:
// register by name, URL and public key, remove, and switch auto-update. Install, removal and an
// update restart only the runtime, so the page (served by the shell) stays as it is.
//
// An unsigned install is two presses: the file is chosen (or a keyless source's entry pressed),
// then the person is told nobody vouches for it and must confirm. An unsigned package is marked
// so in the list. The page stays plain: its look is the owner's to redesign.

import type {
  AppApi,
  CatalogueOffer,
  ListedPackage,
  PackageOutcome,
  PackagesState,
  SourceListing,
  UpdateLine,
} from "../contract";
import { attributeOf, escape, formValues } from "../view/render";
import type { Region, Section } from "./page";

/** What the last check says about one package, and Apply when it is the person's to press. */
export function updateHtml(name: string, update: UpdateLine | null): string {
  if (update === null) {
    return "";
  }
  const version = escape(update.version ?? "");
  const detail = update.detail === null ? "" : `: ${escape(update.detail)}`;
  const said = {
    newer: `update available: ${version}${detail}`,
    moved: `not updated: ${version} changed without a new version${detail}`,
    failed: `the update to ${version} was rolled back and is held back${detail}`,
    unchecked: `not checked${detail}`,
  }[update.kind];
  const apply = update.apply
    ? ` <button type="button" data-apply="${escape(name)}" data-testid="package-apply">Apply</button>`
    : "";
  return ` <span data-testid="package-update" data-kind="${update.kind}">${said}</span>${apply}`;
}

export function packageListHtml(packages: readonly ListedPackage[]): string {
  if (packages.length === 0) {
    return '<p data-testid="packages-empty">No node packages are here.</p>';
  }
  const items = packages.map((listed) => {
    const unsigned = listed.signed
      ? ""
      : ' <strong data-testid="package-unsigned">unsigned</strong>';
    const from = listed.from === null ? "" : `, from ${escape(listed.from)}`;
    const mode =
      listed.mode === null ? "" : ` <span data-testid="package-mode">${listed.mode}</span>`;
    const remove =
      listed.kind === "installed"
        ? ` <button type="button" data-remove="${escape(listed.name)}" data-testid="package-remove">Remove</button>`
        : "";
    return (
      `<li data-testid="package-item" data-name="${escape(listed.name)}" data-kind="${listed.kind}">` +
      `${escape(listed.name)} ${escape(listed.version)} (${listed.kind}${from})${unsigned}${mode}` +
      `${updateHtml(listed.name, listed.update)}${remove}</li>`
    );
  });
  return `<ul data-testid="package-list">${items.join("")}</ul>`;
}

/** When the last check ran, or that none has. */
export function checkedHtml(checkedAt: number | null): string {
  return checkedAt === null
    ? '<p data-testid="packages-checked">No update check has run yet.</p>'
    : `<p data-testid="packages-checked">Last checked ${escape(new Date(checkedAt).toLocaleString())}.</p>`;
}

function offerHtml(offer: CatalogueOffer, attributes: string): string {
  const unverified = offer.verified ? "" : " (unverified catalogue)";
  const version = offer.version === null ? "" : ` ${escape(offer.version)}`;
  const action = offer.installed
    ? " installed"
    : offer.shadowedBy !== null
      ? ` <span data-testid="catalogue-shadowed">the ${escape(offer.shadowedBy)} catalogue's ${escape(offer.id)} is the one installed</span>`
      : offer.installable
        ? ` <button type="button" ${attributes} data-testid="catalogue-install">Install</button>`
        : " (not installable by this version)";
  return (
    `<li data-testid="catalogue-item" data-id="${escape(offer.id)}" data-source="${escape(offer.source)}">` +
    `${escape(offer.id)}${version}: ${escape(offer.summary)}${unverified}${action}</li>`
  );
}

export function catalogueHtml(offers: readonly CatalogueOffer[], problem: string | null): string {
  if (problem !== null) {
    return `<p data-testid="catalogue-problem">No catalogue can be listed: ${escape(problem)}</p>`;
  }
  if (offers.length === 0) {
    return '<p data-testid="catalogue-empty">The catalogue offers no packages.</p>';
  }
  const items = offers.map((offer) => offerHtml(offer, `data-install="${escape(offer.id)}"`));
  return `<ul data-testid="catalogue-list">${items.join("")}</ul>`;
}

/** The form a source is registered with. */
export const SOURCE_FORM =
  '<form data-form="source" data-testid="source-form">' +
  '<label>Name <input type="text" name="name" data-testid="source-name"></label> ' +
  '<label>Catalogue URL <input type="text" name="url" data-testid="source-url"></label> ' +
  '<label>Public key <input type="text" name="key" data-testid="source-key"></label> ' +
  '<button type="submit" data-testid="source-register">Register</button></form>';

function sourceHtml(source: SourceListing): string {
  const name = escape(source.name);
  const key = source.keyed
    ? "verified with its public key"
    : '<strong data-testid="source-unverified">no public key: unverified</strong>';
  const auto = source.autoUpdate === null ? "the default" : source.autoUpdate ? "on" : "off";
  const offers =
    source.problem !== null
      ? `<p data-testid="source-problem">${escape(source.problem)}</p>`
      : source.offers.length === 0
        ? '<p data-testid="catalogue-empty">It offers no packages.</p>'
        : `<ul data-testid="catalogue-list">${source.offers
            .map((offer) =>
              offerHtml(offer, `data-install-source="${escape(offer.id)}" data-source="${name}"`),
            )
            .join("")}</ul>`;
  return (
    `<li data-testid="source-item" data-name="${name}">` +
    `<p>${name}: ${escape(source.url)}, published by ` +
    `<span data-testid="source-publisher">${escape(source.publisher)}</span>, ${key}. ` +
    `Auto-update: <span data-testid="source-auto">${auto}</span> ` +
    `<button type="button" data-source-auto="${name}" data-on="${source.autoUpdate === true ? "0" : "1"}" data-testid="source-auto-switch">` +
    `${source.autoUpdate === true ? "Turn off" : "Turn on"}</button> ` +
    `<button type="button" data-source-remove="${name}" data-testid="source-remove">Remove</button></p>` +
    `${offers}</li>`
  );
}

export function sourcesHtml(sources: readonly SourceListing[], problem: string | null): string {
  const listed =
    problem !== null
      ? `<p data-testid="sources-problem">${escape(problem)}</p>`
      : sources.length === 0
        ? '<p data-testid="sources-empty">No other source is registered.</p>'
        : `<ul data-testid="source-list">${sources.map(sourceHtml).join("")}</ul>`;
  return listed + SOURCE_FORM;
}

/** The question an unsigned file asks before anything is installed. */
export function unsignedQuestionHtml(file: string): string {
  return (
    `<p data-testid="unsigned-question">${escape(file)} is not signed: nobody vouches for its ` +
    "code, and it will run with your permissions.</p>" +
    `<button type="button" data-confirm-unsigned="${escape(file)}" data-testid="unsigned-confirm">Install unsigned</button> ` +
    '<button type="button" data-cancel-unsigned="1" data-testid="unsigned-cancel">Cancel</button>'
  );
}

/** The question a keyless source's entry asks before anything is installed. */
export function unverifiedQuestionHtml(source: string, id: string, why: string): string {
  return (
    `<p data-testid="unsigned-question">${escape(why)}</p>` +
    `<button type="button" data-confirm-source="${escape(source)}" data-id="${escape(id)}" data-testid="unsigned-confirm">Install unverified</button> ` +
    '<button type="button" data-cancel-unsigned="1" data-testid="unsigned-cancel">Cancel</button>'
  );
}

export interface PackagesPage {
  readonly section: Section;
  readonly list: Region;
  readonly catalogue: Region;
  /** The registered sources and the form that registers one (WI-0018-17). */
  readonly sources: Region;
  /** Where the unsigned question is asked. */
  readonly question: Region;
  readonly message: Region;
}

/** Mount the page; the returned function draws it again (when the page is shown). */
export function mountPackages(page: PackagesPage, api: AppApi): () => Promise<void> {
  const say = (text: string): void => {
    page.message.innerHTML = escape(text);
  };
  const draw = (state: PackagesState): void => {
    page.list.innerHTML = checkedHtml(state.checkedAt) + packageListHtml(state.packages);
    page.catalogue.innerHTML = catalogueHtml(state.catalogue, state.catalogueProblem);
    page.sources.innerHTML = sourcesHtml(state.sources, state.sourcesProblem);
  };
  const refresh = async (): Promise<void> => {
    draw(await api.packages());
  };
  /** Say what a press came to, then draw the lists again. */
  const settle = async (outcome: PackageOutcome): Promise<void> => {
    say(outcome.ok ? outcome.message : outcome.error);
    await refresh();
  };
  const busy = (what: string): void => {
    page.question.innerHTML = "";
    say(`${what}…`);
  };

  page.section.on("click", (event) => {
    const target = event.target;
    const install = attributeOf(target, "data-install");
    const fromSource = attributeOf(target, "data-install-source");
    const remove = attributeOf(target, "data-remove");
    const apply = attributeOf(target, "data-apply");
    const confirmed = attributeOf(target, "data-confirm-unsigned");
    const confirmedSource = attributeOf(target, "data-confirm-source");
    const sourceAuto = attributeOf(target, "data-source-auto");
    const sourceRemove = attributeOf(target, "data-source-remove");
    if (install !== null) {
      busy(`Installing ${install}`);
      void api.installFromCatalogue(install).then(settle);
    } else if (fromSource !== null) {
      const source = attributeOf(target, "data-source") ?? "";
      busy(`Installing ${fromSource}`);
      void api.installFromSource(source, fromSource, false).then(async (outcome) => {
        if (!outcome.ok && outcome.needsConfirmation === true) {
          // Keyless: asked before anything is installed.
          say("");
          page.question.innerHTML = unverifiedQuestionHtml(source, fromSource, outcome.error);
          return;
        }
        await settle(outcome);
      });
    } else if (confirmedSource !== null) {
      const id = attributeOf(target, "data-id") ?? "";
      busy(`Installing ${id}, unverified`);
      void api.installFromSource(confirmedSource, id, true).then(settle);
    } else if (remove !== null) {
      busy(`Removing ${remove}`);
      void api.removePackage(remove).then(settle);
    } else if (apply !== null) {
      busy(`Updating ${apply}`);
      void api.applyPackageUpdate(apply).then(settle);
    } else if (attributeOf(target, "data-check") !== null) {
      busy("Checking for updates");
      void api.checkPackageUpdates().then(settle);
    } else if (sourceAuto !== null) {
      void api.setSourceAutoUpdate(sourceAuto, attributeOf(target, "data-on") === "1").then(settle);
    } else if (sourceRemove !== null) {
      void api.removeSource(sourceRemove).then(settle);
    } else if (attributeOf(target, "data-install-file") !== null) {
      say("");
      void api.chooseInstallFile().then((file) => {
        // Unsigned by nature: asked before anything is sent to be installed.
        page.question.innerHTML = file === null ? "" : unsignedQuestionHtml(file);
      });
    } else if (confirmed !== null) {
      busy(`Installing ${confirmed}, unsigned`);
      void api.installFromFile(confirmed, true).then(settle);
    } else if (attributeOf(target, "data-cancel-unsigned") !== null) {
      page.question.innerHTML = "";
      say("Nothing was installed.");
    } else if (attributeOf(target, "data-refresh") !== null) {
      say("");
      void refresh();
    }
  });
  page.section.on("submit", (event) => {
    event.preventDefault();
    if (attributeOf(event.target, "data-form") !== "source") {
      return;
    }
    const values = formValues(event.target);
    const field = (name: string): string => {
      const value = values[name];
      return typeof value === "string" ? value : "";
    };
    void api.registerSource(field("name"), field("url"), field("key")).then(settle);
  });
  return refresh;
}
