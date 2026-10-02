// The canvas form's dynamic options (plan 0022 §B, D9): `GET /red/inny/options` with
// `source=spaces`, or `source=types&space=<id>`, answers `{options: [{value, label}]}` or
// `{refused: {reason, sentence}}`.
//
// Mounted behind the Host check, like every other route under /red, so only a page this server
// served can read it. The answer is the runtime's resolver's (application/node-options.ts),
// which asks the services process: ids and names reach the editor, the Anytype key never does.

import express, { type Router } from "express";
import {
  parseOptionsQuery,
  type OptionsAnswer,
  type OptionsQuery,
} from "../../domain/forms/node-options";

/** Where the route sits under the admin root. */
export const OPTIONS_PATH = "/inny/options";

export function optionsRoute(
  adminRoot: string,
  resolve: (query: OptionsQuery) => Promise<OptionsAnswer>,
): Router {
  const router = express.Router();
  router.get(`${adminRoot}${OPTIONS_PATH}`, (request, response, next) => {
    // Never kept by the editor's page: a space made in Anytype a moment ago must show.
    response.set("Cache-Control", "no-store");
    const query = parseOptionsQuery(request.query);
    if (query === null) {
      response
        .status(400)
        .json({ error: "ask with source=spaces, or source=types and the space's id as space" });
      return;
    }
    resolve(query).then(
      (answer) => {
        response.json(answer);
      },
      (error: unknown) => {
        next(error);
      },
    );
  });
  return router;
}
