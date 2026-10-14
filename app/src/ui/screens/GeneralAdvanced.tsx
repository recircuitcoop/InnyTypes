// Configuration › General › Advanced (ux-writing: "the status details (runtime, services, ports)
// live here, for support"). What the old status and Settings pages showed for support: each
// supervised child's state with its process, port and generation, Anytype's state and its
// bridge's process, the MCP endpoint served against saved, where secrets are kept, and the old
// installation's leftovers with their Delete button. These are the only internals General shows,
// as values beside a label, never inside a sentence.
import { useCallback, useEffect, useState } from "react";
import type {
  AnytypeStatus,
  AppApi,
  ChildState,
  ChildStatus,
  McpEndpointStatus,
  SecretStorageStatus,
} from "../contract";
import { Button } from "../components/atoms/Button";
import { StatusPill, type StatusPillState } from "../components/atoms/StatusPill";
import { KeyValue } from "../components/molecules/KeyValue";
import { GeneralSection } from "../components/organisms/GeneralSection";
import { useChildren } from "../store";
import { t, type PlainKey } from "../strings";

/** A child's state as the status pill words it: running, restarting, or stopped. */
const CHILD_WORD: Readonly<Record<ChildState, readonly [StatusPillState, PlainKey]>> = {
  starting: ["waiting", "status.restarting"],
  running: ["running", "status.running"],
  "restarting-planned": ["waiting", "status.restarting"],
  restarting: ["waiting", "status.restarting"],
  recovering: ["waiting", "status.restarting"],
  down: ["waiting", "status.restarting"],
  "down-for-good": ["failed", "status.stopped"],
  stopped: ["failed", "status.stopped"],
};

const CHILD_LABEL: Readonly<Record<ChildStatus["child"], PlainKey>> = {
  runtime: "general.advanced.runtime",
  services: "general.advanced.services",
};

/** "4242 · 31011 · 3": the process, the port and the generation, blank where there is none. */
const processLine = (status: ChildStatus) =>
  [status.pid ?? "–", status.port ?? "–", status.generation].map(String).join(" · ");

function ChildRows({ status }: { readonly status: ChildStatus }) {
  const [look, word] = CHILD_WORD[status.state];
  return (
    <div data-testid={`general-child-${status.child}`} data-state={status.state}>
      <KeyValue
        kind="pill"
        label={t(CHILD_LABEL[status.child])}
        value={<StatusPill state={look}>{t(word)}</StatusPill>}
      />
      <KeyValue
        kind="mono"
        label={t("general.advanced.process")}
        value={
          <span data-testid={`general-child-${status.child}-process`}>{processLine(status)}</span>
        }
      />
    </div>
  );
}

export function AdvancedSection({
  api,
  anytype,
  endpoint,
}: {
  readonly api: AppApi;
  readonly anytype: AnytypeStatus | null;
  readonly endpoint: McpEndpointStatus | null;
}) {
  const children = useChildren();
  const [secrets, setSecrets] = useState<SecretStorageStatus | null>(null);
  const [legacy, setLegacy] = useState<readonly string[]>([]);
  useEffect(() => {
    api.secretStorage().then(setSecrets, () => undefined);
    api.legacyPackages().then(setLegacy, () => undefined);
  }, [api]);
  const deleteLegacy = useCallback(() => {
    api.deleteLegacyPackages().then(
      () => {
        setLegacy([]);
      },
      () => undefined,
    );
  }, [api]);
  const statuses =
    children.status === "ready"
      ? [...children.value].sort((a, b) => a.child.localeCompare(b.child))
      : [];
  return (
    <GeneralSection
      section="advanced"
      title={t("general.advanced")}
      state={t("general.advanced.line")}
    >
      <div data-testid="general-advanced" className="flex flex-col">
        {statuses.map((status) => (
          <ChildRows key={status.child} status={status} />
        ))}
        {anytype === null ? null : (
          <div data-testid="general-advanced-anytype" data-state={anytype.state}>
            <KeyValue
              kind="mono"
              label={t("general.advanced.anytype")}
              value={
                anytype.detail === null ? anytype.state : `${anytype.state} · ${anytype.detail}`
              }
            />
            <KeyValue
              kind="mono"
              label={t("general.advanced.anytypeProcess")}
              value={`${anytype.childPid === null ? "–" : String(anytype.childPid)} · ${String(anytype.beats)}`}
            />
          </div>
        )}
        {endpoint === null ? null : <EndpointRows status={endpoint} />}
        {secrets === null ? null : (
          <KeyValue
            kind="text"
            label={t("general.advanced.secrets")}
            value={
              <span data-testid="general-advanced-secrets" data-backend={secrets.backend}>
                {t(
                  secrets.backend === "keychain"
                    ? "general.advanced.secrets.keychain"
                    : "general.advanced.secrets.file",
                )}
                {secrets.reason === null ? null : ` (${secrets.reason})`}
              </span>
            }
          />
        )}
        {legacy.length === 0 ? null : (
          <div data-testid="general-advanced-legacy" className="flex flex-col gap-2">
            <KeyValue kind="mono" label={t("general.advanced.legacy")} value={legacy.join(", ")} />
            <div>
              <Button kind="secondary" onClick={deleteLegacy}>
                {t("general.advanced.legacy.delete")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </GeneralSection>
  );
}

/** The endpoint served, the saved one when it differs, the variables it beats, and the problem. */
function EndpointRows({ status }: { readonly status: McpEndpointStatus }) {
  return (
    <div data-testid="general-advanced-endpoint">
      <KeyValue kind="mono" label={t("general.advanced.endpoint")} value={status.served ?? "–"} />
      {status.saved === status.served ? null : (
        <KeyValue kind="mono" label={t("general.advanced.saved")} value={status.saved ?? "–"} />
      )}
      {status.ignoredVariables.length === 0 ? null : (
        <KeyValue
          kind="mono"
          label={t("general.advanced.ignored")}
          value={status.ignoredVariables.join(", ")}
        />
      )}
      {status.problem === null ? null : (
        <KeyValue kind="text" label={t("general.advanced.endpoint")} value={status.problem} />
      )}
    </div>
  );
}
