// Configuration › General › AI apps › Set up ChatGPT (WI-0022-30; owner, 2026-10-15: "it should
// be a process inside the chatgpt application"). ChatGPT adds a server in its own Settings, so
// this only says the steps and copies the two values they ask for: the address served now, and
// the token the endpoint checks. The token is fetched at the press, put on the clipboard, and
// dropped: it is never drawn, kept in state, or said in a message.
import { useState } from "react";
import type { AppApi } from "../contract";
import { Button } from "../components/atoms/Button";
import { InlineMessage } from "../components/molecules/InlineMessage";
import { CHATGPT_STEPS } from "../general";
import { t } from "../strings";

type Said = { readonly kind: "failed" | "done"; readonly text: string } | null;

export function ChatGptSetup({
  api,
  served,
}: {
  readonly api: AppApi;
  /** The URL served now (it follows Address and Port), or null when nothing is served. */
  readonly served: string | null;
}) {
  const [said, say] = useState<Said>(null);
  const copied = (text: string) => () => {
    say({ kind: "done", text });
  };
  const failed = () => {
    say({ kind: "failed", text: t("refused.failed") });
  };
  const copyAddress = () => {
    if (served === null) {
      return;
    }
    say(null);
    navigator.clipboard.writeText(served).then(copied(t("general.chatgpt.addressCopied")), failed);
  };
  const copyToken = () => {
    say(null);
    api.mcpToken().then(
      (token) => {
        navigator.clipboard.writeText(token).then(copied(t("general.chatgpt.tokenCopied")), failed);
      },
      () => {
        say({ kind: "failed", text: t("general.chatgpt.noToken") });
      },
    );
  };
  return (
    <div data-testid="general-chatgpt" className="flex flex-col gap-2">
      <h3 data-testid="general-chatgpt-title" className="text-body font-semibold text-primary">
        {t("general.chatgpt")}
      </h3>
      <p className="text-body text-secondary">{t("general.chatgpt.line")}</p>
      <ol data-testid="general-chatgpt-steps" className="list-decimal pl-5 text-body text-primary">
        {CHATGPT_STEPS.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ol>
      <div className="flex gap-2">
        <Button
          kind="secondary"
          onClick={copyAddress}
          state={served === null ? "disabled" : "default"}
          data-testid="general-chatgpt-copy-address"
        >
          {t("general.chatgpt.copyAddress")}
        </Button>
        <Button kind="secondary" onClick={copyToken} data-testid="general-chatgpt-copy-token">
          {t("general.chatgpt.copyToken")}
        </Button>
      </div>
      {said === null ? null : (
        <div data-testid="general-chatgpt-message">
          <InlineMessage kind={said.kind}>{said.text}</InlineMessage>
        </div>
      )}
    </div>
  );
}
