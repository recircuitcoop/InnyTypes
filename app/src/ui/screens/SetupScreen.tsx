// Setup, the first-run walkthrough (plan 0022 §H, ux-writing "The first run (Setup)"): Welcome,
// Reports, Connect Anytype, Source folder, the starter flow's node forms, Ready, one screen at a
// time beside the Setup sidebar. There is no package step and no starter choice: the shipped
// packages are there on their own, and the shell installs the starter flow once Setup reaches
// Source folder (shell/setup-starter.ts). Every move goes through setSetupStep, so a quit
// resumes where it was.
//
// Ready's choices: Try with a sample (the bundled sample copied into the chosen folder; Setup
// stays on Ready so the person can then open Live), Open Live (completes Setup and opens the
// starter's board) and I'll build my own, secondary (completes Setup and opens Flows, the starter
// kept).
import { useEffect, useState, type ReactNode } from "react";
import type { AppApi } from "../contract";
import type { Refusal } from "../answer";
import type { FlowSummary } from "../flow-contract";
import type { SetupMove, SetupState } from "../general-contract";
import { Button } from "../components/atoms/Button";
import { TextField } from "../components/atoms/TextField";
import { Field } from "../components/molecules/Field";
import { InlineMessage } from "../components/molecules/InlineMessage";
import { SetupStep } from "../components/organisms/SetupStep";
import { Sidebar } from "../components/organisms/Sidebar";
import { WindowSetup } from "../components/templates/WindowSetup";
import { folderName } from "../general";
import { routeHash, SETUP_NAV, setupNavIndex, type Route, type SetupNavEntry } from "../routes";
import { anytypeStep, markedParts } from "../setup-form";
import { useFlows, useSetup, useStores } from "../store";
import { t, type PlainKey } from "../strings";
import { wordRefusal } from "../words";
import { useAnytype } from "./GeneralScreen";
import { Marked, SetupForm } from "./SetupForm";

/** The Setup sidebar's labels (ux-writing, the Setup sidebar). */
const SETUP_NAV_LABEL: Readonly<Record<SetupNavEntry, PlainKey>> = {
  welcome: "setup.nav.welcome",
  reports: "setup.nav.reports",
  anytype: "setup.nav.anytype",
  folder: "setup.nav.folder",
  steps: "setup.nav.steps",
  ready: "setup.nav.ready",
};

/** How often Source folder asks again while the shell is still installing the starter flow. */
export const STARTER_POLL_MS = 1_000;

/** What every step is handed: the state, a move, and the line saying why a call was refused. */
interface StepProps {
  readonly api: AppApi;
  readonly state: SetupState;
  readonly move: (move: SetupMove) => Promise<boolean>;
  readonly say: (refusal: Refusal | null) => void;
}

export function SetupScreen({
  api,
  pill,
  banner,
}: {
  readonly api: AppApi;
  readonly pill: ReactNode;
  readonly banner: ReactNode;
}) {
  const setup = useSetup();
  const stores = useStores();
  const [refusal, say] = useState<Refusal | null>(null);
  const state = setup.status === "ready" ? setup.value : null;
  /** A move through Setup: stored by the shell, and shown at once. */
  const move = async (given: SetupMove): Promise<boolean> => {
    say(null);
    const answer = await api.setSetupStep(given);
    if (!answer.ok) {
      say(answer.refused);
      return false;
    }
    stores.setup.set(answer.value);
    return true;
  };
  return (
    <WindowSetup
      sidebar={
        <Sidebar
          mode="setup"
          label={t("nav.setup")}
          steps={SETUP_NAV.map((entry) => t(SETUP_NAV_LABEL[entry]))}
          current={state === null ? 0 : setupNavIndex(state.step)}
          status={pill}
        />
      }
    >
      {/* WindowSetup has no banner slot: the banner leads the step's column. */}
      {banner}
      {state === null ? null : (
        <div data-testid="setup-step" data-step={state.step} className="flex flex-col gap-4">
          <Step api={api} state={state} move={move} say={say} />
          {refusal === null ? null : (
            <div data-testid="setup-message">
              <InlineMessage kind="failed">{wordRefusal(refusal)}</InlineMessage>
            </div>
          )}
        </div>
      )}
    </WindowSetup>
  );
}

