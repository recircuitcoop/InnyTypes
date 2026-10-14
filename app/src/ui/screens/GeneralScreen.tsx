// Configuration › General (plan 0022 §M, ux-writing "Configuration › General"): settings about no
// single flow, each section with its one-line state. It takes over the old Settings page's
// behaviours through the same AppApi calls: pairing with Anytype, the MCP endpoint and its live
// move, launch at login, the telemetry switch, where secrets are kept and the old installation's
// leftovers; and adds Run history's retention (D8) and the status details (Advanced).
//
// Updates and Packages are their own items (WI-0022-20, WI-0022-19) and join this screen there.
// Every sentence comes from ui/general.ts or strings.ts; elements carry data-testid for the e2e.
import { useCallback, useEffect, useState } from "react";
import type {
  AnytypeStatus,
  AppApi,
  LaunchAtLoginStatus,
  McpEndpointStatus,
  TelemetryReport,
  TelemetryStatus,
} from "../contract";
import type { Answer } from "../answer";
import type { NodeOptions } from "../flow-contract";
import type { Retention } from "../general-contract";
import { Button } from "../components/atoms/Button";
import { Code } from "../components/atoms/Code";
import { NumberField } from "../components/atoms/NumberField";
import { Select } from "../components/atoms/Select";
import { Switch } from "../components/atoms/Switch";
import { TextField } from "../components/atoms/TextField";
import { Field } from "../components/molecules/Field";
import { InlineMessage } from "../components/molecules/InlineMessage";
import { GeneralSection } from "../components/organisms/GeneralSection";
import {
  aiAppsLine,
  anytypeLine,
  clientSetup,
  moveRefusal,
  reportsLine,
  RETENTION_OPTIONS,
  retentionDays,
  retentionLine,
  retentionValue,
  servedPort,
} from "../general";
import { t } from "../strings";
import { wordRefusal } from "../words";
import { AdvancedSection } from "./GeneralAdvanced";

/** How often the open screen asks Anytype's state again: AppApi pushes no Anytype change. */
export const ANYTYPE_POLL_MS = 2_000;

/** A line under a section's controls: what just happened, or why it did not. */
type Said = { readonly kind: "failed" | "done"; readonly text: string } | null;

function Message({ said, testId }: { readonly said: Said; readonly testId: string }) {
  if (said === null) {
    return null;
  }
  return (
    <div data-testid={testId}>
      <InlineMessage kind={said.kind}>{said.text}</InlineMessage>
    </div>
  );
}

/** An old AppApi call's value, read on mount; `set` replaces it with a call's newer answer. */
function useRead<T>(read: () => Promise<T>): {
  readonly value: T | null;
  readonly set: (value: T) => void;
  readonly reload: () => void;
} {
  const [value, set] = useState<T | null>(null);
  const reload = useCallback(() => {
    read().then(set, () => {
      // Unread stays unread: the section shows nothing it does not know.
    });
  }, [read]);
  useEffect(reload, [reload]);
  return { value, set, reload };
}

export function GeneralScreen({
  api,
  onAddFolder,
}: {
  readonly api: AppApi;
  /** "Add a folder…": a watched folder is a flow's source, added in Configuration › Flows. */
  readonly onAddFolder: () => void;
}) {
  const anytype = useAnytype(api);
  const endpoint = useRead(useCallback(() => api.mcpEndpoint(), [api]));
  return (
    <div data-testid="general" className="flex flex-col gap-6">
      <AnytypeSection api={api} status={anytype.status} spaces={anytype.spaces} set={anytype.set} />
      <GeneralSection
        section="recorders"
        title={t("general.recorders")}
        state={<span data-testid="general-recorders-state">{t("general.recorders.none")}</span>}
      >
        <div>
          <Button kind="secondary" onClick={onAddFolder} data-testid="general-add-folder">
            {t("general.addFolder")}
          </Button>
        </div>
      </GeneralSection>
      <AiAppsSection api={api} status={endpoint.value} set={endpoint.set} />
      <StartAtLoginSection api={api} />
      <ReportsSection api={api} />
      <RunsSection api={api} />
      <AdvancedSection api={api} anytype={anytype.status} endpoint={endpoint.value} />
    </div>
  );
}

// ── Anytype ──────────────────────────────────────────────────────────────────────────────────

