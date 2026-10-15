// The probe flow the accessibility and dark-mode specs walk the app with: the every-control
// fixture's ticker feeding its probe, as flows.e2e.ts deploys it, so the flow has one run, a board
// in Live and a row in Run history. A spec may deploy more flows beside it.
import * as http from "node:http";
import { expect, type Page } from "@playwright/test";
import { openLive, waitForRunning } from "./app-harness";

export const FLOW = "a11y-e2e";
/** The every-control fixture's ticker feeding its probe, as flows.e2e.ts deploys it: one run. */
const FLOW_NODES = [
  { id: FLOW, type: "tab", label: "Probe flow" },
  {
    id: "tk",
    type: "inny-everycontrol-ticker",
    z: FLOW,
    greeting: "hi",
    delay_ms: "200",
    x: 120,
    y: 60,
    wires: [["pr"]],
  },
  {
    id: "pr",
    type: "inny-everycontrol-probe",
    z: FLOW,
    name: "probe",
    label: "the label",
    count: "2",
    volumes: [],
    credentials: { token: "a11y-token", apikey: "a11y-key" },
    x: 320,
    y: 60,
    wires: [[], []],
  },
];

/** One call to the runtime's Node-RED admin API; its status. */
export function request(port: number, route: string, body?: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const sent = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: route,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(text) },
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          resolve(response.statusCode ?? 0);
        });
      },
    );
    sent.on("error", reject);
    sent.end(text);
  });
}

/** Send the frame to `hash` and wait for it to show `screen`. */
export async function go(window: Page, hash: string, screen: string): Promise<void> {
  await window.evaluate((to) => {
    globalThis.location.hash = to;
  }, hash);
  await expect(window.getByTestId("frame")).toHaveAttribute("data-route", screen, {
    timeout: 15_000,
  });
}

/**
 * Setup closed for good, the probe flow deployed (with `others`, more flows' nodes) and its
 * board shown in Live; the runtime's port.
 */
export async function withProbeFlow(window: Page, others: readonly object[] = []): Promise<number> {
  const port = Number((await waitForRunning(window, "runtime")).port);
  expect(await request(port, "/red/flows", [...FLOW_NODES, ...others])).toBe(204);
  await openLive(window, FLOW);
  await expect(window.getByTestId("place-runs")).toBeVisible({ timeout: 30_000 });
  return port;
}