function Step(props: StepProps) {
  const { state, move } = props;
  switch (state.step) {
    case "welcome":
      return (
        <SetupStep
          title={t("setup.welcome.title")}
          body={t("setup.welcome.body")}
          continueLabel={t("setup.welcome.start")}
          onContinue={() => void move({ kind: "next" })}
        />
      );
    case "reports":
      return <ReportsStep {...props} />;
    case "connect-anytype":
      return <AnytypeStep {...props} />;
    case "source-folder":
      return <FolderStep {...props} />;
    case "node-forms":
      return <FormsStep {...props} />;
    case "ready":
      return <ReadyStep {...props} />;
  }
}

function ReportsStep({ api, move, say }: StepProps) {
  /** The answer, then on: the switch in Configuration › General says the same. */
  const answer = (on: boolean) => {
    api.setTelemetry(on).then(
      () => void move({ kind: "next" }),
      () => {
        say({ reason: "failed", sentence: "refused.failed" });
      },
    );
  };
  return (
    <SetupStep
      title={t("setup.reports.title")}
      body={t("setup.reports.body")}
      actions={
        <>
          <Button kind="quiet" onClick={() => void move({ kind: "back" })}>
            {t("setup.back")}
          </Button>
          <Button
            kind="secondary"
            onClick={() => {
              answer(false);
            }}
          >
            {t("setup.reports.dontSend")}
          </Button>
          <Button
            kind="primary"
            onClick={() => {
              answer(true);
            }}
          >
            {t("setup.reports.send")}
          </Button>
        </>
      }
    />
  );
}

/** Connect Anytype: pairing as General pairs (startAnytypePairing, completeAnytypePairing). */
function AnytypeStep({ api, move }: StepProps) {
  const anytype = useAnytype(api);
  const [code, setCode] = useState("");
  const [pairingFailed, setPairingFailed] = useState(false);
  const [codeRefused, setCodeRefused] = useState(false);
  const shown = anytypeStep(anytype.status, anytype.spaces, pairingFailed);
  const noKey = anytype.status?.state === "no-key" && !anytype.status.pairing;
  // Not paired yet: Anytype is asked for a code as the step opens, and again while it does not
  // answer (InnyTypes notices once it is open).
  useEffect(() => {
    if (!noKey) {
      return;
    }
    let live = true;
    api.startAnytypePairing().then(
      (next) => {
        if (!live) return;
        setPairingFailed(false);
        anytype.set(next);
      },
      () => {
        if (live) setPairingFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [api, noKey, anytype.status]);
  const connect = () => {
    if (shown.kind !== "code") {
      api.startAnytypePairing().then(anytype.set, () => {
        setPairingFailed(true);
      });
      return;
    }
    setCodeRefused(false);
    api.completeAnytypePairing(code).then(
      (next) => {
        setCode("");
        anytype.set(next);
      },
      () => {
        setCodeRefused(true);
      },
    );
  };
  const back = (
    <Button kind="quiet" onClick={() => void move({ kind: "back" })}>
      {t("setup.back")}
    </Button>
  );
  return (
    <SetupStep
      title={t("setup.anytype.title")}
      {...(shown.line === null
        ? {}
        : { body: <span data-testid="setup-anytype">{shown.line}</span> })}
      actions={
        shown.kind === "connected" ? (
          <>
            {back}
            <Button kind="primary" onClick={() => void move({ kind: "next" })}>
              {t("setup.continue")}
            </Button>
          </>
        ) : (
          <>
            {back}
            <Button kind="secondary" onClick={() => void move({ kind: "next" })}>
              {t("setup.anytype.skip")}
            </Button>
            <Button kind="primary" onClick={connect}>
              {t("setup.anytype.connect")}
            </Button>
          </>
        )
      }
    >
      {shown.kind === "code" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            connect();
          }}
        >
          <Field
            label={t("general.anytype.code")}
            state={codeRefused ? "error" : "default"}
            {...(codeRefused ? { error: t("general.anytype.codeRefused") } : {})}
          >
            {(control) => (
              <span data-testid="setup-anytype-code">
                <TextField
                  id={control.id}
                  state={codeRefused ? "error" : "default"}
                  value={code}
                  onValueChange={setCode}
                />
              </span>
            )}
          </Field>
        </form>
      ) : undefined}
    </SetupStep>
  );
}

