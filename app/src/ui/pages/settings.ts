// The Settings page: where the application keeps its secrets (WI-0018-06), the loopback MCP
// endpoint and its live move (WI-0018-19), pairing with Anytype (WI-0018-18), and the
// launch-at-login switch (WI-0018-21). All of it is answered by the shell and the services
// process, so it works while the runtime is down.

import type {
  AnytypeStatus,
  AppApi,
  LaunchAtLoginStatus,
  McpEndpointStatus,
  SecretStorageStatus,
} from "../contract";
import { attributeOf, escape, formValues } from "../view/render";
import type { Region, Section } from "./page";

export function secretStorageHtml(status: SecretStorageStatus): string {
  const where =
    status.backend === "keychain" ? "the system keychain" : "files only this account can read";
  const why = status.reason === null ? "" : ` (${escape(status.reason)})`;
  return `<p data-testid="settings-secret-storage" data-backend="${status.backend}">Secrets are kept in ${where}${why}.</p>`;
}

/**
 * The endpoint: the URL served, the saved one only when it differs, the variables a stored
 * value is beating (only when there are any), why nothing is served, and the edit. The warning
 * that clients must be updated is said only after a move that changed the URL.
 */
export function endpointHtml(status: McpEndpointStatus, moved = false): string {
  const saved =
    status.saved === status.served
      ? ""
      : `<p>Saved: <code data-testid="settings-mcp-saved">${escape(status.saved ?? "nothing")}</code></p>`;
  const ignored =
    status.ignoredVariables.length === 0
      ? ""
      : `<p data-testid="settings-mcp-ignored">The stored address is used; ` +
        `${escape(status.ignoredVariables.join(" and "))} ${status.ignoredVariables.length === 1 ? "is" : "are"} set and ignored.</p>`;
  const problem =
    status.problem === null
      ? ""
      : `<p role="alert" data-testid="settings-mcp-problem">${escape(status.problem)}</p>`;
  const warning = moved
    ? `<p role="status" data-testid="settings-mcp-warning">${escape(status.warning)}</p>`
    : "";
  return (
    `<p>Served now: <code data-testid="settings-mcp-served">${escape(status.served ?? "nothing")}</code></p>` +
    saved +
    ignored +
    problem +
    `<form data-form="endpoint" data-testid="settings-mcp-form">` +
    '<label>Host <input type="text" name="host" value="127.0.0.1" data-testid="settings-mcp-host"></label> ' +
    '<label>Port <input type="number" name="port" min="1" max="65535" step="1" data-kind="number" data-testid="settings-mcp-port"></label> ' +
    '<button type="submit" data-testid="settings-mcp-move">Move</button></form>' +
    warning
  );
}

export function anytypeHtml(status: AnytypeStatus): string {
  const detail = status.detail === null ? "" : `: ${escape(status.detail)}`;
  const code = status.pairing
    ? '<form data-form="pair-code" data-testid="settings-anytype-code-form">' +
      '<label>The code Anytype shows <input type="text" name="code" data-testid="settings-anytype-code"></label> ' +
      '<button type="submit" data-testid="settings-anytype-complete">Pair</button></form>'
    : "";
  return (
    `<p>Anytype: <span data-testid="settings-anytype-state">${escape(status.state)}</span>${detail}</p>` +
    '<button type="button" data-pair="1" data-testid="settings-anytype-pair">Pair with Anytype</button>' +
    code
  );
}

/** The switch: where it stands, the button that moves it, and why it did not move. */
export function launchAtLoginHtml(status: LaunchAtLoginStatus): string {
  const problem =
    status.problem === null
      ? ""
      : `<p role="alert" data-testid="settings-login-problem">${escape(status.problem)}</p>`;
  return (
    `<p>Start InnyTypes when I log in: <span data-testid="settings-login-state">${status.on ? "on" : "off"}</span> ` +
    `<button type="button" data-login="${status.on ? "off" : "on"}" data-testid="settings-login-toggle">` +
    `Turn ${status.on ? "off" : "on"}</button></p>` +
    problem
  );
}

