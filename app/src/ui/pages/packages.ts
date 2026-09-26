// The Packages page (WI-0018-16): every package here, what the catalogue offers, install from
// the catalogue, "Install from file…" for developers, and Remove. Install and removal restart
// only the runtime, so the page (served by the shell) stays as it is.
//
// An unsigned install is two presses: the file is chosen, then the person is told nobody
// vouches for it and must press "Install unsigned". An unsigned package is marked so in the list.

import type { AppApi, CatalogueOffer, ListedPackage, PackageOutcome } from "../contract";
import { attributeOf, escape } from "../view/render";
import type { Region, Section } from "./page";

export function packageListHtml(packages: readonly ListedPackage[]): string {
  if (packages.length === 0) {
    return '<p data-testid="packages-empty">No node packages are here.</p>';
  }
  const items = packages.map((listed) => {
    const unsigned = listed.signed
      ? ""
      : ' <strong data-testid="package-unsigned">unsigned</strong>';
    const remove =
      listed.kind === "installed"
        ? ` <button type="button" data-remove="${escape(listed.name)}" data-testid="package-remove">Remove</button>`
        : "";
    return (
      `<li data-testid="package-item" data-name="${escape(listed.name)}" data-kind="${listed.kind}">` +
      `${escape(listed.name)} ${escape(listed.version)} (${listed.kind})${unsigned}${remove}</li>`
    );
  });
  return `<ul data-testid="package-list">${items.join("")}</ul>`;
}

export function catalogueHtml(offers: readonly CatalogueOffer[], problem: string | null): string {
  if (problem !== null) {
    return `<p data-testid="catalogue-problem">No catalogue can be listed: ${escape(problem)}</p>`;
  }
  if (offers.length === 0) {
    return '<p data-testid="catalogue-empty">The catalogue offers no packages.</p>';
  }
  const items = offers.map((offer) => {
    const unverified = offer.verified ? "" : " (unverified catalogue)";
    const action = offer.installed
      ? " installed"
      : offer.installable
        ? ` <button type="button" data-install="${escape(offer.id)}" data-testid="catalogue-install">Install</button>`
        : " (not installable by this version)";
    return (
      `<li data-testid="catalogue-item" data-id="${escape(offer.id)}">` +
      `${escape(offer.id)}: ${escape(offer.summary)}${unverified}${action}</li>`
    );
  });
  return `<ul data-testid="catalogue-list">${items.join("")}</ul>`;
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

export interface PackagesPage {
  readonly section: Section;
  readonly list: Region;
  readonly catalogue: Region;
  /** Where the unsigned question is asked. */
  readonly question: Region;
  readonly message: Region;
}

/** Mount the page; the returned function draws it again (when the page is shown). */
export function mountPackages(page: PackagesPage, api: AppApi): () => Promise<void> {
  const say = (text: string): void => {
    page.message.innerHTML = escape(text);
  };
  const refresh = async (): Promise<void> => {
    const state = await api.packages();
    page.list.innerHTML = packageListHtml(state.packages);
    page.catalogue.innerHTML = catalogueHtml(state.catalogue, state.catalogueProblem);
  };
  /** Say what an install or removal came to, then draw the lists again. */
  const settle = async (outcome: PackageOutcome): Promise<void> => {
    say(outcome.ok ? outcome.message : outcome.error);
    await refresh();
  };
  const busy = (what: string): void => {
    page.question.innerHTML = "";
    say(`${what}…`);
  };

  page.section.on("click", (event) => {
    const install = attributeOf(event.target, "data-install");
    const remove = attributeOf(event.target, "data-remove");
    const confirmed = attributeOf(event.target, "data-confirm-unsigned");
    if (install !== null) {
      busy(`Installing ${install}`);
      void api.installFromCatalogue(install).then(settle);
    } else if (remove !== null) {
      busy(`Removing ${remove}`);
      void api.removePackage(remove).then(settle);
    } else if (attributeOf(event.target, "data-install-file") !== null) {
      say("");
      void api.chooseInstallFile().then((file) => {
        // Unsigned by nature: asked before anything is sent to be installed.
        page.question.innerHTML = file === null ? "" : unsignedQuestionHtml(file);
      });
    } else if (confirmed !== null) {
      busy(`Installing ${confirmed}, unsigned`);
      void api.installFromFile(confirmed, true).then(settle);
    } else if (attributeOf(event.target, "data-cancel-unsigned") !== null) {
      page.question.innerHTML = "";
      say("Nothing was installed.");
    } else if (attributeOf(event.target, "data-refresh") !== null) {
      say("");
      void refresh();
    }
  });
  return refresh;
}
