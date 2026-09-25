// An in-memory catalogue server behind the HttpClient port, recording every request: the old
// suite's PublishingHost (tests/test_plugin_catalogue.py:130-160). An empty `urls` proves
// nothing was asked for. It honours maxBytes as the real client does; the real client itself,
// with its HTTPS and redirect rules, is tested against a local server in
// test/integration/catalogue-server.test.ts.
import type { HttpClient, HttpGetOptions, HttpGetResult } from "../../src/ports/http-client";

export class PublishingHost implements HttpClient {
  readonly responses = new Map<string, Uint8Array>();
  readonly urls: string[] = [];
  /** When set, every request fails this way instead of being answered. */
  failure: Extract<HttpGetResult, { ok: false }> | null = null;

  publish(url: string, document: Uint8Array, signature?: string): void {
    this.responses.set(url, document);
    if (signature !== undefined) {
      this.responses.set(`${url}.minisig`, new TextEncoder().encode(signature));
    }
  }

  get(url: string, options: HttpGetOptions): Promise<HttpGetResult> {
    // Recorded before anything else, so even a 404 proves this was the thing consulted.
    this.urls.push(url);
    if (this.failure !== null) {
      return Promise.resolve(this.failure);
    }
    const body = this.responses.get(url);
    if (body === undefined) {
      return Promise.resolve({ ok: false, failure: "status", detail: `${url} answered 404` });
    }
    if (body.length > options.maxBytes) {
      return Promise.resolve({ ok: false, failure: "oversize", detail: `${url} is too large` });
    }
    return Promise.resolve({ ok: true, body });
  }
}
