---
type: plan
title: The new InnyTypes application
status: DONE
created: 2026-09-25
updated: 2026-10-09
---

# 0018 — The new InnyTypes application (plan 0017 slices 03–06)

**Done 2026-10-09.** The owner marked WI-0018-01 to 29 and 31 done; the app shipped as v0.2.0 and
v0.2.1. The two items still blocked moved out as their own plans: Windows to
[0025](0025-windows.md) (WI-0025-01) and deleting the old app to
[0026](0026-delete-the-old-application.md) (WI-0026-01).

**Approved 2026-09-25** under the owner's instruction *"proceed with the steps"*. UX and design changes
come from the owner later. Section 2.4 keeps the UI replaceable for them. One correction was made
at approval: the design had dropped the MCP heartbeat the owner required in plan 0010. It is
restored in §3 and WI-0018-18.

## What this plan decides, in one screen

- **Languages.** The shell, the runtime and the Anytype core service are written in TypeScript.
  Nothing in the running core stays in Python. Python survives as the **node SDK** that Python node
  packages use, and as a few repository tools.
- **Where the code lives.** It goes on `main`, in new top-level folders (`app/`, `sdk/`,
  `packages/`, `tools/parity/`). There is no long-lived branch. The old app is untouched and keeps
  shipping until the cutover. The cutover itself is one short-lived branch and one merge.
- **Three processes, not two.** Each has exactly one composition root (the one place where its
  parts are wired together):
  - the **shell** (Electron main);
  - the **runtime** (a `utilityProcess` with Node-RED, the journal and the node processes);
  - a new **services** process (a `utilityProcess` with Anytype: the key, the MCP child and the
    loopback MCP endpoint).

  Anytype is separate so that the 300 ms runtime restarts that come with every node-type change
  (arch_pivot P11a) never interrupt Codex or the MCP child.
- **Parity.**
  - `docs/parity/ledger.csv` has one row per old pytest id: 2,638 rows, seeded by a script.
  - The gate refuses any row whose new test did not **pass in the same gate run**.
  - Machine proofs per OS go in `docs/parity/proofs.csv`.
- **Anytype key.** It stays in its existing owner-only file, `~/.config/innytypes/anytype_api_key`.
  Node-RED never sees it, nor any flow, journal, log or start frame.
  - The Anytype service reads it, and so does the first-party Anytype node package (spec 11.1,
    proven by the spike).
  - The runtime registers the key with the log redactor, so a node that prints it to stderr is
    still redacted.
- **Updates.** Updates use electron-updater from GitHub Releases, with a minisign check of the
  update metadata. This keeps the old rule: "trust the signature, never the server".
- **Cutover is blocked on Windows.** Plan 0017 requires every proof to pass on macOS, Linux **and**
  Windows. No Windows machine exists, so the Windows work and the cutover moved out to plans 0025 (WI-0025-01) and 0026 (WI-0026-01) on 2026-10-09.

---

## 1. Languages and tooling

| Concern | Decision | Why |
|---|---|---|
| Shell, runtime, services | **TypeScript, strict** (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) | Electron and Node-RED are JavaScript. The spike's 1,700 lines of JS are the reference, not the start. A second core language would need a Python sidecar process plus a second toolchain in the core. |
| Build | `tsc -b` type-checks. **esbuild** bundles one file per process entry (shell main, preloads, runtime, services) and each first-party JS node package. | Fast, MIT, no framework lock-in. Node-RED itself stays an ordinary dependency and is not bundled, because it loads its node files from disk. |
| Package and installer | **electron-builder** (MIT), as proven in the spike (P8, P10g, P11g), with **electron-updater** for updates | Signing, notarising, per-arch builds, AppImage/deb/NSIS, and a GitHub Releases provider, all in one tool. |
| Package manager | **npm workspaces** with the committed `package-lock.json`, installed by `npm ci` | The root `package.json` already pins `@anyproto/anytype-mcp` 1.2.10, and `tests/test_pinning.py` reads it. The root becomes the workspace root without moving that pin. |
| Unit and integration tests | **vitest** (MIT), with v8 coverage | Fast, and native TS. It runs the conformance harness too. |
| End-to-end tests | **Playwright's `_electron`** driver (Apache-2.0) against the dev build in the gate, and against the packaged app in machine proofs | It drives the real Electron app, including pop-out windows. It needs no browser download. |
| Lint and format | **ESLint** flat config with typescript-eslint, plus **Prettier** | The standard, and boring. |
| Architecture rules | **dependency-cruiser** (MIT) | It enforces the hexagonal layer rules in section 2 as a failing gate check, not a convention. |
| JSON Schema | **ajv** 2020-12 build, plus `ajv-formats` | Spike finding: forms and payloads need a real validator (arch_pivot §5.4; spike `runtime/eventTypes.js:135` handles only 4 types). |
| Journal storage | **`node:sqlite`** (built into Node 24, WAL mode), behind the `JournalStore` port | It needs no native module, so there is no rebuild per architecture. WI-07 first proves it loads inside a packaged `utilityProcess`. If it does not, the adapter becomes `better-sqlite3`, rebuilt by electron-builder. The port makes the swap one file. |
| MCP gateway | Our own HTTP handler on `node:http`, porting `anytype_mcp/gateway.py` | Its 74 tests encode specific limits that a framework would hide: bearer check before body parse, Host/Origin checks, 1 MiB body, 8 concurrent requests, 15 s / 30 s timeouts (`gateway.py:38-64`). |
| Signatures | minisign verified with `node:crypto` (`ed25519`, and `blake2b512` for the pre-hashed form) | It ports `helper/minisign.py` (275 lines) with no dependency. |
| **Python node SDK** | `sdk/python/` → PyPI package `innytypes-node`, pure standard library, Python 3.13, with its own `pyproject.toml` and `uv.lock` | Grown from the spike's `packages/_sdk/inny_node.py` (106 lines) to the spec's Appendix A and conformance C1–C14. |
| **TS node SDK** | `sdk/ts/` → npm package `@innytypes/node`, no runtime dependencies | Spec Appendix B. JS packages ship **pre-bundled** (one file) and run with the bundled Node, so installing one never runs npm. |
| Bundled runtimes | Each pinned by version **and sha256** per OS/arch: python-build-standalone 3.13, `uv`, and **Node 24 LTS** | The runtime cannot fork a `utilityProcess`. JS node packages and the Anytype MCP child therefore need a real `node` binary. Bundling one lets the Electron RunAsNode fuse stay **off**. Size does not matter. |

UI: plain TypeScript and HTML, with no framework and one small stylesheet. Section 2.4 explains how
the UI is kept replaceable.

---

## 2. Where the new app lives

### 2.1 Branch strategy: trunk, not a long-lived branch

- All slice 03–05 work lands on `main`, in **new** folders. Nothing under `src/innytypes/` or
  `tests/` is edited, except:
  - fixes the old app still owes (plan 0015 applies until the cutover);
  - the farewell release (WI-0018-31).
- The new app is never shipped before the cutover, so users see nothing. The gate runs both suites.
- **The cutover is one change** (WI-0026-01), on a short-lived branch `cutover/0017`, merged once
  and tagged `v1.0.0`. It deletes `src/innytypes`, `src/helper`, `tests/`, the Python host parts of
  `pyproject.toml`, the Briefcase config and the Python stages of the gate.
- **Why not a `pivot/0017` branch?**
  - A branch that lives for months diverges from a `main` that still receives fixes.
  - The parity ledger needs the old tests *present and running* while it is filled in.
  - On `main`, the gate itself can check that the ledger and the old suite agree (section 5).
  - The owner's "sudden and massive" is kept, because users get the new app in one release. It
    just isn't built in secret.
- The spike branch `spike/0017-node-red` is **reference only**. Its code is not merged. New code
  cites it.

### 2.2 The three processes

```
Shell: Electron main process (composition root: app/src/shell/main.ts)
  windows (app page, pop-outs), single-instance lock, quit, notifications, badge,
  launch at login, updates, telemetry, SecretStore (safeStorage), the ONE log writer,
  supervisor for the two utility processes (planned restart, crash backoff, crash-loop stop),
  app pages served on inny-app://, view pages on inny-view:// (own session partitions)
      │ typed, versioned channel (MessagePort, structured clone)         │
      ▼                                                                   ▼
Runtime: utilityProcess                                   Services: utilityProcess
(root: app/src/runtime/main.ts)                           (root: app/src/services/main.ts)
  127.0.0.1:<stable port>/red: Node-RED editor +             Anytype API client, key read,
  admin API behind the deploy guard; Node-RED 5;             pairing; MCP child (bundled node +
  generated types; journal (sqlite); snapshots;              pinned @anyproto/anytype-mcp);
  event types; package store                                 MCP session; loopback gateway
      │ stdin/stdout JSON lines (protocol v2)                    127.0.0.1:31010/mcp
      ▼                                                               │ stdio MCP
  one process per node instance                                       ▼
  (Python in its package's uv env, JS on bundled node, executables)   @anyproto/anytype-mcp
```

- The shell hands the runtime and services one end each of a `MessageChannelMain`, so they talk to
  each other directly. The runtime uses this to register the Anytype key with its redactor and to
  show Anytype status on node forms.
- **The port is stable for the session.** The shell picks a free loopback port once at launch and
  gives every runtime generation the same one. The editor's iframe URL therefore never changes
  across restarts, which is what keeps undeployed edits (P11b).
- The admin API stays without a token, as the owner ruled. The guard also refuses requests whose
  `Host` header is not `127.0.0.1:<port>` or `localhost:<port>`. This is not the token the owner
  declined. It blocks a web page from reaching the admin API by DNS rebinding, at no cost.

### 2.3 Directory layout (hexagonal)

