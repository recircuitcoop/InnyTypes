// Configuration › General › Packages (plan 0022 §F; ux-writing "Configuration › General",
// Packages; design-system "Package row"): "4 installed · 1 update", Add a package… (From the
// catalogue · From a folder on this Mac…), and one Package row per package with its verified
// states, each with "checked when", and its actions. A folder is unsigned: it is installed only
// after the dialog "Install an unsigned package?" is answered Install anyway. Go back confirms
// once. A refused action is said under the rows, in words: an unregister or a removal refused
// while a flow uses the package names every flow and step that does (D6).
//
// The rows come from the packages store (ui/store.ts), asked again on every `packages` push.
import { useState } from "react";
import type { AppApi } from "../contract";
import type { Answer } from "../answer";
import type { PackageOffer, PackageView, PackagesView } from "../general-contract";
import type { RowAction } from "../../domain/packages/states";
import { Button, type ButtonKind } from "../components/atoms/Button";
import type { StatusPillState } from "../components/atoms/StatusPill";
import { DialogButtons } from "../components/molecules/DialogButtons";
import { InlineMessage } from "../components/molecules/InlineMessage";
import { Menu } from "../components/molecules/Menu";
import { MenuItem } from "../components/molecules/MenuItem";
import { Dialog } from "../components/organisms/Dialog";
import { GeneralSection } from "../components/organisms/GeneralSection";
import {
  PackageRow,
  type PackageFacet,
  type PackageRowState,
} from "../components/organisms/PackageRow";
import { nameParts, packagesLine, withoutMarks } from "../general";
import { usePackages } from "../store";
import { t, type PlainKey } from "../strings";
import {
  wordCaptions,
  wordChecked,
  wordInstallation,
  wordPackageGoBack,
  wordPackageUpdate,
  wordRefusal,
  wordRegistration,
} from "../words";

type Pkg = PackageView["package"];

/** A line with its `*names*` in italics. */
function Named({ text }: { readonly text: string }) {
  return (
    <>
      {nameParts(text).map((part, index) =>
        part.name ? <em key={index}>{part.text}</em> : <span key={index}>{part.text}</span>,
      )}
    </>
  );
}

/** The row's look: the state its most pressing fact puts it in. */
function rowState(pkg: Pkg): PackageRowState {
  switch (pkg.installation?.state) {
    case "installing":
      return "installing";
    case "verifying":
      return "verifying";
    case "failed-check":
      return "failed-check";
    default:
      break;
  }
  switch (pkg.update?.state) {
    case "available":
      return "update-available";
    case "updating":
      return "updating";
    case "updated":
      return "updated";
    default:
      break;
  }
  if (pkg.source.kind === "folder") {
    return "from-a-folder";
  }
  return pkg.registration?.state === "not-registered" ? "not-registered" : "registered";
}

const INSTALLATION_PILL: Record<NonNullable<Pkg["installation"]>["state"], StatusPillState> = {
  installed: "done",
  "not-installed": "off",
  installing: "running",
  verifying: "running",
  "failed-check": "failed",
};

const UPDATE_PILL: Record<NonNullable<Pkg["update"]>["state"], StatusPillState> = {
  "up-to-date": "done",
  available: "waiting",
  changed: "failed",
  updating: "running",
  updated: "done",
};

/** Every verified fact of the row, each with when it was checked; an unverified one is left out. */
function facetsOf(pkg: Pkg, now: Date): PackageFacet[] {
  const facets: PackageFacet[] = [];
  if (pkg.registration !== null) {
    facets.push({
      state: pkg.registration.state === "registered" ? "done" : "off",
      label: wordRegistration(pkg.registration),
      checked: wordChecked(pkg.registration.verifiedAt, now),
    });
  }
  if (pkg.installation !== null) {
    facets.push({
      state: INSTALLATION_PILL[pkg.installation.state],
      label: wordInstallation(pkg.installation),
      checked: wordChecked(pkg.installation.verifiedAt, now),
    });
  }
  if (pkg.update !== null) {
    facets.push({
      state: UPDATE_PILL[pkg.update.state],
      label: wordPackageUpdate(pkg.update, now),
      checked: wordChecked(pkg.update.verifiedAt, now),
    });
  }
  return facets;
}