/** Anytype's state, asked every ANYTYPE_POLL_MS, and its spaces once it is ready. */
function useAnytype(api: AppApi) {
  const [status, set] = useState<AnytypeStatus | null>(null);
  const [spaces, setSpaces] = useState<Answer<NodeOptions> | null>(null);
  useEffect(() => {
    let live = true;
    const ask = () => {
      api.anytypeStatus().then(
        (next) => {
          if (live) set(next);
        },
        () => undefined,
      );
    };
    ask();
    const timer = setInterval(ask, ANYTYPE_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api]);
  const ready = status?.state === "ready";
  useEffect(() => {
    if (!ready) {
      setSpaces(null);
      return;
    }
    let live = true;
    void api.anytypeSpaces().then((answer) => {
      if (live) setSpaces(answer);
    });
    return () => {
      live = false;
    };
  }, [api, ready]);
  return { status, spaces, set };
}

function AnytypeSection({
  api,
  status,
  spaces,
  set,
}: {
  readonly api: AppApi;
  readonly status: AnytypeStatus | null;
  readonly spaces: Answer<NodeOptions> | null;
  readonly set: (status: AnytypeStatus) => void;
}) {
  const [code, setCode] = useState("");
  const [said, say] = useState<Said>(null);
  const line = status === null ? null : anytypeLine(status, spaces);
  const pair = () => {
    say(null);
    api.startAnytypePairing().then(set, () => {
      say({ kind: "failed", text: t("error.anytypeUnreachable") });
    });
  };
  const connect = () => {
    say(null);
    api.completeAnytypePairing(code).then(
      (next) => {
        setCode("");
        set(next);
      },
      () => {
        say({ kind: "failed", text: t("general.anytype.codeRefused") });
      },
    );
  };
  return (
    <GeneralSection
      section="anytype"
      title={t("general.anytype")}
      state={<span data-testid="general-anytype-state">{line?.line}</span>}
    >
      {status?.pairing === true ? (
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            connect();
          }}
        >
          <Field label={t("general.anytype.code")}>
            {(control) => (
              <span data-testid="general-anytype-code">
                <TextField id={control.id} value={code} onValueChange={setCode} />
              </span>
            )}
          </Field>
          <Button kind="primary" type="submit" data-testid="general-anytype-connect">
            {t("general.pair")}
          </Button>
        </form>
      ) : null}
      <div>
        <Button kind="secondary" onClick={pair} data-testid="general-anytype-pair">
          {line?.paired === false ? t("general.pair") : t("general.pairAgain")}
        </Button>
      </div>
      <Message said={said} testId="general-anytype-message" />
    </GeneralSection>
  );
}

// ── AI apps (the MCP endpoint) ───────────────────────────────────────────────────────────────

function AiAppsSection({
  api,
  status,
  set,
}: {
  readonly api: AppApi;
  readonly status: McpEndpointStatus | null;
  readonly set: (status: McpEndpointStatus) => void;
}) {
  // Pre-filled with the port served; kept as typed once the person types.
  const [typed, setTyped] = useState<string | null>(null);
  const [said, say] = useState<Said>(null);
  const current = status === null ? null : servedPort(status);
  const port = typed ?? (current === null ? "" : String(current));
  const move = () => {
    const chosen = Number(port);
    say(null);
    api.moveMcpEndpoint("127.0.0.1", chosen).then(
      (next) => {
        const moved = next.served !== status?.served;
        set(next);
        setTyped(null);
        say(moved ? { kind: "done", text: t("general.aiApps.moved") } : null);
      },
      (error: unknown) => {
        say({ kind: "failed", text: moveRefusal(String(error), chosen) });
      },
    );
  };
  const copy = () => {
    if (status?.served == null) {
      return;
    }
    navigator.clipboard.writeText(clientSetup(status.served)).then(
      () => {
        say({ kind: "done", text: t("general.aiApps.copied") });
      },
      () => {
        say({ kind: "failed", text: t("refused.failed") });
      },
    );
  };
  return (
    <GeneralSection
      section="ai-apps"
      title={t("general.aiApps")}
      state={
        <span data-testid="general-ai-apps-state">
          {status === null ? null : aiAppsLine(status)}
        </span>
      }
    >
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          move();
        }}
      >
        <Field label={t("general.changePort")}>
          {(control) => (
            <span data-testid="general-port">
              <NumberField
                id={control.id}
                value={port}
                min={1}
                max={65535}
                onValueChange={setTyped}
                incrementLabel={t("general.port.more")}
                decrementLabel={t("general.port.less")}
              />
            </span>
          )}
        </Field>
        <Button kind="secondary" type="submit" data-testid="general-change-port">
          {t("general.changePort")}
        </Button>
      </form>
      <div>
        <Button kind="secondary" onClick={copy} data-testid="general-copy-setup">
          {t("general.copySetup", { app: t("general.aiApps.app") })}
        </Button>
      </div>
      <Message said={said} testId="general-ai-apps-message" />
    </GeneralSection>
  );
}

// ── Start at login ───────────────────────────────────────────────────────────────────────────
//
// A switch is drawn again (a new key) after every answer: a refused move leaves the state where
// it was, and Ark's own checkbox, which the press already flipped, must be put back to it.