```
package.json                 workspace root; keeps "@anyproto/anytype-mcp": "1.2.10"
app/
  package.json  electron-builder.yml  tsconfig.json  vitest.config.ts  playwright.config.ts
  .dependency-cruiser.cjs    layer rules (below)
  build/                     icons (moved from src/innytypes/resources), entitlements, fuses
  src/
    domain/                  pure logic: no I/O, no Node, Electron or Node-RED imports
      events/                event type names, envelope, run/causation, payload validation
      journal/               entry states, retry rules (planned/crash/quit), queue bound
      packages/              declaration model, content hash, version rules (plan 0013)
      supervision/           backoff, crash-loop breaker (N exits in a window)
      notices/               notice kinds, wording, once-only rule
      redaction/             secret registry, redact(), telemetry payload redaction
      endpoint/              numeric-loopback rule, URL
      forms/                 JSON Schema → form model (incl. arrays of objects), coercion
    application/             use cases; each takes ports as arguments
      deploy-guard.ts  present-view.ts  submit-view.ts  press-snapshot-action.ts
      create-event-type.ts  install-package.ts  remove-package.ts  update-package.ts
      pair-anytype.ts  move-endpoint.ts  quit.ts  migrate-old-install.ts ...
    ports/                   interfaces only
      JournalStore SnapshotStore EventTypeStore PackageStore SettingsStore SecretStore
      ProcessLauncher Clock Logger Notifier LoginItem Badge WindowHost Updater
      SignatureVerifier HttpClient HttpListener NodeRedEngine Channel Telemetry
    adapters/
      nodered/     settings, generator, registration shim, guard middleware, editor sync
      process/     protocol-v2 codec (ajv on the spec's frame schemas), node-process, env builders
      sqlite/      journal
      fs/          snapshots, event types, packages, settings, owner-only files
      electron/    windows, pop-outs, protocol handlers, notifications, login item, safeStorage, updater
      anytype/     api-client, mcp-child, mcp-session, gateway, tool_surface.json
      signature/   minisign
      telemetry/   glitchtip, umami transports, disk queue
      channel/     typed utilityProcess channel with timeouts and typed errors
    shell/main.ts            composition root 1
    runtime/main.ts          composition root 2
    services/main.ts         composition root 3
    ui/
      contract.ts            AppApi: the ONLY surface pages may use
      pages/                 inbox, snapshots, events, jobs, packages, settings
      view/                  generic view renderer (text, table, form, media, anytype link)
  test/ unit/ integration/ conformance/ e2e/ fixtures/
packages/                    first-party node packages, shipped inside the app
  anytype/  views/           (views: generic action/snapshot helpers used in tests and demos)
sdk/python/  sdk/ts/         node SDKs, published separately
tools/parity/                seed_ledger.py, check.ts, proofs template
tools/proofs/                scripted machine proofs (Playwright against the packaged app)
tools/refresh-tool-surface.ts   replaces anytype_mcp/refresh.py (dev only, not shipped)
docs/parity/                 ledger.csv, old-tests.txt (+ sha256), proofs.csv, evidence/
```

**Layer rules** (dependency-cruiser, a failing gate check):
- `domain` imports nothing outside `domain`.
- `application` imports `domain` and `ports` only.
- `adapters` import `ports` and `domain`, never each other across families. An `anytype` adapter
  never imports a `nodered` one.
- Only the three `main.ts` files import adapters.
- `ui` imports only `ui/contract.ts`.
- No module anywhere reads `process.env` except the composition roots, which fixes the old app's
  global-state debt.
- No file may exceed 600 lines, which prevents god modules.

### 2.4 Designed for a replaceable UI

- Every page uses one typed interface, `AppApi` (`ui/contract.ts`), exposed through the preload
  bridge as `window.inny.app`. It covers state, the inbox, submit, snapshots, actions, event types,
  jobs, cancel, packages, settings and pairing.
- Contract tests exercise `AppApi` with no DOM. e2e tests find elements by `data-testid` only, never
  by layout.
- A redesign replaces `ui/pages/*` and keeps every test except the few page-structure checks.
- The Node-RED editor is embedded as-is, with InnyTypes titles only. No theming work is done.

---

## 3. The fate of every existing Python module

Fates:
- **Port:** rewritten in TS with its tests re-expressed.
- **Replace:** an Electron, Node-RED or library feature does the job, and our integration of it is
  tested.
- **Delete:** the behaviour is gone on purpose. Its ledger rows are retired with a reason.

"New home" is a path under `app/src/` unless stated otherwise.

| Module (lines) | Fate | New home | Reason |
|---|---|---|---|
| `__init__.py`, `__main__.py`, `src/helper/*` | Delete | none | Briefcase and CLI entry points. |
| `events/__init__.py`, `bus.py`, `channel.py`, `delivery.py`, `emitter.py`, `transport.py` (1,572) | Delete | none | Node-RED wires carry events now. Two rules survive, both in `adapters/process/node-process.ts`: a node may emit only on declared ports (identity binding, spec 11.2), and a bounded queue that is **reported** (spec 7.6) instead of dropping at 128. |
| `addons/manifest.py` (1,182) | Port, reshaped | `domain/packages/declaration.ts` | `inny-package.json` (spec §2), validated by ajv against the spec's §2.6 schema. It still refuses and never warns (`manifest.py` docstring). |
| `addons/discovery.py` (302) | Port | `adapters/fs/package-store.ts` | Enumerates installed packages from records written at install. |
| `addons/install.py` (1,008) | Port, reshaped | `application/install-package.ts`, `adapters/process/env-*.ts` | Install only because a person asked; refuse a second install; stage, then record (`install.py:622-1000`). |
| `addons/lock.py` (527) | Port, reshaped | `domain/packages/lock.ts` | Hash-locked requirements for uv packages, plus a content hash of the whole package, which answers plan 0013 (a version that moved). |
| `addons/resolution.py` (301) | Delete | none | Packages no longer depend on each other at start; the flow is the graph. |
| `addons/removal.py` (331) | Port | `application/remove-package.ts` | Refuse while any **deployed or undeployed** flow uses its types (spike P9e plus the P11b gap), stop it, take everything. |
| `addons/run.py` (775) | Replace | `sdk/python` (`innytypes_node`) | The far side of the process boundary is now the protocol v2 SDK. |
| `addons/secrets.py` (499) | Replace | Node-RED credentials, plus `ports/SecretStore` | Node secrets are Node-RED credentials (spec 2.5). The owner-only file mode rules are kept for app secrets. |
| `addons/settings.py`, `settings_form.py` (1,862) | Delete | none | "Plugin settings files replaced by node config" (plan 0017 architecture 3). Forms come from the type's schema (`domain/forms`). |
| `anytype_api.py` (275) | Port | `adapters/anytype/api-client.ts` | Also bundled into `packages/anytype`: one client, two users. |
| `anytype_mcp/config.py` (164) | Port | `adapters/anytype/config.ts` | Pins stay as they are: `PACKAGE_VERSION` 1.2.10 and `ANYTYPE_VERSION` "2025-11-08" (`config.py:32-36`). Canonical key file plus read-only legacy fallback (`config.py:47-48`). |
| `anytype_mcp/endpoint.py` (62) | Port | `domain/endpoint` | Numeric loopback only; default 127.0.0.1:31010 at `/mcp` (`endpoint.py:19-21`). |
| `anytype_mcp/gateway.py` (622) | Port | `adapters/anytype/gateway.ts` | The plans 0007/0008 behaviours, including `rebind` (`gateway.py:343`). |
| `anytype_mcp/health.py` (36) | Port | `adapters/anytype/health.ts` | The reachability gate before the child starts. |
| `anytype_mcp/keys.py` (390) | Port pairing, delete `get-key` | `application/pair-anytype.ts` | The four-digit challenge flow (`keys.py:109-160`) moves to the Settings page. The `get-key` subprocess path is retired. |
| `anytype_mcp/protocol.py` (3) | Port | constant | |
| `anytype_mcp/refresh.py` (241) | Replace | `tools/refresh-tool-surface.ts` | A developer tool, as before; not shipped and not in the gate. |
| `anytype_mcp/session.py` (246) | Port | `adapters/anytype/mcp-session.ts` | One reader, serialised writes, bounds (`session.py:14-16`), no silent retry. |
| `anytype_mcp/supervisor.py` (290) | Port, changed | `adapters/anytype/mcp-child.ts` | Spawns the **bundled** node and package instead of `npx -y` (`supervisor.py:118`). This removes a network fetch at start. |
| `anytype_mcp/tools.py` + `tool_surface.json` | Port | `adapters/anytype/tool-surface.ts` | The committed surface must match exactly before tools are served. |
| `children.py` (1,628) | Split: port and delete | `adapters/process/node-process.ts`, shell supervisor | Kept: spawn and close escalation, and "no orphan" (`children.py:544-700`): process groups on POSIX, Job Objects on Windows. Deleted: the run-state file, `ChildKind`, the command vocabulary. |
| `cli.py` (1,689) | Delete | none | The canvas is the only authoring surface. Developer actions become repo tools, plus "Install from file…" in the app. |
| `host.py` (725) | Delete | none | Its composition moves to `runtime/main.ts` and `services/main.ts`. Degradations become a `Status` model shown on Settings. |
| `logs.py` (516) | Port | shell `adapters/fs/log-writer.ts`, `domain/redaction` | Same path, rotation 2 MiB × 3, level variable (`logs.py:161-196`), and one writer (WI-04). |
| `helper/breaker.py` (273) | Port | `domain/supervision/breaker.ts` | N exits inside a window, then stop and tell the person. Used for the runtime, services, MCP child and node instances. |
| `helper/catalogue.py` (830) | Port | `domain/packages/catalogue.ts` + adapter | A signed listing; any publisher may become a source (plan 0006 F1). |
| `helper/config.py` (1,551) | Replace | `adapters/fs/settings-store.ts` (JSON plus ajv) | Imported once from `config.toml` by WI-25. |
| `helper/control.py` (1,302) | Delete | `adapters/channel` | The typed `utilityProcess` channel replaces the Unix socket. |
| `helper/detection.py` (522) | Split: port for the MCP child, retire for nodes | `domain/supervision/staleness.ts` (services) | **The MCP child keeps staleness judgement:** no answered ping within its stability profile means stale, so it is restarted with a notice (plan 0010). A slow pass defers and never fabricates a verdict. For node instances, stale and resource-breach killing is retired and needs owner acknowledgement: a node's liveness is its pipe, and long jobs are legal (P3). |
| `helper/enablement.py` (312) | Replace | Node-RED node and flow disable | Built into the editor. |
| `helper/environments.py` (252) | Port | `adapters/process/env-builder.ts` | Build in staging, then swap. |
| `helper/heartbeat.py` (721) | Port the MCP heartbeat, delete the socket | `adapters/anytype/mcp-heartbeat.ts` (services) | **The owner's plan 0010 ruling: *"mcp can promise a heartbeat -> make it so"*.** The MCP child is pinged over MCP at the declared interval (30 s), and a beat is recorded only for an answered ping (`host.py:331`). The heartbeat socket to the helper is gone. |
| `helper/launcher.py` (2,580) | Split: port, replace, delete | shell | Kept: single instance and bring-forward (`launcher.py:444`, `657`), quit with "a clear way to turn it off", closing is not quitting (`window.py:65-67`), Anytype start/adopt/quit-if-ours (`launcher.py:894`, `706`), launch at login rule (`launcher.py:1450`), endpoint observation (`launcher.py:1662`). Deleted: host relaunch and the helper/host split. |
| `helper/linux.py` (338) | Port / replace | `adapters/electron/login-item-linux.ts` | Linux autostart `.desktop` (`linux.py:249`); Electron has no Linux login item. Notifications go through Electron, and electron-builder writes the desktop entry. |
| `helper/macos.py` (265) | Replace | `app.setLoginItemSettings` | WI-25 removes the old LaunchAgent (`macos.py:72-89`). |
| `helper/minisign.py` (275) | Port | `adapters/signature/minisign.ts` | Both algorithms (`minisign.py:72-73`). |
| `helper/notification.py` (637) | Port domain, replace delivery | `domain/notices`, Electron `Notification` | The once-only rule and notice file (`notification.py:526`, `602`). |
| `helper/plugin_lists.py`, `plugins.py` (852) | Replace | `ui/pages/packages` over `AppApi` | |
| `helper/processes.py` (574) | Delete | none | Nothing signals a PID read from a file any more; processes are signalled only through a live handle. |
| `helper/restart.py` (319) | Port the policy, delete the channel | `domain/supervision/backoff.ts` | |
| `helper/rollout.py` (675) | Port, reshaped | `application/update-package.ts` | Build elsewhere, restart only the runtime, and swap back if the new version's instances do not report `ready`. |
| `helper/settings_watch.py` (199) | Delete | none | A config change is a deploy, and Node-RED restarts that node. |
| `helper/supervision.py` (903) | Delete | none | The tick is replaced by event-driven supervisors. |
| `helper/swap.py` (1,346) | Replace | electron-updater (install at quit) | Rollback after an unhealthy start is retired and needs owner acknowledgement. |
| `helper/telemetry.py` (1,426) | Port | shell `adapters/telemetry/*` | The consent-first design is kept whole (WI-22). |
| `helper/toolkit.py` (1,738) | Delete | none | Toga. |
| `helper/update.py` (769) | Replace | electron-updater with the GitHub provider, plus a minisign check | The own release index (`update.py:111`) is retired. |
| `helper/versions.py` (1,542) | Port, reshaped | `domain/packages/versions.ts` | Includes plan 0013's missing rule for path installs. |
| `helper/watch.py` (244) | Delete | none | |
| `helper/window.py` (3,007) | Replace | shell windows plus `ui/` | Rules ported: no tray icon (F4), closing is not quitting. |
| `helper/windows.py` (605) | Replace | electron-builder NSIS (shortcuts, AppUserModelId), Electron toasts | The swap handoff is deleted. Proofs are BLOCKED (WI-30). |

