// The app frame (plan 0022 §M, §I): every surface sits in it. It reads the hash route, opens on
// Setup until Setup is completed and on Live after that (ui/routes.ts), and draws the screen's
// template with the Sidebar, the status pill, the runtime banner and the quit question.
//
// * The pill and the banner are the shell's StatusView (domain/status), pushed whenever a child's
//   status changes; the banner's Restart (Primary) asks the shell to restart the runtime.
// * The quit question (WI-0018-12) is a Dialog: Save and quit, Quit without saving, Cancel.
// * Live draws the flow's board (LiveScreen, WI-0022-12); Flows and the canvas are FlowsScreen and
//   CanvasScreen (WI-0022-14); General is GeneralScreen (WI-0022-18). The other screens' own
//   content belongs to later items (Run history WI-0022-15, Setup's steps WI-0022-16); until they
//   land a route draws its template with an empty content area.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AppApi, QuitChoice, QuitQuestion } from "../contract";
import type { StatusPill as Pill, StatusView } from "../general-contract";
import { StatusPill, type StatusPillState } from "../components/atoms/StatusPill";
import { DialogButtons } from "../components/molecules/DialogButtons";
import { InlineMessage } from "../components/molecules/InlineMessage";
import { TabStrip } from "../components/molecules/TabStrip";
import { Dialog } from "../components/organisms/Dialog";
import { RuntimeBanner } from "../components/organisms/RuntimeBanner";
import { Sidebar } from "../components/organisms/Sidebar";
import { PageCanvas } from "../components/templates/PageCanvas";
import { PageConfiguration } from "../components/templates/PageConfiguration";
import { PageLive } from "../components/templates/PageLive";
import { WindowSetup } from "../components/templates/WindowSetup";
import {
  LIVE,
  parseRoute,
  routeHash,
  settleRoute,
  SETUP_NAV,
  setupNavIndex,
  surfaceOf,
  type Route,
  type SetupNavEntry,
} from "../routes";
import { useSetup, useStatus, useUpdateState } from "../store";
import { t, type PlainKey } from "../strings";
import { wordBanner, wordStatus, wordUpdateGoBack } from "../words";
import { CanvasScreen } from "./CanvasScreen";
import { FlowsScreen } from "./FlowsScreen";
import { GalleryScreen } from "./GalleryScreen";
import { GeneralScreen } from "./GeneralScreen";
import { GoBackDialog } from "./GeneralUpdates";
import { LiveScreen } from "./LiveScreen";

/**
 * The pill's look for each state of the status (decided by WI-0022-11; the word always says
 * which): Running green, Restarting… and Needs attention amber, Stopped red.
 */
export const PILL_LOOK: Readonly<Record<Pill, StatusPillState>> = {
  running: "running",
  restarting: "waiting",
  needsAttention: "waiting",
  stopped: "failed",
};

/** The Setup sidebar's labels (ux-writing, the Setup sidebar). */
const SETUP_NAV_LABEL: Readonly<Record<SetupNavEntry, PlainKey>> = {
  welcome: "setup.nav.welcome",
  reports: "setup.nav.reports",
  anytype: "setup.nav.anytype",
  folder: "setup.nav.folder",
  steps: "setup.nav.steps",
  ready: "setup.nav.ready",
};

// ── the hash, kept current with useSyncExternalStore ─────────────────────────────────────────
const subscribeHash = (listener: () => void): (() => void) => {
  window.addEventListener("hashchange", listener);
  return () => {
    window.removeEventListener("hashchange", listener);
  };
};
const readHash = (): string => window.location.hash;

/** Go to a screen: a new history entry, as a link would make. */
const navigate = (route: Route): void => {
  window.location.hash = routeHash(route);
};

export function Frame({ api }: { readonly api: AppApi }) {
  const hash = useSyncExternalStore(subscribeHash, readHash, readHash);
  const setup = useSetup();
  const status = useStatus();
  const question = useQuitQuestion(api);

  const parsed = parseRoute(hash);
  const route = setup.status === "ready" ? settleRoute(parsed, setup.value) : null;
  // An address the frame does not show as written (a first launch, Setup not completed, an old
  // address) is replaced, so the address bar of history always names the screen shown.
  const settledHash = route === null ? null : routeHash(route);
  const shown = parsed === null ? null : routeHash(parsed);
  useEffect(() => {
    if (settledHash !== null && settledHash !== shown) {
      window.location.replace(settledHash);
    }
  }, [settledHash, shown]);

  // The quit question never waits on Setup: a quit with unsaved edits is asked even while Setup's
  // state is loading, or cannot be read at all.
  const quitDialog = <QuitDialog question={question.current} answer={question.answer} />;
  if (route === null) {
    return (
      <div data-testid="frame" data-route="loading">
        {quitDialog}
      </div>
    );
  }
  const view = status.status === "ready" ? status.value : null;
  const pill = view === null ? null : <StatusPillOf pill={view.pill} />;
  const banner = view === null ? null : <Banner view={view} api={api} />;
  return (
    <div data-testid="frame" data-route={route.screen} className="h-full">
      <Screen route={route} api={api} pill={pill} banner={banner} badge={view?.badge ?? 0} />
      {quitDialog}
    </div>
  );
}

function StatusPillOf({ pill }: { readonly pill: Pill }) {
  return (
    <span data-testid="status-pill" data-pill={pill}>
      <StatusPill state={PILL_LOOK[pill]}>{wordStatus(pill)}</StatusPill>
    </span>
  );
}