/** The old installation's plugin environments (WI-0018-25): a list and a Delete button, or
 * nothing when there is none to show. */
export function legacyPackagesHtml(ids: readonly string[]): string {
  if (ids.length === 0) {
    return "";
  }
  const items = ids.map((id) => `<li>${escape(id)}</li>`).join("");
  return (
    `<div data-testid="settings-legacy-packages">` +
    `<p>Plugin environments from the old installation: <ul>${items}</ul></p>` +
    '<button type="button" data-legacy-delete="1" data-testid="settings-legacy-delete">' +
    "Delete them</button></div>"
  );
}

export interface SettingsPage {
  readonly section: Section;
  readonly secrets: Region;
  readonly endpoint: Region;
  readonly anytype: Region;
  readonly login: Region;
  readonly legacy: Region;
  readonly message: Region;
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Mount the page; the returned function draws it again (when the page is shown). */
export function mountSettings(page: SettingsPage, api: AppApi): () => Promise<void> {
  const say = (text: string): void => {
    page.message.innerHTML = escape(text);
  };
  /** Run a call whose failure is a sentence for the person (the calls reject with one). */
  const attempt = async <T>(call: () => Promise<T>, draw: (value: T) => void): Promise<void> => {
    try {
      draw(await call());
    } catch (error) {
      say(reasonOf(error));
    }
  };
  /** The URL served when the page last drew it: a move that changes it says so. */
  let served: string | null = null;
  const drawEndpoint = (status: McpEndpointStatus, moved = false): void => {
    served = status.served;
    page.endpoint.innerHTML = endpointHtml(status, moved);
  };
  const drawAnytype = (status: AnytypeStatus): void => {
    page.anytype.innerHTML = anytypeHtml(status);
  };
  const drawLogin = (status: LaunchAtLoginStatus): void => {
    page.login.innerHTML = launchAtLoginHtml(status);
  };
  const drawLegacy = (ids: readonly string[]): void => {
    page.legacy.innerHTML = legacyPackagesHtml(ids);
  };
  const refresh = async (): Promise<void> => {
    await attempt(
      () => api.secretStorage(),
      (status) => {
        page.secrets.innerHTML = secretStorageHtml(status);
      },
    );
    await attempt(
      () => api.mcpEndpoint(),
      (status) => {
        drawEndpoint(status);
      },
    );
    await attempt(() => api.anytypeStatus(), drawAnytype);
    await attempt(() => api.launchAtLogin(), drawLogin);
    await attempt(() => api.legacyPackages(), drawLegacy);
  };

  page.section.on("click", (event) => {
    if (attributeOf(event.target, "data-pair") !== null) {
      say("");
      void attempt(() => api.startAnytypePairing(), drawAnytype);
    }
    const login = attributeOf(event.target, "data-login");
    if (login !== null) {
      say("");
      void attempt(() => api.setLaunchAtLogin(login === "on"), drawLogin);
    }
    if (attributeOf(event.target, "data-legacy-delete") !== null) {
      say("");
      void attempt(
        () => api.deleteLegacyPackages(),
        () => {
          drawLegacy([]);
        },
      );
    }
  });
  page.section.on("submit", (event) => {
    event.preventDefault();
    const form = attributeOf(event.target, "data-form");
    const values = formValues(event.target);
    say("");
    if (form === "endpoint") {
      const host = typeof values["host"] === "string" ? values["host"] : "";
      const port = typeof values["port"] === "number" ? values["port"] : Number.NaN;
      const before = served;
      void attempt(
        () => api.moveMcpEndpoint(host, port),
        (status) => {
          drawEndpoint(status, status.served !== before);
        },
      );
    } else if (form === "pair-code") {
      const code = typeof values["code"] === "string" ? values["code"] : "";
      void attempt(() => api.completeAnytypePairing(code), drawAnytype);
    }
  });
  return refresh;
}