Other files:
- `tool_surface.json` and the icons move to `app/`.
- `tools/make_icon.py` stays as a dev tool.
- `docs/anytype-mcp-connection.md` is rewritten for the new app, with the same URL and token.
- `pyproject.toml` and `uv.lock` shrink at cutover to the repository tooling only. The SDK has its own.

---

## 4. Anytype: a core service, and nodes

### 4.1 The core service (the `services` process)

It keeps every plan 0002/0007/0008/0015 behaviour. Only its language and host process change.

1. **Key.**
   - Canonical owner-only file `~/.config/innytypes/anytype_api_key` (`addons/secrets.py:93`,
     `108-109`), with a read-only fallback to the legacy path (`config.py:48`).
   - Pairing runs from the Settings page: "Pair with Anytype", enter the four-digit code
     (`keys.py:109-160`). A new key writes only the canonical file.
   - The key stays in the file on purpose, for three reasons:
     - existing users keep their key with no re-pairing;
     - spec 11.1 already allows first-party nodes to read it at run time;
     - Electron's keychain API (`safeStorage`) exists only in the main process, which would force
       every reader through the shell.
   - Moving it into the keychain is a later change that needs no protocol change (§4.2, last
     bullet).
2. **The MCP child.**
   - Started only after the health gate passes.
   - Spawned once with the bundled `node` and the pinned `@anyproto/anytype-mcp` from the app
     archive.
   - Its stdout is the MCP stream. Its stderr is drained into the one log at WARNING, attributed to
     its pid (plan 0015).
   - The MCP handshake runs, and `tools/list` must match `tool_surface.json` exactly before anything
     is served.
   - A dead child fails every pending call with an MCP error and never retries it.
   - It restarts under the domain backoff and breaker; after N exits in the window it stops and a
     notice says so.
3. **The gateway.**
   - Streamable HTTP at `http://<host>:<port>/mcp`, numeric loopback only.
   - Bearer token from `~/.config/innytypes/mcp_proxy_token` (`gateway.py:64`). The **same file** is
     kept, so Codex configurations keep working after the cutover.
   - Checked before the body is parsed: bearer, then Host and Origin.
   - Limits: 1 MiB body, 8 concurrent requests, 15 s per read, 30 s per request. `GET` answers
     `"GET not supported"` (`gateway.py:45-63`).
   - A port collision degrades with the address named.
4. **The endpoint setting (plan 0008).**
   - Stored in settings, and the stored value wins. `INNYTYPES_MCP_HOST`/`PORT` are only the default
     for a machine never configured, and when both exist the panel says the variable is ignored.
   - Edited on the Settings page. Non-loopback addresses are refused there.
   - Moved live: the new port is bound **before** the old one is closed. A failed bind keeps the old
     endpoint serving.
   - The page shows "served" against "saved" and warns that clients must be updated.
5. **Independent of the runtime.**
   - Node-type changes restart only the runtime, so the endpoint stays up.
   - The services process is supervised by the shell like the runtime, with its own backoff and
     breaker.
   - It stops only on quit.
6. **Anytype desktop app** (shell, WI-21): started if not running, adopted if it is, and quit on
   Quit **only** if InnyTypes started it (`launcher.py:706`, `894`).

### 4.2 Anytype on the canvas: the `packages/anytype` node package

- **First-party TS package.** It is bundled with esbuild, run with `{node}`, and ships inside the
  app, verified at build time.
- It uses the **same** `api-client.ts` as the service, bundled in.

| Type | Kind | Config (JSON Schema) | Output port → event |
|---|---|---|---|
| Create object | node | `space_id`, `type_key` (default `page`), `name_field` and `body_field` (JSON pointers into the payload, with static defaults), `api_base_url` | `created` → `anytype.object.created.v1` `{space_id, object_id, name, link}` |
| Update object | node | `space_id`, `object_id_field` (default `/object_id`), `properties` (array of `{key, value_field}`) | `updated` → `anytype.object.updated.v1` |
| Read object | node | `space_id`, `object_id_field` | `object` → `anytype.object.read.v1` |
| Read space | node | `space_id`, `type_filter`, `limit` | `objects` → `anytype.space.read.v1` |
| Search | node | `space_id` (optional), `query` or `query_field`, `types`, `limit` | `results` → `anytype.search.results.v1` |

How the key stays out of flows and logs:
- It is **not** a config property or a credential, so it is never in `flows.json`,
  `flows_cred.json`, a start frame, the journal or a snapshot.
- The process reads the canonical key file at run time, through the SDK helper `anytypeKey()`
  (spec 11.1, proven by the spike: `packages/anytype/create_object.py:20-28`, 0 hits in 845 files).
- The runtime reads the same file at start (over the channel from services) and registers the
  value with its redactor. A node that prints the key to stderr is redacted anyway.
- A 401 fails the input with "Anytype refused the key; pair again in Settings" and raises a
  once-only notice. The key is never echoed.
- A conformance-style test uses a canary key and checks that it appears in no stdout (outside
  `start`), stderr, log, journal, flow file or snapshot.
- **Later hardening, not in this plan:** a node→runtime service-call frame so the key never enters
  any node process. It is additive under spec §1.3 (a new frame that receivers MAY ignore).

**Deviation from the brief:** Anytype nodes live in **this** repo, not their own. They depend on the
core service contract and the shared client, and they ship inside the app. The slice 05 handoff (§9)
therefore covers only monty and innyrize.

---

## 5. The parity ledger (slice 04)

### 5.1 Files

- `docs/parity/old-tests.txt`: the frozen list of 2,638 old node ids. Its sha256 is recorded in the
  ledger's header comment.
- `docs/parity/ledger.csv`: RFC 4180 CSV, UTF-8, one row per old id, sorted by `old_id`. Columns:

| Column | Content |
|---|---|
| `old_id` | The pytest node id, exactly as collected, including parameters (`tests/test_x.py::test_y[case]`). |
| `old_file` | `tests/test_x.py` |
| `behaviour` | One plain sentence: the test's docstring first line, or its name turned into words, edited by the person deciding. |
| `fate` | `undecided` \| `ported` \| `replaced` \| `retired` |
| `new_ids` | `;`-separated. `vitest:<file>::<full name>`, `playwright:<file>::<title path>`, `pytest-sdk:<node id>`, `proof:<proof_id>` |
| `reason_code` | Required for `replaced` and `retired`. One of: `toga-ui`, `node-config-replaces-plugin-settings`, `helper-host-split-gone`, `pid-file-signalling-gone`, `event-bus-replaced-by-wires`, `briefcase-packaging`, `python-internal`, `cli-removed`, `electron-builtin`, `node-red-builtin`, `owner-retired-behaviour` |
| `reason` | Free text: why. |
| `owner_ack` | `yes` or empty. **Required** for `owner-retired-behaviour`, for any `retired` row whose behaviour a person can see, and for every row the verifier flags as user-visible. |
| `wi` | The work item that decided it. The seeder pre-fills it from the file map below. |

- `docs/parity/proofs.csv`, for machine proofs:
  - columns `proof_id, behaviour, os, arch, status (todo|pass|fail|blocked), app_version, commit,
    date, script, evidence`;
  - evidence goes under `docs/parity/evidence/<os>-<arch>/<proof_id>/` (a redacted log excerpt,
    screenshots, and the script output).

### 5.2 Seeding (WI-02)

- `tools/parity/seed_ledger.py` runs
  `uv run --no-sync pytest --collect-only -q --no-cov -o addopts=""`. The repository's `addopts`
  sets `-q` and coverage, so it must be overridden to get plain ids. It writes `old-tests.txt`.
- It builds one `undecided` row per id. The `behaviour` comes from the test function's AST
  docstring. `wi` comes from this map:

