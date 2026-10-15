# Install InnyTypes 0.3.0 on a Mac

## 1. What InnyTypes is

InnyTypes turns your recordings and other sources into notes and objects in Anytype, through flows
you draw on a canvas. It also lets your AI assistant (Claude, Codex and others) use your Anytype.

Version 0.3.0 is a pre-release. It runs on macOS only, and it is not signed by Apple, so macOS warns
you the first time you open it. Section 4 shows you how to get past that warning.

## 2. What you need

- **macOS 13 Ventura or later.** InnyTypes is built on Electron 44, which needs macOS 13 or later.
- **The right download for your Mac.** Choose Apple menu › About This Mac. An "Apple M…" chip
  needs `InnyTypes-0.3.0-arm64.dmg`. An "Intel" processor needs `InnyTypes-0.3.0-x64.dmg`.
- **Anytype Desktop**, installed in Applications. Everything Anytype-related needs it. InnyTypes
  opens Anytype for you when it starts, or uses the one already open.
- **Node.js** only if you connect Claude Desktop (section 7.2). Get the LTS version from
  [nodejs.org](https://nodejs.org/).

## 3. Download

Get the file for your Mac from the GitHub release
<https://github.com/recircuitcoop/InnyTypes/releases/tag/v0.3.0>, or from the shared Re:Circuit
iCloud folder `InnyTypes/`. Both hold the same files.

## 4. Install and open it the first time

1. Double-click the `.dmg` file, and drag **InnyTypes** onto the **Applications** folder. If
   InnyTypes 0.2.1 is there already, quit it first, then choose **Replace**. Your flows,
   packages, pairing and settings are kept.
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

### What you see first: Setup

A new installation opens on **Setup**, a short walkthrough. Its steps are listed on the left:

1. **Welcome.** Click **Get started**.
2. **Reports.** InnyTypes asks **"Help improve InnyTypes?"**, with the full privacy notice beside
   the question: what is sent, what never is, and how long it is kept. Click **Send reports** or
   **Don't send**. Nothing is sent before you answer. If you say yes, usage counts are sent to
   Umami Cloud under a machine id that carries no name; never your recordings, transcripts or
   notes. You can change your answer later in **Configuration › General**, under **Reports**.
3. **Anytype.** Connect Anytype, as in section 5, or click **Skip for now**.
4. **Source folder.** Click **Choose a folder…** and pick the folder InnyTypes watches. Every new
   file in it starts your flow.
5. **Steps.** Fill in the starter flow's steps, one form each. The starter flow has one, so the
   form says "Step 1 of 1."
6. **Ready.** Your flow is on. Click **Try with a sample** to run it now with a 10-second sample,
   **Open Live** to see it work, or **I'll build my own** to go to your flows.

If you quit during Setup, it opens on the same step next time. If you used 0.2.1 with flows, you
never see Setup: InnyTypes opens on Live.

### The three places

- **Setup** is the walkthrough above. You see it once.
- **Live** shows one board per flow. Each run is a card that shows its steps as they happen. A
  question waits on the board with **Answer** and **Skip this step**, and the number on **Live**
  and on the dock counts the questions waiting. Use **Edit layout** to add tabs, resize, move or
  hide what is on a board. Something hidden still brings you its questions and failures.
- **Configuration** has two pages. **Flows** lists your flows: turn one on or off, click **Edit**
  to change it on the canvas (click **Save and run** to keep your changes), open its **Run
  history** to **Re-run** or **Delete** runs, or click **New flow**. **General** holds Anytype,
  the folders watched, the address your AI apps use, start at login, updates, reports, packages,
  how long runs are kept, and **Advanced**, the status details for support.

Closing the window does not stop InnyTypes. It keeps running so your flows and your AI apps keep
working. To stop it, choose **InnyTypes › Quit InnyTypes** in the menu bar (⌘Q), or Control-click
its icon in the dock and choose **Quit**.

## 5. Connect Anytype

You pair InnyTypes with Anytype once. After that it connects on its own every time.

1. Make sure Anytype is open and you are logged in.
2. In InnyTypes, go to the **Anytype** step of Setup, or to **Configuration › General** and click
   **Pair** under **Anytype**.
3. Anytype shows a four-digit code. Leave it on screen.
4. Type the code in the box **The code Anytype shows**.
5. Click **Connect** in Setup, or **Pair** in General. InnyTypes says **Connected** and how many
   spaces it found.

InnyTypes keeps the key Anytype gives it in a file only your Mac account can read:
`~/.config/innytypes/anytype_api_key`. You never type it, and you never need to see it.

To pair again, for example after reinstalling Anytype, click **Pair again** under **Anytype** in
**Configuration › General**, and do steps 3 to 5. The new key replaces the old one.

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

1. In InnyTypes, go to **Configuration › General**, to **AI apps**.
2. Leave **Address** as `127.0.0.1`. Only an address on your own Mac is accepted.
3. Type the new number in **Port**, for example `31011`.
4. Click **Change**. The line above shows the new address. Nothing restarts.
5. Change the address in every AI app you set up below. They do not follow the change on their
   own. The token stays the same.

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

This is for Codex in a Terminal window; **Copy setup for Codex** in **Configuration › General ›
AI apps** copies the line in step 2. An app you start from the Dock, such as the ChatGPT desktop
app, does not read `~/.zshrc`, so it never sees `INNYTYPES_MCP_TOKEN`: set ChatGPT up inside
ChatGPT instead, as in 7.4.

Source: <https://learn.chatgpt.com/docs/extend/mcp?surface=cli>, and `codex mcp add --help`.

### 7.4 ChatGPT

**The ChatGPT desktop app** can use InnyTypes. You add InnyTypes inside ChatGPT, in its own
Settings. InnyTypes shows the same steps in **Configuration › General › AI apps**, under **Set up
ChatGPT**, with a button for each value to paste.

1. In the ChatGPT app, open **Settings**, then **MCP servers** (in some versions under
   **Plugins** › **MCPs**), and choose **Add server**. ChatGPT shares this list with Codex: if
   **innytypes** is already there from 7.3, open it instead of adding a second one.
2. **Name:** `innytypes`. **Transport:** **Streamable HTTP**.
3. **URL:** in InnyTypes, click **Copy address**, then paste it here. It is
   `http://127.0.0.1:31010/mcp` unless you changed the port.
4. **Authentication:** choose **Bearer token**. In InnyTypes, click **Copy token**, then paste it
   here. InnyTypes never shows the token; it only puts it on the clipboard when you click.
5. Save, then choose **Restart**.

If you change the port in InnyTypes later, edit the URL in ChatGPT the same way. The token stays
the same.

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
2. **General says "Anytype can't be used right now".** Open Anytype and log in. InnyTypes tries
   again on its own. **Advanced** has the details.
3. **The code is not accepted.** Click **Pair again** and type the new code. Each click makes
   Anytype show a fresh one.
4. **General says "AI apps can't reach your Anytype through InnyTypes right now".** Another app
   may use port 31010. Choose another port as in section 6, then update your AI apps.
5. **Your AI app says "unauthorized" (401).** The app is not sending the current token. Open a new
   Terminal window and set the app up again with the steps in section 7.
6. **Your AI app says a file "wasn't sent".** InnyTypes sends files from Anytype up to 16 MB.
   Ask for part of a larger file with a byte range.
7. **InnyTypes keeps stopping just after an update.** From the release after 0.3.0 on, the banner
   offers to go back to the version you had. See section 10.

## 10. Updates and Go back

**Configuration › General › Updates** shows the version you run and when InnyTypes last checked
for a new one. Click **Check now** to check at once. A new version is downloaded, checked against
its signature, and installed when you quit; one that fails the check is not installed.

This pre-release is not yet connected to a release channel, so InnyTypes does not find the next
version on its own yet: install it from its download, as in sections 3 and 4.

**Go back.** For 7 days after an update, **Go back to** the version you had appears under
**Updates**. Click it, then **Go back** to confirm. Your flows and settings are kept. If InnyTypes
keeps stopping in its first minutes on a new version, the banner offers the same Go back. It never
goes back on its own.

0.3.0 is the first version that records which version it is. Version 0.2.1 recorded nothing, so
after you install 0.3.0 over 0.2.1 there is nothing to go back to and no Go back is offered. The
first version you can go back from is the one after 0.3.0, back to 0.3.0.

## 11. Uninstall

1. Quit InnyTypes (⌘Q).
2. Drag **InnyTypes** from Applications to the Bin.
3. To remove everything it kept, delete these folders in the Finder (Go › Go to Folder…):
   - `~/Library/Application Support/InnyTypes`: your flows, run history, settings and packages
   - `~/.config/innytypes`: the Anytype key and the token for your AI apps
   - `~/Library/Logs/innytypes`: the log
4. Remove the `innytypes` entry from each AI app you connected, and the `INNYTYPES_MCP_TOKEN` line
   from `~/.zshrc`.