/** Each action's button: its look and its words. */
const ACTION: Record<Exclude<RowAction, "go-back">, { kind: ButtonKind; label: PlainKey }> = {
  register: { kind: "quiet", label: "packages.register" },
  unregister: { kind: "quiet", label: "packages.unregister" },
  install: { kind: "secondary", label: "packages.install" },
  remove: { kind: "secondary", label: "packages.remove" },
  update: { kind: "primary", label: "packages.update" },
  "check-for-changes": { kind: "secondary", label: "packages.checkForChanges" },
};

/** A line under the rows: what an action came to when it did not happen. */
type Said = { readonly kind: "failed" | "done"; readonly text: string } | null;

export function PackagesSection({ api }: { readonly api: AppApi }) {
  const packages = usePackages();
  const [said, say] = useState<Said>(null);
  /** The folder chosen, waiting for the unsigned dialog's answer. */
  const [unsigned, setUnsigned] = useState<string | null>(null);
  const [goingBack, setGoingBack] = useState<Pkg | null>(null);
  const [catalogue, setCatalogue] = useState(false);
  const act = (call: () => Promise<Answer<unknown>>) => {
    say(null);
    void call().then((answer) => {
      if (!answer.ok) say({ kind: "failed", text: wordRefusal(answer.refused) });
    });
  };
  const chooseFolder = () => {
    act(async () => {
      const chosen = await api.chooseInstallFolder();
      if (chosen.ok && chosen.value.folder !== null) setUnsigned(chosen.value.folder);
      return chosen;
    });
  };
  const view: PackagesView | null = packages.status === "ready" ? packages.value : null;
  const now = new Date();
  const run = (pkg: Pkg, action: RowAction) => {
    const { name } = pkg;
    switch (action) {
      case "register":
        act(() => api.registerPackage(name));
        return;
      case "unregister":
        act(() => api.unregisterPackage(name));
        return;
      case "remove":
        act(() => api.uninstallPackage(name));
        return;
      case "update":
        act(() => api.updatePackage(name));
        return;
      case "check-for-changes":
        act(() => api.checkFolder(name));
        return;
      case "go-back":
        setGoingBack(pkg);
        return;
      case "install":
        // Every row is an installed package: a catalogue's entries are installed from the list.
        return;
    }
  };
  return (
    <GeneralSection
      section="packages"
      title={t("general.packages")}
      state={
        <span data-testid="general-packages-state">
          {view === null ? null : packagesLine(view)}
        </span>
      }
    >
      <div>
        <Menu
          placement="bottom-start"
          trigger={
            <Button kind="secondary" data-testid="packages-add">
              {t("packages.add")}
            </Button>
          }
        >
          <MenuItem
            value="catalogue"
            label={t("packages.fromCatalogue")}
            onSelect={() => {
              setCatalogue(true);
            }}
          />
          <MenuItem value="folder" label={t("packages.fromFolderMenu")} onSelect={chooseFolder} />
        </Menu>
      </div>
      {catalogue && view !== null ? (
        <Offers
          offers={view.offers}
          onInstall={(offer) => {
            act(() => api.installCatalogueEntry(offer.source, offer.id));
          }}
        />
      ) : null}
      <ul data-testid="packages-rows" className="flex flex-col">
        {(view?.packages ?? []).map((row) => (
          <Row key={row.package.name} row={row} now={now} onAction={run} />
        ))}
      </ul>
      {said === null ? null : (
        <div data-testid="packages-message">
          <InlineMessage kind={said.kind}>
            <Named text={said.text} />
          </InlineMessage>
        </div>
      )}
      <Dialog
        kind="warning"
        open={unsigned !== null}
        title={t("packages.unsigned.title")}
        body={t("packages.unsigned.body")}
        onClose={() => {
          setUnsigned(null);
        }}
        buttons={
          <DialogButtons
            kind="neutral"
            primaryLabel={t("packages.installAnyway")}
            cancelLabel={t("dialog.cancel")}
            onPrimary={() => {
              const folder = unsigned;
              setUnsigned(null);
              if (folder !== null) act(() => api.installFolder(folder));
            }}
            onCancel={() => {
              setUnsigned(null);
            }}
          />
        }
      />
      <GoBackDialog
        pkg={goingBack}
        onClose={() => {
          setGoingBack(null);
        }}
        onGoBack={(name) => {
          setGoingBack(null);
          act(() => api.goBackPackage(name));
        }}
      />
    </GeneralSection>
  );
}

