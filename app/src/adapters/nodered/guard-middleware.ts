// The deploy guard and the Host check as Express middleware, in front of Node-RED's admin API
// (spec 11.3, plan 0018 §2.2). The decisions are application/deploy-guard.ts's.
//
// The guarded routes parse their bodies here with the same two parsers Node-RED's admin API
// uses (JSON, and url-encoded with `extended: true`), and the same limit. body-parser marks a
// parsed request, so Node-RED acts on exactly the body the guard checked: a url-encoded deploy
// cannot slip past a guard that only read JSON.

import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import express, { type RequestHandler, type Router } from "express";
import type { FlowsRoute, RequestGuard as Guard } from "../../ports/request-guard";

/** Node-RED's own default for `apiMaxLength`. */
const BODY_LIMIT = "5mb";

/** Every request, first: refused unless its Host header names this server. */
export function hostCheck(guard: Guard): RequestHandler {
  return (request, response, next) => {
    const answer = guard.checkHost(request.headers.host);
    if (answer.ok) {
      next();
      return;
    }
    response.status(answer.status).json(answer.body);
  };
}

/**
 * The same check for a WebSocket upgrade (the editor's `/red/comms`), which never reaches
 * Express. Registered before Node-RED's own listener, it ends a refused handshake with a 403
 * and destroys the socket, so Node-RED's listener finds nothing left to upgrade.
 */
export function upgradeHostCheck(server: Server, guard: Guard): void {
  server.prependListener("upgrade", (request: { headers: { host?: string } }, socket: Duplex) => {
    if (guard.checkHost(request.headers.host).ok) {
      return;
    }
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    socket.destroy();
  });
}

function checkDeploy(guard: Guard, route: FlowsRoute): RequestHandler {
  return (request, response, next) => {
    guard.checkDeploy(route, request.body).then(
      (answer) => {
        if (answer.ok) {
          next();
          return;
        }
        response.status(answer.status).json(answer.body);
      },
      (error: unknown) => {
        next(error);
      },
    );
  };
}

/** The writes to the flows, each parsed and checked before Node-RED's admin API sees it. */
export function deployGuard(guard: Guard, adminRoot: string): Router {
  const router = express.Router();
  const parse = [
    express.json({ limit: BODY_LIMIT }),
    express.urlencoded({ limit: BODY_LIMIT, extended: true }),
  ];
  router.post(`${adminRoot}/flows`, ...parse, checkDeploy(guard, "flows"));
  router.post(`${adminRoot}/flow`, ...parse, checkDeploy(guard, "flow"));
  router.put(`${adminRoot}/flow/:id`, ...parse, checkDeploy(guard, "flow"));
  return router;
}
