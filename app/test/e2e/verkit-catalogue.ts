// Package fixtures shared by the specs that install from a folder or a catalogue: a node that
// says its version, a package folder around it, and a local HTTPS catalogue offering `verkit`,
// signed with its own key (packages.e2e.ts, a11y.e2e.ts).
import fs from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Signer } from "../fakes/minisign-signer";
import { signedArchive, type Files } from "../fakes/package-archive";

const TLS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "tls");
export const CERT = fs.readFileSync(path.join(TLS, "localhost-cert.pem"), "utf8");
export const KEY = fs.readFileSync(path.join(TLS, "localhost-key.pem"), "utf8");

/** A node that writes its package's version into its data folder at start, then sends ready. */
export function versionNode(version: string): string {
  return `const fs = require("fs");
const path = require("path");
const readline = require("readline");
const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.t === "start") {
    fs.mkdirSync(frame.data_dir, { recursive: true });
    fs.writeFileSync(path.join(frame.data_dir, "version.txt"), ${JSON.stringify(version)});
    send({ t: "ready" });
  } else if (frame.t === "close") {
    send({ t: "closed" });
    process.exit(0);
  }
});
`;
}

/** Write a package folder: its declaration at `version` and its node, `body`. */
export function writePackageFolder(
  folder: string,
  name: string,
  version: string,
  body: string,
): void {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, "inny-package.json"),
    JSON.stringify({
      protocol: 2,
      package: name,
      version,
      environment: { kind: "node", node: ">=22" },
      types: [
        {
          id: "step",
          kind: "node",
          label: `${name} step`,
          command: ["{node}", "{package}/node.js"],
          config: { type: "object" },
          outputs: [{ port: "out", event: `${name}.out.v1` }],
        },
      ],
    }),
  );
  fs.writeFileSync(path.join(folder, "node.js"), body);
}

/** A local HTTPS catalogue offering `verkit` at the versions published so far, signed. */
export async function serveVerkit(): Promise<{
  url: string;
  key: string;
  publish(version: string): void;
  close(): Promise<void>;
}> {
  const signer = new Signer();
  const published = new Map<string, Uint8Array>();
  const server = https.createServer({ cert: CERT, key: KEY }, (request, response) => {
    const body = published.get(request.url ?? "");
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-length": String(body.length) }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `https://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const files = (version: string): Files => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "inny-verkit-"));
    writePackageFolder(folder, "verkit", version, versionNode(version));
    const read = (file: string) => fs.readFileSync(path.join(folder, file), "utf8");
    const out = { "inny-package.json": read("inny-package.json"), "node.js": read("node.js") };
    fs.rmSync(folder, { recursive: true });
    return out;
  };
  return {
    url: `${base}/catalogue.json`,
    key: signer.publicKeyLine,
    publish: (version) => {
      published.set(`/verkit-${version}.tgz`, signedArchive(files(version), signer));
      const document = new TextEncoder().encode(
        JSON.stringify({
          catalogue: 1,
          plugins: [
            {
              id: "verkit",
              summary: "Says its version.",
              source: "index",
              version,
              archive: `verkit-${version}.tgz`,
            },
          ],
        }),
      );
      published.set("/catalogue.json", document);
      published.set("/catalogue.json.minisig", new TextEncoder().encode(signer.sign(document)));
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