| WI | Old test files it decides |
|---|---|
| 01 | package, contract_layer, home_guard |
| 03 | control_channel, helper_restart, helper_breaker, helper_tick, helper_detection, helper_heartbeat, helper_process_identity, helper_launcher (lock, quit, closing) |
| 04 | logging |
| 05 | host_children, addon_runner, event_bus, event_emitter, event_transport |
| 06 | no_secrets, plugin_secrets |
| 08 | addon_discovery, addon_resolution |
| 09 | addon_manifest, addon_settings, addon_settings_runtime, settings_form, settings_store, table_declaration, table_form, table_store |
| 11 | application_window, toolkit_desktop, window_wiring, tab_model, application_tab, plugin_tab, table_drawing, plugin_page, plugin_lists |
| 14 | plugin_catalogue |
| 15 | plugin_environments |
| 16 | addons_cli, addons_remove, enable_switch |
| 17 | plugin_version_check, plugin_update_apply |
| 18 | anytype_client, anytype_mcp_config, _health, _keys, _session, _supervisor, _tool_surface, pinning, mcp_child_identity, mcp_host_integration |
| 19 | anytype_mcp_gateway, independent_client_connection |
| 21 | macos, linux_support, helper_notification, helper_windows, helper_launcher (the rest) |
| 22 | helper_telemetry |
| 23 | bundle |
| 24 | helper_core_update, helper_update_check |
| 25 | helper_config |

- `--check-old` re-collects the ids and fails if any id is not in `old-tests.txt`, or any listed id
  is no longer collected. It runs in the gate until the cutover, so a new old-app test or a renamed
  one cannot slip past the ledger.

### 5.3 Enforcement: `tools/parity/check.ts`, a gate stage

- **The row set is exact.** The `old_id`s equal `old-tests.txt`, whose sha256 matches the header.
  There are no duplicates.
- **Every field is legal.** `fate` is in the set. `replaced` and `retired` rows have a `reason_code`
  from the list and a non-empty `reason`. Rows that need `owner_ack` have `yes`.
- **Ported ids really passed in this run.**
  - The gate runs vitest with `--reporter=json --outputFile=.gate/vitest.json`, Playwright with the
    JSON reporter, and the SDK pytest with `--junitxml`.
  - Every `vitest:`, `playwright:` and `pytest-sdk:` id in `new_ids` must appear there with status
    **passed**.
  - Skipped, todo and missing ids fail the check.
- **Proofs.** A `proof:` id must exist in `proofs.csv`. It does not have to pass in the normal mode.
- **Two modes.**
  - Normal (every gate run): `undecided` is allowed, and the check prints the count per WI.
  - `--final` (WI-27 onward, and the cutover gate): no `undecided`, and every `proof:` referenced
    must be `pass` on every required target: macos-arm64, macos-x64, linux-arm64, linux-x64,
    windows-x64.
- **Each WI's acceptance** says "no `undecided` row with `wi` = this item", and the checker enforces
  it with `--wi WI-0018-NN`.

### 5.4 Machine proofs per OS

These are scripted where a script can do it (`tools/proofs/*.ts`, Playwright `_electron` against the
**packaged** app with a fresh userData). They are recorded by hand, with evidence, where it cannot
(a real logout and login, a real update).