function StartAtLoginSection({ api }: { readonly api: AppApi }) {
  const login = useRead(useCallback(() => api.launchAtLogin(), [api]));
  const [said, say] = useState<Said>(null);
  const [answers, answered] = useState(0);
  const turn = (on: boolean) => {
    say(null);
    api.setLaunchAtLogin(on).then(
      (next: LaunchAtLoginStatus) => {
        login.set(next);
        answered((n) => n + 1);
        // The OS said no: the switch stays where it was, and the person is told.
        if (next.problem !== null) {
          say({ kind: "failed", text: t("general.startAtLogin.refused") });
        }
      },
      () => {
        answered((n) => n + 1);
        say({ kind: "failed", text: t("general.startAtLogin.refused") });
      },
    );
  };
  return (
    <GeneralSection
      section="start-at-login"
      title={t("general.startAtLogin")}
      state={t("general.startAtLogin.line")}
    >
      {login.value === null ? null : (
        <span data-testid="general-login" data-on={String(login.value.on)}>
          <Switch
            key={answers}
            state={login.value.on ? "on" : "off"}
            label={t("general.startAtLogin")}
            onStateChange={(state) => {
              turn(state === "on");
            }}
          />
        </span>
      )}
      <Message said={said} testId="general-login-message" />
    </GeneralSection>
  );
}

// ── Reports (telemetry) ──────────────────────────────────────────────────────────────────────

function ReportsSection({ api }: { readonly api: AppApi }) {
  const telemetry = useRead(useCallback(() => api.telemetry(), [api]));
  const [reports, setReports] = useState<readonly TelemetryReport[] | null>(null);
  const [said, say] = useState<Said>(null);
  const [answers, answered] = useState(0);
  const show = () => {
    api.telemetryReports().then(setReports, () => {
      say({ kind: "failed", text: t("refused.failed") });
    });
  };
  const turn = (on: boolean) => {
    say(null);
    api.setTelemetry(on).then(
      (next: TelemetryStatus) => {
        telemetry.set(next);
        answered((n) => n + 1);
        // What is shown is what waits now: off deletes it.
        if (reports !== null) show();
      },
      () => {
        answered((n) => n + 1);
        say({ kind: "failed", text: t("refused.failed") });
      },
    );
  };
  const answer = telemetry.value?.answer;
  return (
    <GeneralSection
      section="reports"
      title={t("general.reports")}
      state={
        <span className="flex flex-col gap-1">
          <span data-testid="general-reports-state">
            {answer === undefined ? null : reportsLine(answer)}
          </span>
          <span data-testid="general-reports-crash" className="text-caption">
            {t("general.reports.crashNotYet")}
          </span>
        </span>
      }
    >
      {answer === undefined ? null : (
        <span data-testid="general-reports" data-on={String(answer === "on")}>
          <Switch
            key={answers}
            state={answer === "on" ? "on" : "off"}
            label={t("general.reports.switch")}
            onStateChange={(state) => {
              turn(state === "on");
            }}
          />
        </span>
      )}
      <div>
        <Button
          kind="quiet"
          aria-expanded={reports !== null}
          data-testid="general-reports-see"
          onClick={() => {
            if (reports === null) show();
            else setReports(null);
          }}
        >
          {reports === null ? t("general.reports.see") : t("general.reports.hide")}
        </Button>
      </div>
      {reports === null ? null : <ReportList reports={reports} />}
      <Message said={said} testId="general-reports-message" />
    </GeneralSection>
  );
}

/** The queued reports in full, exactly as each would leave. */
function ReportList({ reports }: { readonly reports: readonly TelemetryReport[] }) {
  if (reports.length === 0) {
    return (
      <p data-testid="general-reports-sent" className="text-body text-secondary">
        {t("general.reports.nothing")}
      </p>
    );
  }
  return (
    <ol data-testid="general-reports-sent" className="flex flex-col gap-2">
      {reports.map((report, index) => (
        <li key={index} data-kind={report.kind}>
          <Code kind="block">{JSON.stringify(report.payload, null, 2)}</Code>
        </li>
      ))}
    </ol>
  );
}

// ── Run history's retention (D8) ─────────────────────────────────────────────────────────────

function RunsSection({ api }: { readonly api: AppApi }) {
  const [retention, setRetention] = useState<Retention | null>(null);
  const [said, say] = useState<Said>(null);
  useEffect(() => {
    void api.retention().then((answer) => {
      if (answer.ok) setRetention(answer.value);
      else say({ kind: "failed", text: wordRefusal(answer.refused) });
    });
  }, [api]);
  const choose = (value: string | null) => {
    const days = value === null ? undefined : retentionDays(value);
    if (days === undefined) {
      return;
    }
    say(null);
    void api.setRetention(days).then((answer) => {
      if (answer.ok) setRetention(answer.value);
      else say({ kind: "failed", text: wordRefusal(answer.refused) });
    });
  };
  return (
    <GeneralSection
      section="runs"
      title={t("general.runs")}
      state={
        <span data-testid="general-runs-state">
          {retention === null ? null : retentionLine(retention.days)}
        </span>
      }
    >
      {retention === null ? null : (
        <span data-testid="general-retention" data-value={retentionValue(retention.days)}>
          <Select
            label={t("general.retention")}
            hideLabel={false}
            options={RETENTION_OPTIONS}
            value={retentionValue(retention.days)}
            onValueChange={choose}
          />
        </span>
      )}
      <Message said={said} testId="general-runs-message" />
    </GeneralSection>
  );
}