/** The installed starter flow's row; null while the shell is installing it. */
function useStarter(state: SetupState): FlowSummary | null {
  const flows = useFlows();
  const stores = useStores();
  const waiting = state.starterFlowId === null;
  // Asked again until the shell has installed it (its read starts the install when needed).
  useEffect(() => {
    if (!waiting) {
      return;
    }
    const timer = setInterval(() => {
      void stores.setup.refresh();
    }, STARTER_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [waiting, stores]);
  const found =
    flows.status === "ready" ? flows.value.find((flow) => flow.id === state.starterFlowId) : null;
  // A starter just installed may not be in the list read before it: read the list again.
  useEffect(() => {
    if (!waiting && found === undefined) {
      void stores.flows.refresh();
    }
  }, [waiting, found, stores]);
  return found ?? null;
}

/** The folder the starter's source watches, read from its form; "" when none is chosen. */
function useStarterFolder(api: AppApi, starter: FlowSummary | null): [string, () => void] {
  const [folder, setFolder] = useState("");
  const [asked, ask] = useState(0);
  const source = starter?.sources[0];
  useEffect(() => {
    if (starter === null || source === undefined) {
      return;
    }
    let live = true;
    void api.nodeForm(starter.id, source.id).then((form) => {
      const chosen = form.ok ? form.value.values["folder"] : undefined;
      if (live) setFolder(typeof chosen === "string" ? chosen : "");
    });
    return () => {
      live = false;
    };
  }, [api, starter, source, asked]);
  return [
    folder,
    () => {
      ask((n) => n + 1);
    },
  ];
}

function FolderStep({ api, state, move, say }: StepProps) {
  const starter = useStarter(state);
  const [folder, readAgain] = useStarterFolder(api, starter);
  const choose = () => {
    say(null);
    void api.chooseSetupFolder().then((chosen) => {
      if (!chosen.ok) {
        say(chosen.refused);
      } else if (chosen.value.folder !== null) {
        readAgain();
      }
    });
  };
  return (
    <SetupStep
      title={t("setup.folder.title")}
      body={t("setup.folder.body")}
      backLabel={t("setup.back")}
      continueLabel={t("setup.continue")}
      continueDisabled={starter === null || folder === ""}
      onBack={() => void move({ kind: "back" })}
      onContinue={() => void move({ kind: "next" })}
    >
      <div className="flex flex-col items-start gap-2">
        <Button
          kind="secondary"
          state={starter === null ? "loading" : "default"}
          onClick={choose}
          data-testid="setup-choose-folder"
        >
          {t("setup.folder.choose")}
        </Button>
        {folder === "" ? null : (
          <p data-testid="setup-folder" className="text-body text-primary">
            {folderName(folder)}
          </p>
        )}
      </div>
    </SetupStep>
  );
}

function FormsStep({ api, state, move }: StepProps) {
  const starter = useStarter(state);
  const step = starter?.steps[state.formIndex];
  if (starter === null || step === undefined || state.starterFlowId === null) {
    return null;
  }
  return (
    // Keyed by the step: the next form starts from its own values.
    <SetupForm
      key={step.id}
      api={api}
      flowId={state.starterFlowId}
      step={step}
      index={state.formIndex}
      count={state.formCount}
      onBack={() => void move({ kind: "back" })}
      onSaved={() => void move({ kind: "next" })}
    />
  );
}

function ReadyStep({ api, state, move, say }: StepProps) {
  const starter = useStarter(state);
  const [folder] = useStarterFolder(api, starter);
  const [trying, setTrying] = useState(false);
  const body = markedParts("setup.ready.body", { folder: folderName(folder) });
  /** Ready's closing choice: Setup completed, then the screen it opens. */
  const close = (to: Route) => {
    void move({ kind: "finish" }).then((moved) => {
      // The address first: the frame, seeing Setup completed, keeps an address it can show.
      if (moved) window.location.hash = routeHash(to);
    });
  };
  const trySample = () => {
    say(null);
    setTrying(true);
    void api.trySample().then((tried) => {
      setTrying(false);
      if (!tried.ok) say(tried.refused);
    });
  };
  const live: Route = { screen: "live", flowId: state.starterFlowId, tabId: null };
  return (
    <SetupStep
      title={t("setup.ready.title")}
      body={<Marked parts={body} />}
      actions={
        <>
          <Button
            kind="secondary"
            onClick={() => {
              close({ screen: "flows" });
            }}
          >
            {t("setup.ready.own")}
          </Button>
          <Button
            kind="secondary"
            onClick={() => {
              close(live);
            }}
          >
            {t("setup.ready.openLive")}
          </Button>
          <Button kind="primary" state={trying ? "loading" : "default"} onClick={trySample}>
            {t("setup.ready.sample")}
          </Button>
        </>
      }
    />
  );
}
