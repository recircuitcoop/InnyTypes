// A minimal page: each supervised child's state, and an error with a Restart button when the
// crash-loop limit stopped one (plan 0018 §7). WI-0018-11 replaces it with the app pages.
//
// It uses AppApi and nothing else. Tests find everything by `data-testid`.

import type { AppApi, ChildName, ChildStatus } from "../contract";

const LABELS: Readonly<Record<ChildStatus["state"], string>> = {
  starting: "starting",
  running: "running",
  "restarting-planned": "restarting",
  restarting: "restarting",
  recovering: "stopped unexpectedly and is being restarted",
  down: "stopped unexpectedly and is being restarted",
  "down-for-good": "stopped",
  stopped: "stopped",
};

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

/** One child's section of the page. */
export function childHtml(status: ChildStatus): string {
  const { child } = status;
  const lines = [
    `<section data-testid="child-${child}" data-state="${status.state}">`,
    `<h2>${escape(child)}</h2>`,
    `<p data-testid="child-state-${child}">${escape(LABELS[status.state])}</p>`,
    `<p>generation <span data-testid="child-generation-${child}">${String(status.generation)}</span>`,
    ` · pid <span data-testid="child-pid-${child}">${status.pid === null ? "" : String(status.pid)}</span>`,
    ` · port <span data-testid="child-port-${child}">${status.port === null ? "" : String(status.port)}</span></p>`,
  ];
  if (status.state === "down-for-good") {
    lines.push(
      `<p role="alert" data-testid="child-error-${child}">${escape(status.error ?? "")}</p>`,
      `<button type="button" data-testid="child-restart-${child}" data-restart="${child}">Restart</button>`,
    );
  }
  lines.push("</section>");
  return lines.join("");
}

/** The whole page body, children in a fixed order. */
export function statusHtml(statuses: Iterable<ChildStatus>): string {
  return [...statuses]
    .sort((a, b) => a.child.localeCompare(b.child))
    .map(childHtml)
    .join("");
}

/** The part of a DOM element the page uses, so it can be exercised without a DOM. */
export interface StatusRoot {
  innerHTML: string;
  addEventListener(type: "click", listener: (event: { readonly target: unknown }) => void): void;
}

/** The child a click asks to restart, when it was on a Restart button. */
export function restartTarget(target: unknown): ChildName | null {
  if (typeof target !== "object" || target === null || !("getAttribute" in target)) {
    return null;
  }
  const { getAttribute } = target;
  if (typeof getAttribute !== "function") {
    return null;
  }
  const child: unknown = getAttribute.call(target, "data-restart");
  return child === "runtime" || child === "services" ? child : null;
}

/** Draw the page into `root`, keep it current, and send Restart presses to the shell. */
export async function mountStatusPage(root: StatusRoot, api: AppApi): Promise<void> {
  const statuses = new Map<ChildName, ChildStatus>();
  const draw = (): void => {
    root.innerHTML = statusHtml(statuses.values());
  };

  // Subscribed first, so no change is missed while the first answer is on its way; that
  // answer then only fills in what no change has reported yet.
  api.onChildStatus((status) => {
    statuses.set(status.child, status);
    draw();
  });
  root.addEventListener("click", (event) => {
    const child = restartTarget(event.target);
    if (child !== null) {
      void api.restartChild(child);
    }
  });
  for (const status of await api.childStatus()) {
    if (!statuses.has(status.child)) {
      statuses.set(status.child, status);
    }
  }
  draw();
}

declare global {
  interface Window {
    readonly inny: { readonly app: AppApi };
  }
}

// In the app page: mount on the preload bridge. A test imports the functions above instead.
if (typeof document !== "undefined") {
  const root = document.getElementById("app");
  if (root !== null) {
    void mountStatusPage(root, window.inny.app);
  }
}
