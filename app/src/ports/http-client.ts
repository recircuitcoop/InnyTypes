// One GET over HTTPS, capped (plan 0018 §2.3 HttpClient; WI-0018-14). The one fetcher: the
// HTTPS rule is applied to the URL and to every redirect hop before a request goes out, and
// the body is abandoned the moment it passes its ceiling. It never throws: every failure is
// a result, so no transport's own exception reaches a caller that catches only its own.

export interface HttpGetOptions {
  /** The most bytes the body may have; one more and the response is abandoned. */
  readonly maxBytes: number;
}

export type HttpGetFailure =
  /** The URL, or a redirect hop, is not HTTPS: nothing was sent to it. */
  | "insecure"
  /** The server answered with a status other than 2xx, or redirected too often. */
  | "status"
  /** No answer: refused, reset, timed out, or a TLS failure. */
  | "transport"
  /** The body passed `maxBytes`. */
  | "oversize";

export type HttpGetResult =
  | { readonly ok: true; readonly body: Uint8Array }
  | { readonly ok: false; readonly failure: HttpGetFailure; readonly detail: string };

export interface HttpClient {
  get(url: string, options: HttpGetOptions): Promise<HttpGetResult>;
}