function Row({
  row,
  now,
  onAction,
}: {
  readonly row: PackageView;
  readonly now: Date;
  readonly onAction: (pkg: Pkg, action: RowAction) => void;
}) {
  const pkg = row.package;
  const button = (action: RowAction, enabled: boolean) => {
    const look =
      action === "go-back"
        ? {
            kind: "quiet" as const,
            label:
              pkg.update?.state === "updated" ? wordPackageGoBack(pkg.name, pkg.update).button : "",
          }
        : { kind: ACTION[action].kind, label: t(ACTION[action].label) };
    return (
      <Button
        key={action}
        kind={look.kind}
        state={enabled ? "default" : "disabled"}
        data-testid={`package-${action}`}
        onClick={() => {
          onAction(pkg, action);
        }}
      >
        {look.label}
      </Button>
    );
  };
  return (
    <PackageRow
      state={rowState(pkg)}
      name={pkg.name}
      version={pkg.version}
      publisher={
        row.publisher === null ? "" : withoutMarks(t("packages.by", { publisher: row.publisher }))
      }
      captions={wordCaptions(pkg)}
      facets={facetsOf(pkg, now)}
      actions={[
        ...row.actions.enabled.map((action) => button(action, true)),
        ...row.actions.disabled.map((action) => button(action, false)),
      ]}
    />
  );
}

function Offers({
  offers,
  onInstall,
}: {
  readonly offers: readonly PackageOffer[];
  readonly onInstall: (offer: PackageOffer) => void;
}) {
  if (offers.length === 0) {
    return (
      <p data-testid="packages-offers" className="text-body text-secondary">
        {t("packages.offers.none")}
      </p>
    );
  }
  return (
    <ul data-testid="packages-offers" className="flex flex-col gap-2">
      {offers.map((offer) => (
        <li
          key={`${offer.source}/${offer.id}`}
          data-testid="package-offer"
          data-id={offer.id}
          className="flex items-center gap-3"
        >
          <span className="text-body font-medium text-primary">{offer.name}</span>
          <span className="font-mono text-caption text-secondary">{offer.version}</span>
          <span className="flex-1 truncate text-caption text-secondary">{offer.summary}</span>
          <Button
            kind="secondary"
            data-testid="package-offer-install"
            onClick={() => {
              onInstall(offer);
            }}
          >
            {t("packages.install")}
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** Go back confirms once: "Go back to *innyrize* 0.3? The flows that use it keep running." */
function GoBackDialog({
  pkg,
  onClose,
  onGoBack,
}: {
  readonly pkg: Pkg | null;
  readonly onClose: () => void;
  readonly onGoBack: (name: string) => void;
}) {
  const update = pkg?.update;
  const words =
    pkg !== null && update?.state === "updated" ? wordPackageGoBack(pkg.name, update) : null;
  return (
    <Dialog
      kind="neutral"
      open={words !== null}
      title={words === null ? "" : withoutMarks(words.confirm)}
      body=""
      onClose={onClose}
      buttons={
        <DialogButtons
          kind="neutral"
          primaryLabel={t("general.goBack.yes")}
          cancelLabel={t("dialog.cancel")}
          onPrimary={() => {
            if (pkg !== null) onGoBack(pkg.name);
          }}
          onCancel={onClose}
        />
      }
    />
  );
}
