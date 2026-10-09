# Install InnyTypes 0.2.1 on a Mac

## 1. What InnyTypes is

InnyTypes turns your recordings and other sources into notes and objects in Anytype, through flows
you draw on a canvas. It also lets your AI assistant (Claude, Codex and others) use your Anytype.

Version 0.2.1 is a pre-release. It runs on macOS only, and it is not signed by Apple, so macOS warns
you the first time you open it. Section 4 shows you how to get past that warning.

## 2. What you need

- **macOS 13 Ventura or later.** InnyTypes is built on Electron 44, which needs macOS 13 or later.
- **The right download for your Mac.** Choose Apple menu › About This Mac. An "Apple M…" chip
  needs `InnyTypes-0.2.1-arm64.dmg`. An "Intel" processor needs `InnyTypes-0.2.1-x64.dmg`.
- **Anytype Desktop**, installed in Applications. Everything Anytype-related needs it. InnyTypes
  opens Anytype for you when it starts, or uses the one already open.
- **Node.js** only if you connect Claude Desktop (section 7.2). Get the LTS version from
  [nodejs.org](https://nodejs.org/).

## 3. Download

Get the file for your Mac from the GitHub release
<https://github.com/recircuitcoop/InnyTypes/releases/tag/v0.2.1>, or from the shared Re:Circuit
iCloud folder `InnyTypes/`. Both hold the same files.

## 4. Install and open it the first time

1. Double-click the `.dmg` file, and drag **InnyTypes** onto the **Applications** folder.
2. Open **InnyTypes** from Applications. macOS says it cannot verify the app. Click **Done**.
3. Choose Apple menu › **System Settings** › **Privacy & Security**.
4. Under **Security**, click **Open Anyway** beside the line about InnyTypes. The button stays
   for about an hour after step 2.
5. Type your Mac password and click **OK**. InnyTypes opens, and macOS does not ask again.

On macOS 13 and 14 you can instead Control-click InnyTypes in Applications, choose **Open**, then
click **Open** again.

If macOS says the app "is damaged and can't be opened", or the steps above do not work, open
**Terminal** (in Applications › Utilities) and run this one line. Then open InnyTypes again.

```bash
xattr -dr com.apple.quarantine /Applications/InnyTypes.app
```

### What you see first

- The window opens on the **Editor** page, the canvas where you build flows.
- Above every page, one question waits for your answer: **"Send anonymous usage and crash reports
  to the InnyTypes servers?"** Read the notice below it, then click **Yes, send reports** or
  **No**. Nothing is sent until you answer, and you can change it later in **Settings** under
  **Reports**.
- The buttons along the top are **Editor**, **Inbox**, **Snapshots**, **Events**, **Jobs**,
  **Packages**, **Settings** and **Quit InnyTypes**.
- Closing the window does not stop InnyTypes. It keeps running so your flows and your AI apps keep
  working. To stop it, click **Quit InnyTypes**.

## 5. Connect Anytype

You pair InnyTypes with Anytype once. After that it connects on its own every time.

1. Make sure Anytype is open and you are logged in.
2. In InnyTypes, click **Settings**.
3. Under **Anytype**, click **Pair with Anytype**.
4. Anytype shows a four-digit code. Leave it on screen.
5. Type the code in the box **The code Anytype shows**.
6. Click **Pair**. The Anytype line shows **starting**, then **ready** after a few seconds. Click
   **Settings** again to see the latest.

InnyTypes keeps the key Anytype gives it in a file only your Mac account can read:
`~/.config/innytypes/anytype_api_key`. You never type it, and you never need to see it.

To pair again, for example after reinstalling Anytype, repeat steps 1 to 6. The new key replaces
the old one.

## 6. The address your AI apps use

While InnyTypes runs, it lets AI apps on this Mac use your Anytype at this address:

```text
http://127.0.0.1:31010/mcp
```

Only apps on your own Mac can reach it. Each app must also send a secret token. InnyTypes makes the
token the first time it starts and keeps it in `~/.config/innytypes/mcp_proxy_token`, readable only
by your Mac account. The steps below read the token from that file, so you never copy it by hand.
Never paste the token into a chat, an email or a shared document.

**To use another port**, for example when another app already uses 31010:

1. Click **Settings** in InnyTypes.
2. Under **MCP endpoint**, leave **Host** as `127.0.0.1`.
3. Type the new number in **Port**, for example `31011`.
4. Click **Move**. **Served now** shows the new address. Nothing restarts.
5. Change the address in every AI app you set up below. They do not follow the move on their own.
   The token stays the same.

## 7. Connect your AI app

Each part below is complete on its own. Do only the ones for the apps you use. If you changed the
port, use your port instead of `31010` everywhere.

### 7.1 Claude Code (the `claude` command in Terminal)

1. Create a small script that hands Claude Code the token. Paste this into Terminal:

   ```bash
   cat > ~/.config/innytypes/mcp-headers.sh <<'EOF'
   #!/bin/sh
   printf '{"Authorization": "Bearer %s"}' "$(cat "$HOME/.config/innytypes/mcp_proxy_token")"
   EOF
   chmod 700 ~/.config/innytypes/mcp-headers.sh
   ```

2. Add InnyTypes for all your projects. This is the `add-json` form of `claude mcp add`, because
   only it accepts the script from step 1:

   ```bash
   claude mcp add-json --scope user innytypes \
     "{\"type\":\"http\",\"url\":\"http://127.0.0.1:31010/mcp\",\"headersHelper\":\"$HOME/.config/innytypes/mcp-headers.sh\"}"
   ```

3. Check it with `claude mcp get innytypes`. It says the server is connected. In a Claude Code
   session, `/mcp` lists InnyTypes and its tools.

Source: <https://code.claude.com/docs/en/mcp> (sections on `headersHelper` and scopes).

### 7.2 Claude Desktop

Claude Desktop reaches InnyTypes through a small helper called `mcp-remote`, which needs Node.js.

1. Check Node.js is installed. In Terminal, `node --version` must print 18 or higher.
2. In Claude Desktop, open the **Claude** menu in the menu bar › **Settings…** › **Developer** ›
   **Edit Config**. This opens `~/Library/Application Support/Claude/claude_desktop_config.json`.
3. Put this in the file. If the file already has other servers, add only the `innytypes` part
   inside the existing `mcpServers`.

   ```json
   {
     "mcpServers": {
       "innytypes": {
         "command": "/bin/sh",
         "args": [
           "-c",
           "exec npx -y mcp-remote@0.14.3 http://127.0.0.1:31010/mcp --allow-http --header \"Authorization:Bearer $(cat \"$HOME/.config/innytypes/mcp_proxy_token\")\""
         ]
       }
     }
   }
   ```

4. Save the file, then quit Claude Desktop completely (Claude › Quit Claude) and open it again.
5. Click the **+** button at the bottom left of the message box, point to **Connectors**, then
   click **Manage connectors**. Select **innytypes** to see its tools.

If **innytypes** does not appear, look in `~/Library/Logs/Claude/mcp-server-innytypes.log`. A line
saying `npx` was not found means Claude Desktop cannot see Node.js. In Terminal, run `which npx`
and put the path it prints in place of `npx` in the file.

Sources: <https://modelcontextprotocol.io/docs/develop/connect-local-servers>,
<https://github.com/geelen/mcp-remote>.

### 7.3 Codex (the `codex` command in Terminal)

1. Make the token available to Codex in every new Terminal window:

   ```bash
   echo 'export INNYTYPES_MCP_TOKEN="$(cat ~/.config/innytypes/mcp_proxy_token 2>/dev/null)"' >> ~/.zshrc
   ```

2. Open a new Terminal window, then add InnyTypes:

   ```bash
   codex mcp add innytypes --url http://127.0.0.1:31010/mcp --bearer-token-env-var INNYTYPES_MCP_TOKEN
   ```

3. Check it with `codex mcp list`, which shows `innytypes`. In a Codex session, `/mcp` lists its
   tools.

Source: <https://learn.chatgpt.com/docs/extend/mcp?surface=cli>, and `codex mcp add --help`.

### 7.4 ChatGPT

**The ChatGPT desktop app** can use InnyTypes. It shares its list of servers with Codex. If you
already did 7.3, **innytypes** is in the list: open it and do steps 4 and 5 below instead of adding
a second one.

1. In Terminal, copy the header value to the clipboard without showing it:

   ```bash
   printf 'Bearer %s' "$(cat ~/.config/innytypes/mcp_proxy_token)" | pbcopy
   ```

2. In the ChatGPT app, open **Settings**, then **MCP servers** (in some versions under
   **Plugins** › **MCPs**), and select **Add server**.
3. Enter the name `innytypes`, choose **Streamable HTTP**, and enter the address
   `http://127.0.0.1:31010/mcp`.
4. Add a header named `Authorization`, and paste the clipboard as its value.
5. Save, then select **Restart**.

Source: <https://learn.chatgpt.com/docs/extend/mcp?surface=chatgpt>.

**ChatGPT on the web is not possible in v0.** It reaches servers from OpenAI's computers, not from
your Mac, so it cannot reach an address on your Mac. It also signs in only with OAuth or with no
sign-in at all, and InnyTypes requires its token. Putting InnyTypes on the internet with no sign-in
would hand your Anytype to anyone who finds the address, so this guide does not offer it.

Source: <https://developers.openai.com/api/docs/guides/developer-mode>.

### 7.5 Mistral

**Mistral Vibe** (the `vibe` command in Terminal) can use InnyTypes.

1. Install Vibe if you do not have it, with
   `curl -LsSf https://mistral.ai/vibe/install.sh | bash`.
2. Do step 1 of 7.3, which makes the token available as `INNYTYPES_MCP_TOKEN`.
3. Add these lines at the end of `~/.vibe/config.toml`:

   ```toml
   [[mcp_servers]]
   name = "innytypes"
   transport = "streamable-http"
   url = "http://127.0.0.1:31010/mcp"
   api_key_env = "INNYTYPES_MCP_TOKEN"
   api_key_header = "Authorization"
   api_key_format = "Bearer {token}"
   ```

4. Open a new Terminal window, start `vibe`, and type `/mcp innytypes` to see its tools.

Source: <https://docs.mistral.ai/vibe/code/cli/mcp-servers>.

**Le Chat is not possible in v0.** Its custom connectors need a public `https://` address with a
valid certificate, and InnyTypes only answers on your own Mac.

Source: <https://docs.mistral.ai/le-chat/knowledge-integrations/connectors/mcp-connectors>.

## 8. Check that it works

With InnyTypes running and paired, run this in Terminal:

```bash
curl -sS -X POST http://127.0.0.1:31010/mcp \
  -H "Authorization: Bearer $(cat ~/.config/innytypes/mcp_proxy_token)" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

You should see one long line that contains `"tools"` and names such as `API-list-spaces`. Then, in
your AI app, ask: "List my Anytype spaces." It should answer with the spaces you see in Anytype.

## 9. If something goes wrong

1. **macOS will not open InnyTypes.** Use **Open Anyway** in Privacy & Security, or run the
   `xattr` line in section 4.
2. **Settings says Anytype did not answer.** Open Anytype and log in. InnyTypes tries again on its
   own.
3. **The code is not accepted.** Click **Pair with Anytype** again and type the new code. Each
   click makes Anytype show a fresh one.
4. **Settings says it "could not bind" the endpoint.** Another app uses port 31010. Choose another
   port as in section 6, then update your AI apps.
5. **Your AI app says "unauthorized" (401).** The app is not sending the current token. Open a new
   Terminal window and set the app up again with the steps in section 7.

## 10. Uninstall

1. Click **Quit InnyTypes**.
2. Drag **InnyTypes** from Applications to the Bin.
3. To remove everything it kept, delete these folders in the Finder (Go › Go to Folder…):
   - `~/Library/Application Support/InnyTypes`: your flows, run history, settings and packages
   - `~/.config/innytypes`: the Anytype key and the token for your AI apps
   - `~/Library/Logs/innytypes`: the log
4. Remove the `innytypes` entry from each AI app you connected, and the `INNYTYPES_MCP_TOKEN` line
   from `~/.zshrc`.