function Banner({ view, api }: { readonly view: StatusView; readonly api: AppApi }) {
  const update = useUpdateState();
  const [confirming, setConfirming] = useState(false);
  if (view.banner === null) {
    return null;
  }
  // The crash-loop offer (plan 0022 §G): Go back beside Restart, confirmed once; never applied.
  const offer = update.status === "ready" ? update.value.goBack : null;
  const goBack = offer?.because === "crash-loop" ? offer : null;
  return (
    <div data-testid="runtime-banner" data-banner={view.banner}>
      <RuntimeBanner
        state={view.banner}
        message={wordBanner(view.banner, view.crashLoop)}
        restartLabel={t("notify.restart")}
        onRestart={() => {
          void api.restartChild("runtime");
        }}
        {...(goBack === null
          ? {}
          : {
              goBackLabel: wordUpdateGoBack(goBack).button,
              onGoBack: () => {
                setConfirming(true);
              },
            })}
      />
      {goBack === null ? null : (
        <GoBackDialog
          offer={goBack}
          open={confirming}
          onClose={() => {
            setConfirming(false);
          }}
          onGoBack={() => {
            setConfirming(false);
            void api.goBack();
          }}
        />
      )}
    </div>
  );
}

interface ScreenProps {
  readonly route: Route;
  readonly api: AppApi;
  readonly pill: ReactNode;
  readonly banner: ReactNode;
  readonly badge: number;
}

function Screen({ route, api, pill, banner, badge }: ScreenProps) {
  if (route.screen === "gallery") {
    return <GalleryScreen />;
  }
  if (route.screen === "setup") {
    return <SetupScreen step={route.step} pill={pill} banner={banner} />;
  }
  const surface = surfaceOf(route.screen) ?? "live";
  const sidebar = (
    <Sidebar
      mode="main"
      label={t("nav.main")}
      active={surface}
      liveLabel={t("nav.live")}
      configurationLabel={t("nav.configuration")}
      waiting={badge}
      status={pill}
      onNavigate={(to) => {
        navigate(to === "live" ? LIVE : { screen: "flows" });
      }}
    />
  );
  switch (route.screen) {
    case "live":
      return (
        <PageLive sidebar={sidebar} banner={banner}>
          <LiveScreen
            api={api}
            flowId={route.flowId}
            tabId={route.tabId}
            onGoToFlows={() => {
              navigate({ screen: "flows" });
            }}
          />
        </PageLive>
      );
    case "canvas":
      return (
        <PageCanvas sidebar={sidebar} banner={banner}>
          {/* Keyed by the flow: another flow's canvas is a fresh editor frame. */}
          <CanvasScreen key={route.flowId} api={api} flowId={route.flowId} />
        </PageCanvas>
      );
    default:
      return (
        <PageConfiguration
          sidebar={sidebar}
          banner={banner}
          tabs={
            <TabStrip
              label={t("nav.configuration")}
              tabs={[
                { value: "flows", label: t("nav.flows") },
                { value: "general", label: t("nav.general") },
              ]}
              value={route.screen === "general" ? "general" : "flows"}
              onValueChange={(value) => {
                navigate(value === "general" ? { screen: "general" } : { screen: "flows" });
              }}
            />
          }
        >
          {route.screen === "flows" ? <FlowsScreen api={api} navigate={navigate} /> : null}
          {route.screen === "general" ? (
            <GeneralScreen
              api={api}
              onAddFolder={() => {
                navigate({ screen: "flows" });
              }}
            />
          ) : null}
        </PageConfiguration>
      );
  }
}

function SetupScreen({
  step,
  pill,
  banner,
}: {
  readonly step: string;
  readonly pill: ReactNode;
  readonly banner: ReactNode;
}) {
  const setup = useSetup();
  const current = setup.status === "ready" ? setupNavIndex(setup.value.step) : 0;
  return (
    <WindowSetup
      sidebar={
        <Sidebar
          mode="setup"
          label={t("nav.setup")}
          steps={SETUP_NAV.map((entry) => t(SETUP_NAV_LABEL[entry]))}
          current={current}
          status={pill}
        />
      }
    >
      {/* WindowSetup has no banner slot: the banner leads the step's column. */}
      {banner}
      <div data-testid="setup-step" data-step={step} />
    </WindowSetup>
  );
}

// ── the quit question ───────────────────────────────────────────────────────────────────────

/** The quit question while one waits for the person's answer; the listener is registered once. */
function useQuitQuestion(api: AppApi): {
  readonly current: QuitQuestion | null;
  readonly answer: (choice: QuitChoice) => void;
} {
  const [current, setCurrent] = useState<QuitQuestion | null>(null);
  // Answered once: closing the dialog after a button must not answer again as Cancel.
  const waiting = useRef(false);
  useEffect(() => {
    api.onQuitQuestion((question) => {
      waiting.current = true;
      setCurrent(question);
    });
  }, [api]);
  return {
    current,
    answer: (choice) => {
      if (!waiting.current) {
        return;
      }
      waiting.current = false;
      setCurrent(null);
      void api.answerQuit(choice);
    },
  };
}

function QuitDialog({
  question,
  answer,
}: {
  readonly question: QuitQuestion | null;
  readonly answer: (choice: QuitChoice) => void;
}) {
  return (
    <Dialog
      kind="warning"
      open={question !== null}
      title={t("quit.title")}
      body={t("quit.body")}
      onClose={() => {
        answer("cancel");
      }}
      buttons={
        <div data-testid="quit-question" className="flex flex-col gap-4">
          {question?.problem == null ? null : (
            <InlineMessage kind="failed">{question.problem}</InlineMessage>
          )}
          <DialogButtons
            kind="neutral"
            primaryLabel={t("quit.save")}
            secondaryLabel={t("quit.discard")}
            cancelLabel={t("dialog.cancel")}
            onPrimary={() => {
              answer("deploy");
            }}
            onSecondary={() => {
              answer("discard");
            }}
            onCancel={() => {
              answer("cancel");
            }}
          />
        </div>
      }
    />
  );
}
