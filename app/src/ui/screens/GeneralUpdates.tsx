// Configuration › General › Updates (plan 0022 §G; ux-writing "Configuration › General", Updates;
// design-system "Configuration › General section"): InnyTypes' own update. The one-line state
// from ux-writing, a Progress while downloading, Check now (Secondary), Quit and update (Primary,
// when ready), Go back to the previous version (Quiet, confirmed once in a dialog, for seven days
// after an update), the "Check automatically" Switch and a Release notes Link.
//
// The state is the shell's (domain/updates), pushed at every step, so a scheduled check moves the
// line as Check now does. GoBackDialog is also the runtime banner's, after a crash loop.
import { useState } from "react";
import type { Answer } from "../answer";
import type { AppApi } from "../contract";
import type { RollbackOffer, UpdateView } from "../general-contract";
import { Button } from "../components/atoms/Button";
import { Link } from "../components/atoms/Link";
import { Progress } from "../components/atoms/Progress";
import { Switch } from "../components/atoms/Switch";
import { DialogButtons } from "../components/molecules/DialogButtons";
import { InlineMessage } from "../components/molecules/InlineMessage";
import { Dialog } from "../components/organisms/Dialog";
import { GeneralSection } from "../components/organisms/GeneralSection";
import { useUpdateState } from "../store";
import { t } from "../strings";
import { wordRefusal, wordUpdateGoBack, wordUpdateState } from "../words";

/** "Go back to 0.2.1? Your flows and settings are kept." · [Go back] [Cancel]. */
export function GoBackDialog({
  offer,
  open,
  onGoBack,
  onClose,
}: {
  readonly offer: RollbackOffer;
  readonly open: boolean;
  readonly onGoBack: () => void;
  readonly onClose: () => void;
}) {
  return (
    <Dialog
      kind="neutral"
      testId="update-go-back-dialog"
      open={open}
      title={wordUpdateGoBack(offer).confirm}
      body=""
      onClose={onClose}
      buttons={
        <DialogButtons
          kind="neutral"
          testId="update-go-back"
          primaryLabel={t("general.goBack.yes")}
          cancelLabel={t("dialog.cancel")}
          onPrimary={onGoBack}
          onCancel={onClose}
        />
      }
    />
  );
}

export function UpdatesSection({ api }: { readonly api: AppApi }) {
  const loaded = useUpdateState();
  const [failed, setFailed] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // A switch is drawn again after every answer: Ark's own checkbox is put back where it is.
  const [answers, answered] = useState(0);
  const update = loaded.status === "ready" ? loaded.value : null;
  /** One call; a refusal or a failed call is said under the section. */
  const run = (call: () => Promise<Answer<unknown>>) => {
    setFailed(null);
    call().then(
      (answer) => {
        if (!answer.ok) setFailed(wordRefusal(answer.refused));
      },
      () => {
        setFailed(t("refused.failed"));
      },
    );
  };
  return (
    <GeneralSection
      section="updates"
      title={t("general.updates")}
      state={<UpdateLine update={update} />}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          kind="secondary"
          data-testid="general-update-check"
          state={
            update?.state.kind === "checking" || update?.state.kind === "rolling-back"
              ? "disabled"
              : "default"
          }
          onClick={() => {
            run(() => api.checkNow());
          }}
        >
          {t("general.checkNow")}
        </Button>
        {update?.state.kind === "ready" ? (
          <Button
            kind="primary"
            data-testid="general-update-quit"
            onClick={() => {
              run(() => api.quitAndUpdate());
            }}
          >
            {t("general.quitAndUpdate")}
          </Button>
        ) : null}
        {update?.goBack == null ? null : (
          <Button
            kind="quiet"
            data-testid="general-update-go-back"
            state={update.state.kind === "rolling-back" ? "disabled" : "default"}
            onClick={() => {
              setConfirming(true);
            }}
          >
            {wordUpdateGoBack(update.goBack).button}
          </Button>
        )}
      </div>
      {update === null ? null : (
        <span data-testid="general-update-auto" data-on={String(update.autoCheck)}>
          <Switch
            key={answers}
            testId="general-update-auto-switch"
            state={update.autoCheck ? "on" : "off"}
            label={t("general.checkAutomatically")}
            onStateChange={(state) => {
              run(async () => {
                const answer = await api.setUpdateAutoCheck(state === "on");
                answered((n) => n + 1);
                return answer;
              });
            }}
          />
        </span>
      )}
      <div>
        <Link
          href="#"
          onClick={(event) => {
            event.preventDefault();
            run(() => api.openReleaseNotes());
          }}
        >
          {t("general.releaseNotes")}
        </Link>
      </div>
      {failed === null ? null : (
        <div data-testid="general-update-message">
          <InlineMessage kind="failed">{failed}</InlineMessage>
        </div>
      )}
      {update?.goBack == null ? null : (
        <GoBackDialog
          offer={update.goBack}
          open={confirming}
          onClose={() => {
            setConfirming(false);
          }}
          onGoBack={() => {
            setConfirming(false);
            run(() => api.goBack());
          }}
        />
      )}
    </GeneralSection>
  );
}

/** The one-line state, and a Progress under it while downloading. */
function UpdateLine({ update }: { readonly update: UpdateView | null }) {
  if (update === null) {
    return null;
  }
  const state = update.state;
  return (
    <span className="flex flex-col gap-1">
      <span data-testid="general-update-state" data-state={state.kind}>
        {wordUpdateState(state, new Date())}
      </span>
      {state.kind === "downloading" ? (
        <Progress
          mode="determinate"
          value={state.percent}
          label={t("general.updates")}
          testId="general-update-progress"
        />
      ) : null}
    </span>
  );
}
