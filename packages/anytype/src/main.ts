// The Anytype node package's one process entry (plan 0018 §4.2): bundled by esbuild into
// dist/anytype.cjs with the SDK subset and the SAME api-client the services process uses, and
// run with {node}. One process per instance; which of the five types it is comes from the
// start frame's node type (`inny-anytype-<id>`).
//
// How the key stays out of flows and logs:
// * it is not config and not a credential, so no flow file, start frame, journal entry or
//   snapshot ever holds it;
// * it is read per input from the file the runtime named (anytypeKey()), which registers it
//   with this process's redactor first, so no frame or stderr line of this process carries it;
// * a 401 fails the input with PAIR_AGAIN_MESSAGE, once, never retried: the runtime raises the
//   once-only notice on that text.

import { AnytypeClient } from "../../../app/src/adapters/anytype/api-client";
import {
  AnytypeUnauthorizedError,
  PAIR_AGAIN_MESSAGE,
} from "../../../app/src/domain/anytype/errors";
import { DEFAULT_API_BASE_URL } from "../../../app/src/domain/anytype/pins";
import {
  anytypeKey,
  done,
  emit,
  error,
  log,
  redact,
  run,
  start,
  status,
} from "../../../sdk/ts/src/node";
import { InputProblem, OPERATIONS } from "./operations";

/** What an input fails with while InnyTypes has no key: pairing is the fix. */
export const NO_KEY_MESSAGE = "InnyTypes is not paired with Anytype yet; pair in Settings";

const TYPE_PREFIX = "inny-anytype-";

async function main(): Promise<void> {
  const info = await start();
  const typeId = info.node.type.startsWith(TYPE_PREFIX)
    ? info.node.type.slice(TYPE_PREFIX.length)
    : "";
  const operation = OPERATIONS[typeId];
  if (operation === undefined) {
    process.stderr.write(`this package has no type ${JSON.stringify(info.node.type)}\n`);
    process.exit(2);
  }
  const apiBaseUrl =
    typeof info.config["api_base_url"] === "string" && info.config["api_base_url"].trim() !== ""
      ? info.config["api_base_url"].trim()
      : DEFAULT_API_BASE_URL;
  const client = new AnytypeClient({ apiBaseUrl, redact });

  await run({
    input: async (id, event) => {
      const key = anytypeKey();
      if (key === null) {
        status("not paired with Anytype", "red", "ring");
        error(id, NO_KEY_MESSAGE);
        return;
      }
      try {
        const outcome = await operation(client, key, info.config, event.data);
        emit(outcome.port, outcome.data, id);
        done(id);
        status(outcome.said, "green", "dot");
      } catch (caught) {
        if (caught instanceof AnytypeUnauthorizedError) {
          status("Anytype refused the key", "red", "dot");
          error(id, PAIR_AGAIN_MESSAGE);
          return;
        }
        const message = (caught as Error).message;
        if (!(caught instanceof InputProblem)) {
          log(message, "warn");
        }
        status(message.slice(0, 60), "red", "ring");
        error(id, message);
      }
    },
  });
}

void main();