| Proof | What is shown |
|---|---|
| `mcp-supervised` | kill -9 of the MCP child → restarted; tools served only after a fresh handshake; breaker stops after N |
| `endpoint-moved` | move 31010 → another port while a Codex-like client runs; old closes only after new binds; collision refused and old kept |
| `codex-smoke` | real Codex, started separately, lists and calls a tool; one MCP child in the process tree (plan 0007's outstanding manual check) |
| `refusal-notices` | no key, Anytype not running, port taken, non-loopback address: each shows its notice once |
| `log` | the log file at the documented path; lines from shell, runtime, services, a node and the MCP child; canary secrets redacted; rotation |
| `login` | launch at login on → logout/login starts the app; off → does not; OS refusal leaves the setting unchanged |
| `update` | vN → vN+1 from a GitHub Releases test channel; a tampered `latest-*.yml` refused by minisign |
| `quit` | Quit leaves no process; kill -9 of the shell leaves none; closing the window does not quit |
| `real-flow` | the P2 flow on real Anytype, with retry (P4), crash recovery (P11d) and a pop-out (P10) |
| `hot-add` | install a signed package while running; its type appears without an app relaunch; a tampered one is refused |

---

## 6. The gate

`docs/loop/verify.sh` stays the single command the loop runs. It gains an `== app ==` section after
the Python stages and still prints `gate: GREEN` only when everything passed. At the cutover the
Python host stages are deleted and the SDK stages remain.

| Stage | Command (`npm run gate:*` from the root) | Fails when |
|---|---|---|
| install | `npm ci` | the lockfile disagrees with the manifests. The Electron binary comes from its cache; offline with no cache fails with a clear message. |
| types | `tsc -b` | any type error |
| lint | `eslint .` + `prettier --check .` | any finding |
| architecture | `depcruise app/src` | any layer-rule violation (§2.3), a file over 600 lines, or `process.env` outside a composition root |
| licences | `license-checker --onlyAllow` (OSI list) over production dependencies | a non-OSI licence |
| unit + integration | `vitest run --project unit --project integration --coverage` | a failure. Thresholds: `domain/**` and `application/**` 95% lines, 90% branches; everything else 85 / 80; global 90 / 85. |
| conformance | `vitest run --project conformance` | any of spec C1–C15 fails for the runtime codec against: the Python SDK reference node, the TS SDK reference node, and a raw executable node that uses no SDK. Frame shapes are validated by ajv against the spec's §4.5 schemas, extracted to `docs/specs/node-protocol-v2.schema.json`. |
| e2e | `playwright test` (dev build, hidden windows, temp userData) | a failure. Machine-only specs are tagged `@machine` and excluded. |
| SDK (Python) | in `sdk/python`: `uv sync --frozen`, `ruff check`, `ruff format --check`, `mypy --strict`, `pytest --cov --cov-fail-under=90` | any |
| key-leak scan | `tools/leakscan.ts` | any canary value is found, in bytes, in the e2e userData dirs, logs, SQLite journal, `flows.json`, **plaintext** in `flows_cred.json`, snapshots, the telemetry queue, crash dumps, the working tree or `git log -p` (test fixtures that define canaries are allow-listed by path). Canaries are the Anytype key, the proxy token and a node credential. The real-key scan (the spike's `tools/key_leak_scan.py`, ported) runs in machine proofs, never in the gate, so the gate stays hermetic. |
| parity | `tools/parity/check.ts` (normal mode; `--final` from WI-27 on) | §5.3 |

---

## 7. Spike findings carried into slice 03

| Finding (arch_pivot) | Spike evidence | Work item |
|---|---|---|
| Deploy guard via the documented API, against installed **verified** packages | `runtime/child.js:352-362`; report §2 correction | WI-08 |
| Journal on SQLite / append-only, bounded reported queue | whole-file rewrite on every change, `runtime/hub.js:57-62`; no bound (§3 table) | WI-07 |
| ajv validation of config, forms and payloads | 4-type check `runtime/eventTypes.js:135`; `formRow` has no arrays or nesting, `runtime/generate.js:57-81` | WI-09, WI-13 |
| Credential secret in the OS keychain | random file `runtime/child.js:48-52` | WI-06 |
| Crash-loop limit (windowed) with UI | shell restarts forever, `main.js:163-170`; node gives up after 5 with no window, `runtime/runtime.js:152-156` | WI-03 (runtime, services), WI-05 (nodes) |
| App pages served by the shell; app API over the channel | the page served by the runtime blanks during restarts (P11 §5.6) | WI-11 |
| Editor-sync fallback: reload if clean, prompt if dirty | `runtime/child.js:322-332` (borderline public) | WI-12 |
| Quit decision owned by the shell (ask about undeployed edits) | edits silently discarded, `main.js:307-310` | WI-12 |
| Signing, notarising, per-arch builds | `package.json` build `identity: null`, arm64 only | WI-23, WI-24 |
| Per-package environment | one shared Python (`realDir`/`PYTHONPATH`, `runtime/runtime.js:93-104`) | WI-15 |
| Verified hot-add; watched folder not writable by node processes | unverified `fs.watch` of `userDir/packages`, `runtime/child.js:144-152` | WI-16 |
| One runtime-level replay listener | per-instance `flows:started` listener, `runtime/runtime.js:74` (MaxListeners warning) | WI-07 |
| Internal replay marker kept out of Catch/Complete | `_innyReplay`, `runtime/runtime.js:244`, `366` | WI-07 |
| Remove npm from the bundle | `@node-red/registry` → `npm@11.19.1` | WI-23 |
| Refuse deleting a type used by **undeployed** edits | P11b "what is NOT handled" | WI-13 |
| Typed channel errors (`restarting`, `down`, `timeout`, `stopped`) | text-only results, `main.js:183-193` | WI-03 |
| Minimal child environment (not the whole `process.env`) | `env: {...process.env}`, `runtime/runtime.js:99`, `main.js:77` | WI-05 |
| Windows: Job Objects, `python.exe` path, `realDir` separators, SIGKILL emulation | report P8 "likely issues" | WI-30 (BLOCKED) |

---

## 8. Work items

### 8.1 Table

Sizes: S is up to a day of loop cycles, M a few, L must be split, and the split is given.

| # | Id | Title | Slice | Size | Depends on |
|---|---|---|---|---|---|
| 01 | WI-0018-01-workspace-and-gate | Workspace, toolchain and the app gate | 03 | M | none |
| 02 | WI-0018-02-parity-ledger | Seed the parity ledger and enforce it | 04 | M | 01 |
| 03 | WI-0018-03-shell-and-supervisor | Shell, typed channel and process supervision | 03 | M | 01 |
| 04 | WI-0018-04-one-log | One log with redaction | 03 | M | 03 |
| 05 | WI-0018-05-node-processes-on-protocol-v2 | Node processes speaking protocol v2 | 03 | M | 01 |
| 06 | WI-0018-06-secret-store | Secret store and the keychain-held credential secret | 03 | S | 03 |
| 07 | WI-0018-07-journal | The journal on SQLite with a bounded queue | 03 | M | 05 |
| 08 | WI-0018-08-node-red-embedded-and-guarded | Node-RED embedded, locked and guarded | 03 | M | 03, 04, 07 |
| 09 | WI-0018-09-generated-types-and-forms | Generated node types and schema forms | 03 | M | 08 |
| 10 | WI-0018-10-views-in-the-runtime | Action and snapshot views in the runtime | 03 | M | 09 |
| 11 | WI-0018-11-app-pages-inbox-and-popouts | App pages, Inbox and pop-outs from the shell | 03 | M | 10 |
| 12 | WI-0018-12-editor-sync-and-quit | Editor sync fallback and the quit decision | 03 | S | 11 |
| 13 | WI-0018-13-created-event-types | Event types created in the app | 03 | M | 12 |
| 14 | WI-0018-14-signatures-and-catalogue | Minisign and the signed package catalogue | 03 | M | 01 |
| 15 | WI-0018-15-package-environments | One verified environment per package | 03 | M | 09, 14 |
| 16 | WI-0018-16-package-install-remove-hot-add | Install, remove and verified hot-add | 03 | M | 11, 15 |
| 17 | WI-0018-17-package-updates | Package version check and update | 03 | M | 16 |
| 18 | WI-0018-18-anytype-core-service | The Anytype core service and MCP child | 03 | M | 03, 04, 06 |
| 19 | WI-0018-19-mcp-gateway-and-endpoint | The loopback MCP endpoint and moving it live | 03 | M | 18 |
| 20 | WI-0018-20-anytype-nodes | Anytype node types | 03 | M | 05, 09, 18 |
| 21 | WI-0018-21-desktop-integration | Launch at login, notifications, Anytype app, window rules | 03 | M | 03, 04 |
| 22 | WI-0018-22-telemetry | Consent-first telemetry | 03 | M | 04, 06, 11 |
| 23 | WI-0018-23-packaging | Per-arch packages with bundled runtimes, without npm | 03 | M | 16, 20 |
| 24 | WI-0018-24-signing-and-updates | Signing, notarising and verified updates | 03 | M | 23 |
| 25 | WI-0018-25-migration-and-first-run | Migrating an old installation | 03 | M | 06, 19, 21, 22 |
| 26 | WI-0018-26-node-sdks-for-authors | Node SDKs and the packaging tool for authors | 05 | M | 05, 16 |
| 27 | WI-0018-27-ledger-complete | Every ledger row decided | 04 | M | 01–26 |
| 28 | WI-0018-28-proofs-macos | Machine proofs on macOS | 04 | M | 24, 25, 27 |
| 29 | WI-0018-29-proofs-linux | Machine proofs on Linux (Multipass) | 04 | M | 23, 27 |
| 30 | WI-0025-01-windows | Windows build, conformance and proofs — moved to plan 0025 | 04 | L | 27 |
| 31 | WI-0018-31-farewell-release | The old app's last release points to the new one | 06 | S | 24 |
| 32 | WI-0026-01-cutover | Delete the old application in one change — moved to plan 0026 | 06 | M | 27, 28, 29, 30, 31 |

### 8.2 Order: never more than two at once

| Wave | Runs | Why these two can run together |
|---|---|---|
| 1 | 01 | Everything needs it. |
| 2 | 02 ∥ 03 | Ledger tooling against shell code: no shared files. |
| 3 | 04 ∥ 05 | Log writer (shell) against node-process adapter (runtime). |
| 4 | 06 ∥ 07 | Shell secrets against the runtime journal. |
| 5 | 08 ∥ 14 | Node-RED embedding against pure signature and catalogue code. |
| 6 | 09 ∥ 18 | Runtime generator against the services process. |
| 7 | 10 ∥ 19 | Views against the gateway. |
| 8 | 11 ∥ 15 | Shell pages against environment builders. |
| 9 | 12 ∥ 20 | Editor sync against the Anytype package. |
| 10 | 13 ∥ 16 | Event types against install. **Shared file:** `runtime/main.ts`. 13 wires first, and 16 rebases, as its last acceptance bullet requires (see the "parallel executors and file exclusivity" lesson). |
| 11 | 17 ∥ 21 | Package updates against desktop integration. |
| 12 | 22 ∥ 23 | Telemetry against packaging. |
| 13 | 24 ∥ 26 | Updater against SDKs. |
| 14 | 25 | Migration touches settings, secrets and the login item: alone. |
| 15 | 27 | The ledger audit: alone. |
| 16 | 28 ∥ 29 | Two machines. |
| 17 | 31 (∥ 30 once unblocked) | |
| 18 | 32 | Needs 30. |

Every item ends with `docs/loop/verify.sh` green. Every item that owns ledger rows ends with
`tools/parity/check.ts --wi <id>` reporting 0 undecided.

**Built but not assembled.** This is the recurring defect in this project. Every runtime or shell
item includes one e2e bullet that drives the behaviour through the real dev app, and one bullet that
the behaviour is reachable from the composition root, not only from a test.

### 8.3 YAML blocks

Every block also carries `canonical_id: '0018'`, `canonical_source: plans` and `status: TODO`,
unless it is marked BLOCKED.

```yaml
- id: WI-0018-01-workspace-and-gate
  title: Workspace, toolchain and the app gate
  intent: "Every later item needs a place to land and a gate that judges it. The layer rules must be enforced from the first commit, because the old app's debts (eight composition roots, hidden default factories, the engine importing Anytype) came from rules that were only conventions."
  acceptance:
    - "The root package.json is an npm workspace (app, sdk/ts, packages/*) and still pins @anyproto/anytype-mcp 1.2.10; tests/test_pinning.py stays green."
    - "app/ builds with tsc -b (strict flags in section 1) and esbuild. A Playwright _electron smoke test opens the shell window and quits with no process left."
    - "dependency-cruiser enforces every rule in section 2.3. A deliberate violation in a fixture fails the stage (break it, watch it fail)."
    - "docs/loop/verify.sh runs the new stages (types, lint, architecture, licences, vitest with the coverage thresholds of section 6, e2e) after the Python stages, and prints gate: GREEN only if all pass."
    - "A vitest setup refuses any test that writes outside a temp directory under the real home, the equivalent of tests/home_guard.py."
    - "Ledger rows with wi = this item (package, contract_layer, home_guard) are decided once WI-02 exists; until then they are listed in the report."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: []
  slice: '03'
  size: M

- id: WI-0018-02-parity-ledger
  title: Seed the parity ledger and enforce it
  intent: "Parity must be proven, not hoped for (plan 0017, cutover step 2). A ledger that the gate does not check becomes a list of intentions, and a ported test that did not run proves nothing."
  acceptance:
    - "tools/parity/seed_ledger.py writes docs/parity/old-tests.txt (2,638 ids today, with its sha256) and ledger.csv with the columns of section 5.1: every row undecided, behaviour from the docstring, wi from the section 5.2 map."
    - "--check-old in the gate fails when an old test is added, renamed or removed without the ledger following."
    - "tools/parity/check.ts implements every rule of section 5.3 in normal and --final modes, and --wi <id>."
    - "Fixture ledgers prove each refusal: a ported id that was skipped, one that does not exist, a retired row with no reason_code, a missing owner_ack, a duplicated row, and an old id that is missing."
    - "docs/parity/proofs.csv exists with every proof of section 5.4 for every target, status todo; Windows rows are blocked."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-01-workspace-and-gate]
  slice: '04'
  size: M

- id: WI-0018-03-shell-and-supervisor
  title: Shell, typed channel and process supervision
  intent: "P11 made the shell and runtime split the target. The spike's channel returns bare texts, its crash restart never stops, and it supervises only one child. The services process needs the same supervision."
  acceptance:
    - "app/src/shell/main.ts is the only composition root of the Electron main process. It takes the single-instance lock and brings the existing window forward on a second launch."
    - "One generic supervisor forks any utilityProcess (runtime, services) with explicit settings (never relying on inherited env, arch_pivot P9 surprise 5), and sends planned stops (types, restart, quit) and crash restarts with backoff 250 ms x n capped at 5 s."
    - "Crash-loop limit: N crashes inside a window (settings, defaults 5 in 2 minutes) stops restarting, sets childState down-for-good, shows an error with a Restart button, and raises one notice. Tested with a fake child that exits at once."
    - "Channel messages are typed and versioned. Every call times out after 5 s. Calls while not running answer at once with code restarting, down, timeout or stopped (spec 10.3)."
    - "The shell picks one free loopback port at launch and gives every runtime generation the same one."
    - "Quit sends stop quit to both children, kills a child still alive after 10 s, and leaves no process. kill -9 of a child and of the shell each leave no orphan (e2e on macOS, using the P11d and P11e method)."
    - "The runtime and services each run the ppid watchdog of spec 6.6."
    - "Ledger rows with wi = this item are decided."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-01-workspace-and-gate]
  slice: '03'
  size: M

- id: WI-0018-04-one-log
  title: One log with redaction
  intent: "Plans 0012, 0014 and 0015 each fixed a process whose words reached nobody. The new app has more processes (shell, runtime, services, node processes, the MCP child), so one writer and one redaction rule must exist from the start."
  acceptance:
    - "The shell is the only writer, at the old path (platformdirs user_log_dir innytypes, innytypes.log), with 2 MiB x 3 rotation and INNYTYPES_LOG_FILE and INNYTYPES_LOG_LEVEL honoured (logs.py:161-196)."
    - "The runtime and services write JSON log records to their stdout pipe. The shell parses, redacts and appends them; lines written just before a kill -9 of a child are in the file."
    - "Node stderr lines appear at level STDERR tagged with type and instance (spec 3.4). Non-frame stdout appears at level stdout. Node-RED's own log is routed through a logging handler."
    - "Redaction happens at the source and again in the shell. The secret registry includes node credentials, the Anytype key and the proxy token. Canary values printed by each process never reach the file."
    - "Ledger rows with wi = this item are decided."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-03-shell-and-supervisor]
  slice: '03'
  size: M

- id: WI-0018-05-node-processes-on-protocol-v2
  title: Node processes speaking protocol v2
  intent: "Every source, node and view runs as its own process (plan 0017 architecture 3). The runtime side of the conversation must be exactly the spec, checked by the conformance suite, not by what the spike happened to do."
  acceptance:
    - "The frame codec validates with ajv against docs/specs/node-protocol-v2.schema.json, extracted from spec 4.5. Oversize frames (over 1 MiB) are discarded, and a frame carrying an input id fails that input with frame too large."
    - "adapters/process/node-process.ts: spawn with a minimal environment (not the whole process.env), cwd {package}, placeholders {python} {node} {package}, start frame, ready deadline 30 s, close then closed then exit, SIGKILL after 5 s, EOF means close."
    - "POSIX node processes run in their own process group, and close or crash ends the group, so grandchildren are not orphaned. Windows Job Objects are a stub marked BLOCKED for WI-30."
    - "Identity binding: an undeclared port or an unknown in is refused and logged. The runtime stamps the envelope fields."
    - "Unexpected exit: sent inputs fail with done(err), awaiting ones are kept, respawn after 1 s, and the domain breaker stops respawning after N exits in a window, with a red status and a notice."
    - "Conformance C1, C2, C4 to C9 and C13 pass against a raw executable fixture node that uses no SDK (a Python script with only the standard library)."
    - "Ledger rows with wi = this item are decided."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-01-workspace-and-gate]
  slice: '03'
  size: M

- id: WI-0018-06-secret-store
  title: Secret store and the keychain-held credential secret
  intent: "The spike kept Node-RED's credential secret in a plain file (runtime/child.js:48-52). The Anytype key and proxy token must stay at their existing paths so that nothing breaks for existing users."
  acceptance:
    - "The SecretStore port has two adapters: a keychain adapter (Electron safeStorage, main process only) and an owner-only file adapter (0600 file in a 0700 directory, as in addons/secrets.py:93-109)."
    - "Node-RED's credential secret is generated once, kept by the keychain adapter, and handed to the runtime in init. It is never written unencrypted."
    - "On Linux without a keyring (safeStorage backend basic_text), the file adapter is used, and the Settings page and the log say so once."
    - "The Anytype key (canonical path plus read-only legacy fallback) and mcp_proxy_token are read and written only through the file adapter at their existing paths."
    - "Ledger rows with wi = this item (no_secrets, plugin_secrets) are decided."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-03-shell-and-supervisor]
  slice: '03'
  size: S

- id: WI-0018-07-journal
  title: The journal on SQLite with a bounded queue
  intent: "The spike rewrites one JSON file on every change (hub.js:57-62) and has no queue bound. Retry-the-step is the owner's rule, so the journal is the correctness core of the runtime."
  acceptance:
    - "First: node:sqlite loads inside a utilityProcess of a packaged dev build. If it does not, the adapter is better-sqlite3, and the report says which was used."
    - "JournalStore: journal before send (spec 7.1), clear on done or error, WAL, fsync on the entry write, and a journal that survives kill -9 at any point (a property test kills a worker at random points)."
    - "Retry rules of spec 7.3 in domain/journal: planned (types or redeploy) not counted, with plannedBy recorded; crash counted; quit counted; maximum 2; awaiting never counted."
    - "One runtime-level replay after flows:started, not a listener per instance. With 50 instances there is no MaxListeners warning."
    - "Replayed messages carry no internal marker: Catch and Complete receive payload, topic, inny and _msgid only."
    - "Bounded queue per instance (setting; default 64), with a hold-or-fail policy setting, shown on the Jobs page and in the log. Never silently dropped."
    - "Conformance C14 and the journal parts of C15 pass."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-05-node-processes-on-protocol-v2]
  slice: '03'
  size: M

- id: WI-0018-08-node-red-embedded-and-guarded
  title: Node-RED embedded, locked and guarded
  intent: "One deploy naming an uninstalled type stops the whole runtime (arch_pivot P7). The palette must hold only InnyTypes types (D1)."
  acceptance:
    - "app/src/runtime/main.ts is the runtime's only composition root. It embeds Node-RED 5.0.7 with RED.init on its own server, admin at /red, bound to 127.0.0.1."
    - "Palette lock of spec 11.4 and core nodes of 11.5. nodesExcludes is computed from Node-RED's own core folders. POST /red/nodes install, URL and upload answer 404; a module planted in userDir/node_modules is not loaded."
    - "Deploy guard via RED.runtime.nodes.getNodeList: refuses unknown types, and also types whose package is not in the verified package store, with the spec 11.3 answer. A flow with function, exec and template is refused, and every running instance keeps its pid."
    - "The guard refuses admin requests whose Host header is not the loopback address and port. No token is added, as the owner ruled."
    - "RED.stop plus RED.start in one process is never called; a lint rule forbids it (arch_pivot P9 surprise 1)."
    - "Ledger rows with wi = this item (addon_discovery, addon_resolution) are decided."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-03-shell-and-supervisor, WI-0018-04-one-log, WI-0018-07-journal]
  slice: '03'
  size: M

- id: WI-0018-09-generated-types-and-forms
  title: Generated node types and schema forms
  intent: "Each declared type must be its own palette entry with its own ports and a form generated from its schema (P1). monty's volumes need arrays of objects, the plan 0005 table."
  acceptance:
    - "Declarations are parsed and refused by ajv against the spec 2.6 schema. Refusals name the field. A protocol other than 2 is refused with the version named."
    - "The generator writes one module per type: category by kind, icon, output labels, one port per event, action ports after pass-through ports, and credentials for writeOnly or x-secret properties."
    - "The form model supports string, number, integer, boolean, enum, nested objects and arrays of objects (add, remove, reorder rows), with required fields marked. It validates with ajv in the editor before deploy and again in the runtime before start."
    - "Coercion from the schema (Node-RED returns strings) is covered by property tests."
    - "e2e: a fixture package with every control type deploys, and its start frame carries the coerced, validated config."
    - "Ledger rows with wi = this item are decided (the settings and table tests become form-model tests, or are retired with reason node-config-replaces-plugin-settings)."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-08-node-red-embedded-and-guarded]
  slice: '03'
  size: M

- id: WI-0018-10-views-in-the-runtime
  title: Action and snapshot views in the runtime
  intent: "Views are the departure from Node-RED's node-only model (plan 0017 Views): a flow that waits for days, snapshots whose actions start new runs, and presses never silently dropped."
  acceptance:
    - "present marks awaiting and raises present, with first computed from the journal, and a pending count (spec 8.1)."
    - "Submission and dismissal (__dismiss__ becomes an error that reaches Catch). A snapshot is stored with the type's actions and the instance id."
    - "Disabled actions give their reason (node deleted; port unwired) and a press is answered with 409 and that reason (spec 8.4)."
    - "The optional action-view timeout output fires after its configured duration, surviving restarts (the deadline is journaled)."
    - "trigger starts a fresh run on the action port. It is traceable by msg.inny.run."
    - "Conformance C10 and C11 pass against the Python SDK and the TS SDK reference nodes."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-09-generated-types-and-forms]
  slice: '03'
  size: M

- id: WI-0018-11-app-pages-inbox-and-popouts
  title: App pages, Inbox and pop-outs from the shell
  intent: "The app page served by the runtime blanks during every restart (P11 section 5.6). The UI will be redesigned by the owner, so it must sit behind one contract."
  acceptance:
    - "ui/contract.ts defines AppApi. The preload exposes only window.inny.app. Contract tests cover every method without a DOM."
    - "Pages Inbox, Snapshots, Events, Jobs, Packages and Settings are served by the shell on inny-app://, with the editor in an iframe to the runtime's /red. The pages keep working (showing childState) while the runtime is down."
    - "The app API travels over the channel, not HTTP. Spec section 10 is amended accordingly in docs/specs/node-protocol-v2.md."
    - "Inbox badge, notification on first presentation, cancel from Jobs."
    - "Pop-outs on inny-view:// in partition inny-views, with the webPreferences, CSP and id-less three-call bridge of shell/popouts.js:19-38 and 134-143. Every probe of arch_pivot P10f passes as an e2e test. Window placement is remembered per view type. Restart re-presents quietly."
    - "The generic view renderer draws text, table, form, media and Anytype link content. A fixture third-party web component runs sandboxed on inny-view://<package>/ under the same CSP."
    - "Ledger rows with wi = this item are decided (Toga window and tab tests are retired with reason toga-ui, or ported where a rule survives: no tray icon, closing is not quitting)."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-10-views-in-the-runtime]
  slice: '03'
  size: M

- id: WI-0018-12-editor-sync-and-quit
  title: Editor sync fallback and the quit decision
  intent: "Palette sync depends on Node-RED's undocumented runtime-event convention (P11 section 4). The editor's unload guard silently cancels quit in Electron (arch_pivot section 4, surprise 1)."
  acceptance:
    - "After each runtime generation the page compares node sets (not definitions, P11 surprise 2) and requests node/added and node/removed until the palette matches."
    - "Fallback: if the palette has not matched 10 s after the runtime is ready, a clean editor reloads automatically and a dirty one shows a prompt. Tested by disabling the runtime-event path."
    - "A contract test pins the runtime-event shape to Node-RED 5.0.7, so an upgrade that changes it fails the gate."
    - "Quit with undeployed edits asks: Deploy and quit, Quit and discard, or Cancel. Quit always calls RED.stop. will-prevent-unload never silently blocks quit."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-11-app-pages-inbox-and-popouts]
  slice: '03'
  size: S

- id: WI-0018-13-created-event-types
  title: Event types created in the app
  intent: "P9 proved people can create event types. Deleting one while an undeployed edit uses it loses intent (P11b)."
  acceptance:
    - "Event types are stored in EventTypeStore, versions are immutable, and a schema change makes .vN+1. An unchanged schema is refused. The synthetic user-events package is regenerated."
    - "The field editor produces JSON Schema 2020-12 including enums and nested objects, and ajv validates fire payloads and source inputs."
    - "Deletion is refused while deployed flows OR the open editor's undeployed nodes use the type (the page reports its node types). Each refusal names the nodes."
    - "Create, version and delete each restart only the runtime child. The canvas keeps its edits (e2e, as P11a and P11b)."
    - "Fire from the Events page and from a snapshot action (source input: true) both start a new run."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-12-editor-sync-and-quit]
  slice: '03'
  size: M

- id: WI-0018-14-signatures-and-catalogue
  title: Minisign and the signed package catalogue
  intent: "Node packages come from third parties and run as the person's user. The rule from plan 0003 D10 stands: trust the signature, never the server."
  acceptance:
    - "minisign verification in TS with node:crypto for both algorithms (minisign.py:72-73). The old test vectors are ported; a wrong key, a wrong signature, a tampered file and a tampered trusted comment are each refused."
    - "The signed catalogue (catalogue.py format 1): parse, bounds (1 MiB), cache, sources from settings, and any publisher can be a source (plan 0006 F1)."
    - "Ledger rows with wi = this item are decided."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-01-workspace-and-gate]
  slice: '03'
  size: M

- id: WI-0018-15-package-environments
  title: One verified environment per package
  intent: "The spike ran every package on one shared Python (spec 2.3 UNPROVEN). The owner requires verified, isolated environments."
  acceptance:
    - "Package archive: a .tgz with inny-package.json, files.json (sha256 of every file) and a .minisig. Signature, then per-file hashes, then a recorded content hash."
    - "uv-python: uv venv with the bundled Python, then uv pip sync --require-hashes from the package's hash-locked requirements, built in staging and swapped in. Other Python versions are refused with a reason."
    - "node: the package must ship pre-bundled JS; nothing runs npm. executable: per-platform binaries with sha256 in the declaration."
    - "Plan 0013: a package whose content hash differs from the one recorded for the same version is refused and reported. A path install is compared by content hash."
    - "Ledger rows with wi = this item are decided."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-09-generated-types-and-forms, WI-0018-14-signatures-and-catalogue]
  slice: '03'
  size: M

- id: WI-0018-16-package-install-remove-hot-add
  title: Install, remove and verified hot-add
  intent: "A package reaches the watched folder only after verification (spec 11.4). A running app gains its types by restarting only the runtime."
  acceptance:
    - "Packages page: install from the catalogue, and from file for developers (unsigned packages need an explicit confirmation and are marked unsigned wherever they are listed)."
    - "The declaration is written to the package folder only after verification. That folder is not writable by node processes (checked: a node fixture's write attempt fails), and install restarts only the runtime (P11a timing logged)."
    - "Removal is refused while deployed or undeployed flows use its types. Otherwise it stops them and takes the environment, records and generated modules."
    - "Enable and disable are Node-RED's own; the old enable-switch rows are retired as node-red-builtin."
    - "Wiring rebased on WI-13's runtime/main.ts. Both features are reachable from the composition root (e2e)."
    - "Ledger rows with wi = this item are decided."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-11-app-pages-inbox-and-popouts, WI-0018-15-package-environments]
  slice: '03'
  size: M
```

```yaml
- id: WI-0018-17-package-updates
  title: Package version check and update
  intent: "Plan 0013: a version moved and nothing said so. Updates must be visible, and a failed update must put the old version back."
  acceptance:
    - "The version check against the catalogue, and against the content hash for path installs, shows update available on the Packages page and in one notice."
    - "The modes auto, manual and pinned are read from settings (imported by WI-25)."
    - "Apply: build in staging, planned runtime restart. If an instance of an updated type does not send ready within 30 s, swap back, restart again, and give a notice naming the package and reason."
    - "Ledger rows with wi = this item are decided (group rollout rows are retired with reason event-bus-replaced-by-wires where no inter-package dependency exists any more)."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-16-package-install-remove-hot-add]
  slice: '03'
  size: M

- id: WI-0018-18-anytype-core-service
  title: The Anytype core service and MCP child
  intent: "Anytype is the reason the app exists. Its service must survive every node-type restart, and must keep plans 0002, 0007 and 0015 working."
  acceptance:
    - "app/src/services/main.ts is the only composition root of the services utilityProcess, supervised by WI-03's supervisor."
    - "The API client and health gate are ported. The key is read from the canonical file with the read-only legacy fallback. Pairing (challenge, four-digit code, store 0600) is driven from the Settings page."
    - "The MCP child is spawned with the bundled node and the pinned package (no npx). Handshake, then tools/list must match tool_surface.json exactly, or a named degradation is shown. Bounds of session.py:14-16. A dead child fails pending calls; nothing is retried."
    - "The child's stderr reaches the log at WARNING with its pid, and a key printed there is redacted (plan 0015 acceptance ported)."
    - "Restart with backoff and a breaker. The runtime restarting for a type change does not restart the services process or the child (e2e: child pid unchanged)."
    - "MCP heartbeat (plan 0010, owner ruling): the child is pinged over MCP every 30 s, and a beat is recorded only for an answered ping. A child that does not answer within its stability profile is judged stale and restarted, with a notice naming it. A slow pass defers and never fabricates a verdict. Tested with a fake child that stops answering pings but stays alive (break it, watch it fail)."
    - "The key is shared with the runtime's redactor over the direct port, never persisted anywhere else."
    - "Ledger rows with wi = this item are decided."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-03-shell-and-supervisor, WI-0018-04-one-log, WI-0018-06-secret-store]
  slice: '03'
  size: M

- id: WI-0018-19-mcp-gateway-and-endpoint
  title: The loopback MCP endpoint and moving it live
  intent: "Codex and other clients connect independently to InnyTypes (plan 0007), and the person moves the endpoint from the app without a restart (plan 0008)."
  acceptance:
    - "The gateway ports every behaviour of gateway.py: numeric loopback only, bearer from the existing mcp_proxy_token file checked before body parse, Host and Origin checks, limits of gateway.py:46-63, GET refusal text, 503 while the child is unavailable, collision degrades with the address named."
    - "The endpoint setting is stored, and the stored value wins over INNYTYPES_MCP_HOST and INNYTYPES_MCP_PORT, which are only the default. The Settings page edits it, refuses non-loopback, shows served against saved, and warns that clients must be updated."
    - "Live move: bind-before-close. A failed bind keeps the old endpoint serving and names the failure."
    - "An independent Streamable HTTP client initialises, lists tools and calls one, with no launch of either side (test_independent_client_connection ported)."
    - "The Anytype key never appears in any request, response, URL, error or log line (canary)."
    - "Ledger rows with wi = this item are decided."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-18-anytype-core-service]
  slice: '03'
  size: M

- id: WI-0018-20-anytype-nodes
  title: Anytype node types
  intent: "Anytype also appears on the canvas (plan 0017 architecture 6): create, update or read an object, read a space, search. The key must never enter a flow or a log."
  acceptance:
    - "packages/anytype (TS, esbuild, first-party, shipped in the app) declares the five types of section 4.2, with the shared api-client bundled in."
    - "The key is read at run time from the canonical file via the SDK helper. It is absent from flows.json, flows_cred.json, start frames, the journal and snapshots (canary scan)."
    - "Each type is tested against a fake Anytype HTTP server. A 401 fails the input with the pair-again message and one notice. Errors never echo the key."
    - "e2e: a watched-folder fixture source, then Create object on the fake server, then a snapshot with an Anytype link."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-05-node-processes-on-protocol-v2, WI-0018-09-generated-types-and-forms, WI-0018-18-anytype-core-service]
  slice: '03'
  size: M

- id: WI-0018-21-desktop-integration
  title: Launch at login, notifications, Anytype app, window rules
  intent: "The old helper's desktop promises: one icon starts everything, a clear way to turn it all off, no tray icon, and a login item that never lies about its state."
  acceptance:
    - "Launch at login: Electron setLoginItemSettings on macOS and Windows; a Linux autostart .desktop (port of linux.py:249). The OS is asked first, the setting is written after success, and a failure leaves both unchanged (launcher.py:1450)."
    - "Notices: the kinds, wording and once-only rule of notification.py are ported to domain/notices and delivered with Electron Notification; the AppUserModelId is set."
    - "The Anytype desktop app is started if absent, adopted if running, and quit on Quit only if InnyTypes started it."
    - "Window rules: closing the window hides it and quits nothing (window.py:65-67). Quit is in the app menu and the window. No tray, menu-bar or notification-area icon on any OS."
    - "Ledger rows with wi = this item are decided (helper_windows rows are decided here; their proofs are in WI-30)."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-03-shell-and-supervisor, WI-0018-04-one-log]
  slice: '03'
  size: M

- id: WI-0018-22-telemetry
  title: Consent-first telemetry
  intent: "Nothing leaves the machine that the person did not agree to, and nothing at all before they were asked (plan 0003 F2)."
  acceptance:
    - "The first-launch question and privacy notice are ported (telemetry.py:1380). Before an answer, nothing is queued or sent (network is mocked and asserted empty)."
    - "The switch is re-read from settings on every send. Payload redaction ports telemetry.py:395-590 (forbidden keys, paths, sizes). The keyed machine id is kept."
    - "Disk queue bounded at 128 reports and 1 MiB, with backoff (telemetry.py:716-906). GlitchTip (Sentry envelope) and Umami transports are ported. No Sentry SDK is used."
    - "Crash reports cover the runtime, services and node-instance crash counts, using only the redacted payload."
    - "Ledger rows with wi = this item are decided."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-04-one-log, WI-0018-06-secret-store, WI-0018-11-app-pages-inbox-and-popouts]
  slice: '03'
  size: M

- id: WI-0018-23-packaging
  title: Per-arch packages with bundled runtimes, without npm
  intent: "Other people install it. The spike built unsigned arm64 only, with one shared Python and npm inside (arch_pivot P8 and section 5.7)."
  acceptance:
    - "electron-builder produces macOS arm64 and x64 (dmg and zip) and Linux arm64 and x64 (AppImage and deb). Linux builds run inside the Multipass Ubuntu VM."
    - "Bundled, pinned by version and sha256 per target: python-build-standalone 3.13, uv and Node 24. A hash mismatch fails the build."
    - "Fuses: RunAsNode off, NodeCliInspect off, OnlyLoadAppFromAsar and asar integrity on. First-party packages are unpacked from the archive."
    - "npm is not in the bundle: node_modules/npm is excluded. A test proves @node-red/registry still loads, and the runtime's spawn wrapper refuses npm and npx."
    - "Node-RED's examples folder is restored, or its error silenced, with no unhandled rejection at start."
    - "Packaged smoke (macOS arm64): the P2-shaped flow with fixture nodes runs from the package."
    - "Ledger rows with wi = this item (bundle) are decided."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-16-package-install-remove-hot-add, WI-0018-20-anytype-nodes]
  slice: '03'
  size: M

- id: WI-0018-24-signing-and-updates
  title: Signing, notarising and verified updates
  intent: "Updates must keep the rule 'trust the signature, never the server', and macOS updates require a signed app."
  acceptance:
    - "macOS signing and notarising with the owner's Developer ID. If it is absent, the build is ad-hoc signed and the update proof is recorded as blocked, not passed."
    - "electron-updater with the GitHub Releases provider. Before downloading, latest-*.yml is fetched with its .minisig and verified against the embedded public key; electron-updater then checks the artifact's sha512 from that yml. A tampered yml or artifact is refused with a notice."
    - "The update check switch and channel come from settings. The update installs at quit (parity with apply-at-quit, plan 0003 D11)."
    - "Health rollback rows are retired with reason owner-retired-behaviour, awaiting owner_ack."
    - "Ledger rows with wi = this item are decided."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-23-packaging]
  slice: '03'
  size: M

- id: WI-0018-25-migration-and-first-run
  title: Migrating an old installation
  intent: "A correct cutover means an existing user loses nothing: their key, the Codex token and port, their consent, and their login choice."
  acceptance:
    - "userData is set explicitly to <appData>/it.l1nx.innytypes, because Electron's InnyTypes folder collides with the old innytypes data folder on case-insensitive macOS."
    - "The old config.toml is imported once: telemetry answer, launch_at_login, update mode and channel, the [mcp] endpoint and package update overrides. The report lists what was ignored and why."
    - "The key and proxy token are used in place. An existing Codex configuration keeps working (e2e with a fixture old install)."
    - "The old LaunchAgent (macOS) or autostart entry (Linux) is removed only when the new login item is set."
    - "Old plugin environments are listed in one notice with a delete button; nothing is deleted without it."
    - "If the old helper is still running (its helper.lock is held), the new app asks the person to quit it before serving the endpoint."
    - "Ledger rows with wi = this item (helper_config) are decided."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-06-secret-store, WI-0018-19-mcp-gateway-and-endpoint, WI-0018-21-desktop-integration, WI-0018-22-telemetry]
  slice: '03'
  size: M

- id: WI-0018-26-node-sdks-for-authors
  title: Node SDKs and the packaging tool for authors
  intent: "Python and JS/TS are first-class and third parties publish packages. They need SDKs that pass conformance and a tool that builds and signs an archive."
  acceptance:
    - "sdk/python (innytypes-node, standard library only) and sdk/ts (@innytypes/node, no dependencies) implement Appendices A and B and pass C1 to C14; C3 stdout hygiene is automated."
    - "An inny-pack tool builds the archive (files.json, hash-locked requirements for Python, a pre-bundled file for JS), signs it with minisign, and verifies it as the app would."
    - "Author documentation: declaration, SDK, packaging, signing, catalogue listing. Example packages in each language install in the dev app."
    - "The SDK Python stages are in the gate."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-05-node-processes-on-protocol-v2, WI-0018-16-package-install-remove-hot-add]
  slice: '05'
  size: M

- id: WI-0018-27-ledger-complete
  title: Every ledger row decided
  intent: "No behaviour may be dropped silently. The audit must also look across items, because per-item acceptance never asks whether items agree."
  acceptance:
    - "tools/parity/check.ts --final passes, apart from proofs, which are WI-28 to WI-30."
    - "Every retirement that a person could see is listed for the owner, and owner_ack is recorded from the owner's answers."
    - "A fresh-context verifier samples 5 percent of ported rows (at least 100), breaks the implementation each names, and confirms the new test fails. It confirms each sampled test asserts the whole behaviour sentence, not one clause."
    - "The gate switches to --final for ledger rows."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-01-workspace-and-gate, WI-0018-02-parity-ledger, WI-0018-03-shell-and-supervisor, WI-0018-04-one-log, WI-0018-05-node-processes-on-protocol-v2, WI-0018-06-secret-store, WI-0018-07-journal, WI-0018-08-node-red-embedded-and-guarded, WI-0018-09-generated-types-and-forms, WI-0018-10-views-in-the-runtime, WI-0018-11-app-pages-inbox-and-popouts, WI-0018-12-editor-sync-and-quit, WI-0018-13-created-event-types, WI-0018-14-signatures-and-catalogue, WI-0018-15-package-environments, WI-0018-16-package-install-remove-hot-add, WI-0018-17-package-updates, WI-0018-18-anytype-core-service, WI-0018-19-mcp-gateway-and-endpoint, WI-0018-20-anytype-nodes, WI-0018-21-desktop-integration, WI-0018-22-telemetry, WI-0018-23-packaging, WI-0018-24-signing-and-updates, WI-0018-25-migration-and-first-run, WI-0018-26-node-sdks-for-authors]
  slice: '04'
  size: M

- id: WI-0018-28-proofs-macos
  title: Machine proofs on macOS
  intent: "Every behaviour the old app shows on the machine is re-proved on the machine (plan 0017 cutover step 2)."
  acceptance:
    - "Every proof of section 5.4 passes on macos-arm64 and macos-x64 (x64 under Rosetta, recorded as such), from the packaged app, with evidence under docs/parity/evidence/."
    - "codex-smoke closes plan 0007's outstanding manual check."
    - "The real-key scan finds the key in 0 files of the userData, logs and repository."
    - "If there is no Developer ID, update is recorded blocked."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-24-signing-and-updates, WI-0018-25-migration-and-first-run, WI-0018-27-ledger-complete]
  slice: '04'
  size: M

- id: WI-0018-29-proofs-linux
  title: Machine proofs on Linux (Multipass)
  intent: "Linux is a supported OS and can be tested here, in a Multipass Ubuntu VM on this Mac."
  acceptance:
    - "Ubuntu LTS arm64 VM with a desktop session (or Xvfb plus dbus plus a notification daemon, recorded as such)."
    - "C1 to C15 run inside the VM, including the Linux parent-death and stdin-EOF cleanup (spec 6.4 and 6.6)."
    - "Every proof of section 5.4 passes on linux-arm64 (AppImage and deb). linux-x64 rows are recorded blocked until an x64 machine exists."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-23-packaging, WI-0018-27-ledger-complete]
  slice: '04'
  size: M

- id: WI-0025-01-windows
  title: Windows build, conformance and proofs
  status: BLOCKED
  blocked_by: "No Windows machine or VM exists."
  intent: "Plan 0017 requires every row green on Windows before the cutover. Windows is where the spike expects trouble: paths, SIGKILL emulation, Job Objects, python.exe."
  split: "30a: NSIS x64 build, Job Objects, python.exe and {python} substitution, realDir separators, conformance C1 to C15. 30b: every section 5.4 proof on windows-x64, plus code signing if the owner provides a certificate."
  acceptance:
    - "30a: the build installs and starts. Node processes are in a Job Object and die with the runtime. Conformance passes."
    - "30b: every proof passes on windows-x64 with evidence."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-27-ledger-complete]
  slice: '04'
  size: L

- id: WI-0018-31-farewell-release
  title: The old app's last release points to the new one
  intent: "The old updater swaps Python releases (swap.py) and cannot install an Electron app. Existing users must be told how to move."
  acceptance:
    - "One old-app release whose only change is a notice with the new app's download link, published through the existing release index. Its tests are added to the old suite and to the ledger as retired with reason helper-host-split-gone."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-24-signing-and-updates]
  slice: '06'
  size: S

- id: WI-0026-01-cutover
  title: Delete the old application in one change
  status: BLOCKED
  blocked_by: "WI-0025-01-windows"
  intent: "Sudden, massive and correct: one change, only once every ledger row and every proof is green on macOS, Linux and Windows."
  acceptance:
    - "On branch cutover/0017, merged once: delete src/innytypes, src/helper and tests/; delete the Python host parts of pyproject.toml, uv.lock and the Briefcase config; delete the Python stages of verify.sh. The ledger and old-tests.txt stay as the record."
    - "tools/parity/check.ts --final passes with every proof pass on every target."
    - "README, CHANGELOG and docs/anytype-mcp-connection.md describe only the new app. Version 1.0.0 is published to GitHub Releases, signed and minisigned."
    - "docs/loop/verify.sh exits zero and prints gate: GREEN."
  depends_on: [WI-0018-27-ledger-complete, WI-0018-28-proofs-macos, WI-0018-29-proofs-linux, WI-0025-01-windows, WI-0018-31-farewell-release]
  slice: '06'
  size: M
```

---

## 9. Slice 05 handoff notes

**monty** (its own repo and plan):
- It becomes a protocol v2 package, `uv-python`, with two sources:
  - *Folder watcher*, with outputs `new`, `updated`, `deleted` (`monty.<kind>.v1`);
  - *Volume watcher*, which adds `mounted`, `unmounted`.
- Its state file lives in `data_dir`, as the spike adapter did (`packages/monty/folder_watcher.py`).
- The volumes table becomes a config array of objects (WI-09).
- Plan 0011's *re-emit* becomes a snapshot action.
- Plan 0012's `platformdirs` quarantine disappears, because the runtime passes paths.
- It ships as a signed archive built with `inny-pack` (WI-26), with hash-locked requirements.

**innyrize** (its own repo; re-plan of its 0001):
- One node, *Diarize*, input `monty.new.v1`, output `diarized` (`innyrize.diarized.v1` with a folder
  path, not content, because of the 1 MiB frame limit).
- `hf_token` is a credential (`writeOnly`).
- It sends `status` progress every few seconds, honours `cancel`, and queues serially (spec 4.3.3).
- It has no timeouts; long jobs are legal (P3).
- The speaker naming it needs is the action view "Name the speakers". It can live in innyrize as a
  view type, or use a generic form view.

**Anytype:** there is no separate repo. It is `packages/anytype` in this repo, WI-20 (§4.2).

---

## 10. Risks: the five most likely ways a big-bang cutover goes wrong

1. **Windows is never proven, so the cutover waits forever or ships unproven.**
   - *Mitigation:* the Windows-sensitive seams are built behind ports from the first item: process
     groups and Job Objects, `{python}` paths, the separator in `realDir`, toasts.
   - The cutover is formally BLOCKED, not quietly skipped.
   - The owner decides between an EU-hosted Windows VM (for example on Hetzner or Scaleway, with a
     licence) and a physical machine. No other item waits for it.
2. **The ledger becomes a rubber stamp.** Mass "retired" rows, or ported tests that assert one
   clause of a compound behaviour. This project has already met the "compound acceptance bullet"
   failure.
   - *Mitigation:* ported ids must **pass in the same gate run**.
   - Reason codes come from a fixed list, and user-visible retirements need `owner_ack`.
   - WI-27 breaks the implementation behind a 5% sample and checks that each test fails and asserts
     the whole behaviour sentence.
3. **Built but not assembled.** This is the recurring defect in this repository: every part passes
   its unit tests, and the composition root never wires it.
   - *Mitigation:* one composition root per process, with the architecture rules in the gate.
   - Every item carries an e2e bullet through the real dev app.
   - Machine proofs run the **packaged** app, not the dev tree.
4. **Existing users break at the switch.** They could lose the key, the Codex token or port, consent
   or their login item. The old updater cannot deliver the new app. The new app's data folder
   silently merges with the old one on case-insensitive macOS.
   - *Mitigation:*
     - the key and token stay at their old paths;
     - WI-25 imports settings once and removes the old login item only after the new one works;
     - an explicit `userData` path avoids the folder collision;
     - the new app detects the old helper still running;
     - WI-31's farewell release points people to the new app.
5. **The pinned platform shifts under the borderline surfaces.** These are:
   - Node-RED's `runtime-event` convention and the editor's client registry (P11 §4);
   - `utilityProcess` parent-death semantics on Linux and Windows;
   - `node:sqlite` inside Electron;
   - macOS updates, which require a signed app.

   *Mitigation:*
   - exact version pins;
   - contract tests that fail the gate when an upgrade changes a borderline surface (WI-12);
   - tested fallbacks (editor reload if clean or prompt if dirty; `better-sqlite3`);
   - the ppid watchdog;
   - the update proof is recorded *blocked* without a Developer ID rather than skipped.

Other risks to watch:
- A key leak through a new path (node stderr, crash dumps, the telemetry queue). The canary scan in
  the gate and the real-key scan in proofs cover this.
- The gate getting slower. Heavy e2e specs are tagged `@machine`.
- UI work growing before the owner's redesign. `AppApi` is the only contract, and pages stay
  unstyled.

## 11. What only the owner can supply

- An Apple Developer ID, for signing, notarising and macOS auto-update (WI-24, WI-28).
- A Windows x64 machine or VM, and optionally a code-signing certificate (WI-30).
- An x64 Linux machine, or acceptance that Linux x64 is built but proven only on arm64 (WI-29).
- `owner_ack` answers for the user-visible retirements that WI-27 lists. Known ones already:
  - stale and resource-breach killing for **node instances** (`helper/detection.py`). The MCP child keeps its heartbeat and staleness judgement;
  - update health rollback (`helper/swap.py`);
  - the CLI (`cli.py`).
- Confirmation that the old release index behind `update.py:111` is live, so the farewell release
  (WI-31) reaches people.
