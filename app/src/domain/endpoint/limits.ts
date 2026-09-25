// The gateway's bounds and its fixed answers (plan 0018 §4.1 point 3, gateway.py:40-63).
//
// Named here rather than at their one use, because each is part of the endpoint's contract:
// a client meets them, the tests stage them, and the GET refusal is the one answer the service
// gives a request that carries no credential at all.

/** What a GET is answered with, whoever sends it (gateway.py:45). */
export const GET_REFUSAL = "GET not supported";

/** The largest request body read, declared by Content-Length before any byte of it is read. */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The largest header block, request line included, answered 431 beyond it. The old service had
 * http.client's bounds (a 65,536-byte line, 100 headers); node:http bounds the whole block, so
 * the bound is set here explicitly, at node:http's own default, rather than left implicit.
 */
export const MAX_HEADER_BYTES = 16 * 1024;

/** Requests past every header check at once; the next is answered 429, not queued. */
export const MAX_CONCURRENT_REQUESTS = 8;

/**
 * How long one read of the body may wait for its next bytes: the client that announces a body
 * and then says nothing (gateway.py:50-55).
 */
export const READ_TIMEOUT_MS = 15_000;

/**
 * How long the whole request (request line, headers and body) may take to arrive, however the
 * bytes are spaced out: the client that dribbles a byte at a time. It bounds the client's bytes,
 * never the child's answer (gateway.py:57-61).
 */
export const RECEIVE_TIMEOUT_MS = 30_000;

/** The HTTP refusals, each a JSON object `{"error": ...}` and never an echo of the request. */
export const REFUSALS = {
  notFound: "not found",
  method: "method not allowed",
  bearer: "bearer authentication required",
  origin: "loopback origin required",
  length: "Content-Length required",
  tooLarge: "request too large",
  busy: "request bound is full",
  timedOut: "request timed out",
} as const;
