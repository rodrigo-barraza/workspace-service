# Workspace Service — Improvement Plan

> **Status (2026-07-13):** Phases 0–4b implemented (see git history for the
> details). Still open: Phase 5 (harness-inspired enhancements: background
> commands, edit staleness guard, permission modes, diagnostics RPC, grep
> output modes), tray items 1.4 (cached WSL node path), 1.8 (template icons,
> self-hosted fonts, copy-diagnostics), server-side auth on the installer
> upload route (tools-service), and first-message WS auth (3.4). Windows
> verification still needed for: WSLENV secret forwarding (tray WSL mode),
> the PowerShell -EncodedCommand folder dialog, and the SEA win32 build.

_Audit date: 2026-07-13. Scope: core service (`src/`), tray app (`tray-app/`), VS Code
extension (`vscode-extension/`), standalone/SEA build (`standalone/`). Everything below is
designed to be non-breaking: wire protocol, config file formats, and deploy flows stay
compatible; changes are additive or internal._

---

## TL;DR — why the tray app feels buggy

Two defects compound into almost every symptom (wrong tray status, "Connect" doing nothing,
duplicate agents, needing to quit/relaunch):

1. **The agent never auto-reconnects.** `src/AgentClient.ts:158-168` — the WebSocket `close`
   handler never calls `_scheduleReconnect()`. The entire reconnect subsystem (backoff,
   `reconnectInterval`, the `"reconnecting"` event the tray listens for in
   `tray-app/src/agent/agent-runner.mjs:69`) is dead code. Any blip → child agent sits idle
   forever → tray shows Disconnected until the user manually restarts. Worse, the heartbeat
   watchdog `terminate()`s connections it can then never restore.
2. **`AgentProcess.stop()/start()` race clobbers the child handle.** `stop()` doesn't detach
   the old child's listeners or null the handle synchronously; when the old process finally
   exits (up to 3s later), its `exit` handler sets `this.childProcess = null` and emits
   `disconnected` — *after* `start()` has already assigned a NEW child to the same field.
   Result: `isRunning()` lies, the tray shows Disconnected while an agent is actually
   connected, "Connect" becomes enabled and spawns a **second** agent, and the 3s SIGKILL
   timer in `stop()` can even kill the *new* child. Every restart path (`Save & Reconnect`,
   tray menu, `AGENT_RESTART` IPC with its 500ms sleep) rolls these dice.

Fix order that pays off immediately: reconnect rewire (one-line class of fix, everything
already exists) → AgentProcess lifecycle rewrite → secret-leak redaction → WSL spawn
hardening.

---

## Phase 0 — Tooling safety nets (do first; everything else gets safer)

| # | Item | Detail |
|---|------|--------|
| 0.1 | **Pin stable TypeScript** | `package.json` has `"typescript": "next"` → resolves to a 7.1 nightly. This *currently crashes* `npm run lint` (typescript-estree `Cannot read properties of undefined (reading 'Cjs')`) and makes Docker builds non-reproducible. Pin `~5.9`. |
| 0.2 | **Delete dead code** | `src/test.ts` (ships in the Docker image), `test-import.js`, unused `no-constant-condition` eslint override. After 1.1 below, also remove or rewire the now-live reconnect plumbing docs. |
| 0.3 | **Deterministic standalone bundle** | `standalone/esbuild-standalone.mjs:114` embeds a build timestamp in the committed 17k-line `workspace-agent-core.mjs`, so every rebuild dirties git (see commit `c8056be`). Drop the timestamp (keep a git-SHA banner) so real diffs are reviewable. |
| 0.4 | **Type-check and lint tests** | tsconfig `exclude: ["tests"]` + `lint` only covers `src` → 1100+ lines of tests are neither type-checked nor linted; meanwhile `src/__tests__/` *compiles into* `dist/` and ships in the image. Move `src/__tests__` → `tests/`, add `tests` to a `tsconfig.eslint.json`, exclude from build. |
| 0.5 | **Version from one place** | Four independent versions: root 0.1.0, extension 0.1.0, `standalone/bundle-entry.mjs:19` hardcoded `AGENT_VERSION`, tray-app 1.0.0. Read from package.json at build time (esbuild `define`) and stamp all artifacts. Surface it in the tray menu + `/health` so "stale bundle" debugging (a known recurring failure mode) becomes trivial. |
| 0.6 | **CI gate** | A single GitHub Action / pre-deploy step: `tsc --noEmit && eslint && vitest run`. `vitest run` currently passes 144 tests; keep that green. |

---

## Phase 1 — Tray app stabilization (the priority)

### 1.1 Rewire auto-reconnect (core fix, tray's biggest symptom)
`src/AgentClient.ts:158-168`: in the `close` handler, when `!this.intentionalClose`, call
`this._scheduleReconnect()`. The backoff, max-delay cap, and `reconnecting` event already
exist and are tested nowhere (see 6.x). Then:
- Rebuild `standalone/workspace-agent-core.mjs` (the tray app bundles a *copy* of
  AgentClient — the bundle at `:17665` has the same dead code).
- Keep the 401/auth path latched (`intentionalClose = true` on 401 is correct so a bad
  secret doesn't hot-loop), but emit a distinct `auth-failed` event so the tray can show
  "Check your API secret" instead of generic Disconnected.
- Update the now-false comment in `src/health.ts:30`.

### 1.2 Make `AgentProcess` lifecycle race-free (`tray-app/src/agent/AgentProcess.ts`)
Rewrite stop/start around a **per-child generation token**:
- `stop(): Promise<void>` — capture `const child = this.childProcess` locally; send
  shutdown; resolve on that child's `exit` (or SIGKILL after 3s **of that captured
  handle**, never `this.childProcess`); `child.removeAllListeners()` before nulling.
- Each spawned child gets `const generation = ++this.generation`; every `exit`/`error`/
  message handler bails if `generation !== this.generation`. This makes late events from a
  dying child unable to clobber the new child's state (lines 186-191 today).
- `start()` becomes `async` and `await this.stop()` first — delete the blind 500ms sleeps
  in `restart()` (:244-253) and in the `AGENT_RESTART` IPC handler (`main.ts:62-68`).
- `before-quit` (`main.ts:169`): `event.preventDefault()` once, `await agentProcess.stop()`,
  then `app.exit()`. Today the 3s kill timer never fires because the app exits first —
  WSL-mode children (`wsl.exe`) can be orphaned and hold the old connection, which the
  backend then sees as a ghost agent.

### 1.3 Stop leaking the API secret
- `AgentProcess.ts:118` logs the full spawn argv — **including `AGENT_SECRET=...`** — into
  the log buffer rendered in the Settings → Logs tab. Redact (`AGENT_SECRET=***`) before
  logging.
- WSL mode passes the secret as argv (`env AGENT_SECRET=... bash ...`), visible to `ps` for
  any process in the distro. Pass it via stdin as the first JSON line (the runner already
  reads stdin), or via `WSLENV`-forwarded environment variable.
- `settings.html` loads the decrypted secret into the DOM on open. Acceptable for a
  personal tool, but cheap to improve: return a `hasSecret: true` placeholder from
  `GET_CONFIG` and only write a new secret when the field is edited.

### 1.4 Harden the WSL spawn path
`bash -lic 'exec node …'` works but is the most fragile link:
- `-i` without a TTY makes bash emit "cannot set terminal process group" / "no job control"
  warnings on stderr → logged as scary red **errors**; any `.bashrc` that echoes pollutes
  the stdout JSON-line protocol.
- Better: during distro selection (setup/settings already run `checkNodeInDistro`), also
  resolve and **cache the absolute node path** (`bash -lic 'command -v node'`), store it in
  config (`wslNodePath`), then spawn `wsl.exe -d <distro> -- /abs/path/node runner.mjs`
  with no interactive shell at all. Fall back to the current `bash -lic` if the cached path
  goes stale (re-resolve once on ENOENT).
- Frame the child protocol defensively: prefix protocol lines (e.g. `@prism:{json}`) so
  stray shell output can never be confused with a control message.

### 1.5 Fix the status model (status ≠ process running)
Today `connectionStatus` and "child process exists" are conflated:
- Tray "Connect/Disconnect" enablement keys off `isRunning()` while the settings window's
  Disconnect button keys off `connectionStatus` (`settings.html:347-351`) — so a running
  agent that is *reconnecting* can't be disconnected from settings.
- Track both: `processState: stopped|running` and `connectionStatus:
  connected|connecting|disconnected`, expose both in `AgentStatusInfo`, and derive UI from
  the right one (Disconnect ⇐ processState, status dot ⇐ connectionStatus).
- Add a fourth visual state for `auth-failed` (from 1.1) so bad secrets are diagnosable
  from the tray.

### 1.6 Push status/logs to windows instead of polling
- `IPC_CHANNELS.LOG_ENTRY` is defined but never used; the Logs tab is manual-refresh and
  the header status polls every 5s (`settings.html:443`). Forward `agentProcess.on("log")`
  and `"status-changed"` via `webContents.send` to open windows; keep `getLogs()` for
  initial fill. Delete the `setInterval`.
- Notification hygiene (`TrayManager.ts:218-227`): debounce — only notify "Connected" on
  first connect or after >60s down, and "Disconnected" only after reconnect attempts have
  failed for N seconds. Today a flapping network produces a notification storm (and 1.1
  makes flapping *visible* where before it was one permanent death).

### 1.7 Setup/settings UX correctness
- **Setup wizard closes before knowing the outcome** (`setup.html:361-389`): it says
  "Connecting…" then unconditionally `window.close()`. Wait for the first
  `connected`/`auth-failed`/`error` status (with timeout) and show the result; only close
  on success. This is the #1 "works-but-feels-broken" moment for a new install.
- **Divergent config semantics between the two save paths**: settings save
  (`settings.html:386-393`) puts the *Linux* path into `workspaceRoots` in WSL mode, while
  tray "Change Workspace" (`TrayManager.ts:92-97`) puts the *Windows* path in
  `workspaceRoots` and the translation in `wslLinuxPaths`. Pick one canonical rule
  (recommend: `workspaceRoots` = what the user picked, `wslLinuxPaths` = derived) and
  enforce it in `ConfigStore.setConfiguration` so no caller can diverge.
- `hasValidConfiguration()` (`ConfigStore.ts:75-81`) doesn't require a secret → tray
  Connect with an empty secret → 401 → (today) permanent latch. Require secret, or let 1.1's
  `auth-failed` state carry it.
- Deduplicate `translateUncPathToLinux` — it exists in `setup.html:217`,
  `settings.html:194`, and `WslDetector.ts:125`. Two renderer copies of main-process logic
  will drift; expose it through the preload instead.
- `second-instance` (`main.ts:23-25`) does nothing — open the settings window so a user
  double-clicking the installed app gets feedback.
- Settings "Save & Reconnect" fire-and-forgets `agentRestart()` then guesses with
  `setTimeout(updateStatus, 1000)`; after 1.2 makes restart properly async, await it and
  render the returned status.

### 1.8 Tray polish (small, cheap)
- macOS: mark tray icons as template images (`image.setTemplateImage(true)`) so they adapt
  to dark/light menu bars; add `LSUIElement` via electron-builder `mac.extendInfo` instead
  of runtime `dock.hide()` (avoids dock-icon flash at launch).
- Move inline `<script>` out of setup/settings HTML into `.js` files, self-host the Inter
  font (windows currently fetch Google Fonts at runtime — first paint changes offline),
  drop `'unsafe-inline'` from the CSP.
- Add a "Copy diagnostics" tray item: agent version, config (secret redacted), last 50 log
  lines, WSL node path — one click to paste into an issue/chat when debugging.

### 1.9 Tray build/test hygiene
- `tray-app/package.json` has **no test script** — the 800 lines of vitest tests only run
  via the root runner by accident of glob. Add `"test": "vitest run"` (or wire the root
  script explicitly) so they can't silently fall out of CI.
- Replace the unreadable inline-`node -e` `copy-assets` script with a 15-line
  `scripts/copy-assets.mjs`.
- **`build-and-upload.sh:170-175` uploads installers with no authentication** — a bare
  `curl -X PUT` to `/agents/upload/tray-app`. If that endpoint is really unauthenticated
  server-side, anyone who can reach `api.tools.rod.dev` can replace the installers your
  machines download (supply-chain risk). Verify tools-service requires a secret here; add
  the header to the script either way.
- Consider `electron-updater` later; until then, 0.5's version stamping + a tray-menu
  "Update available" check against the backend covers the stale-installer failure mode.

---

## Phase 2 — Core service correctness (`src/`)

Ordered by severity; all are behavior-preserving fixes.

| # | Issue | Fix |
|---|-------|-----|
| 2.1 | **Heartbeat only cleared by `agent.ping`** (`AgentClient.ts:352-364`, `:272-275`). Active RPC traffic doesn't count as liveness → a busy server can get healthy connections terminated mid-request. | Clear/re-arm the timeout on **any** inbound message; keep the ping as the idle-path keepalive. Also null `heartbeatTimeout` after clearing. |
| 2.2 | **Floating `_handleMessage` + `logger.rpc` crash on numeric ids** (`AgentClient.ts:148-155`, `:287`; `logger.ts:8-11` does `id?.slice`). A numeric JSON-RPC id (legal) → unhandled rejection → process exit. | `.catch()` the dispatch; `String(id)` in the logger; validate id type at parse. |
| 2.3 | **Command timeout kills bash, not descendants** (`CommandHandler.ts:63-73`, duplicated at `:181`). `npm run dev`-style commands leave orphans that accumulate against the 256MB container cap; surviving children holding stdout also delay the RPC settling (settles on `close`, not `exit`). | `detached: true` + `process.kill(-child.pid, "SIGKILL")` (same pattern Claude Code's own Bash tool uses); settle on `exit` and destroy streams. |
| 2.4 | **Silent truncation at exact boundary** (`CommandHandler.ts:77-82`; `GitHandler.ts:44-56` has *no* marker at all). Output that lands exactly on `MAX_OUTPUT_BYTES` (8×64KiB pipe chunks) drops the marker → the LLM reads partial output as complete. | Track an explicit `truncated` boolean, always emit the marker. Harness rule of thumb: *every* capped result carries an explicit truncation flag. |
| 2.5 | **Watch debounce drops events** (`AgentClient.ts:417-431`) — one timer per root, closure keeps only the last `{eventType, filename}`; `git checkout` of 50 files emits 1 event; steady writers postpone forever. | Accumulate events into a batch array, flush on debounce **with a max-wait**, send the batch (additive payload field; keep old fields for compatibility). |
| 2.6 | Dropped-connection responses vanish silently; a late response can even go out on a *new* socket with an old connection's id (`AgentClient.ts:327-331`). | Tag in-flight requests with a connection epoch; drop cross-epoch responses **loudly** (log). |
| 2.7 | Secret-load failure is swallowed (`bin/workspace-service.ts:79-96`, bare `catch {}`) → connects secretless → 401 → permanent latch (with 1.1's auth event, at least it's visible). DB value also silently overrides an explicit `--secret`. | Log the load failure; explicit flag wins over DB; retry secret load with backoff before first connect. |
| 2.8 | `stringReplace` counts overlapping matches but replaces non-overlapping (`FileHandler.ts:190-194`) → spurious "found 2 occurrences" rejections. | Advance by `oldString.length`. (Mirrors the uniqueness semantics of Claude Code's Edit tool — count and replace must agree.) |
| 2.9 | Non-atomic writes (`FileHandler.ts:159,219,261`) — crash mid-write truncates files. | Write temp + `rename` in the same directory. |
| 2.10 | `connect()` doesn't tear down a prior socket (`AgentClient.ts:128-137`); late events from the orphan corrupt heartbeat state of the new one. | `removeAllListeners()` + `terminate()` old socket first (same generation-token idea as 1.2). |
| 2.11 | Shutdown: fixed 500ms then `process.exit(0)`; health server never closed (`bin/workspace-service.ts:124-129`). | Await ws close + `server.close()` with a deadline. |
| 2.12 | Robustness caps: `directoryTree` has no entry cap (unlike its siblings); `multiFileRead` can build ~20MB responses; no `maxPayload`/backpressure on `ws.send`. | Add entry cap + total-bytes cap; check `bufferedAmount` before large sends. |
| 2.13 | `search.grep` `includes` filter is a fake glob (`FileHandler.ts:662-669`) — `src/**/*.ts` silently matches nothing (LLM misreads empty results as "no matches"). | Use the already-imported `globToRegex`, or reject unsupported patterns with an actionable error. |
| 2.14 | No per-request watchdog: a ReDoS regex in `search.grep` pins the event loop → heartbeat starves → (pre-1.1) permanent death. | Per-handler soft timeout returning a structured error; long-term, run grep line-matching with a regex complexity guard or `re2`-style guard. |

---

## Phase 3 — Security hardening

| # | Issue | Fix |
|---|-------|-----|
| 3.1 | **Path sandbox is decorative outside Docker.** `utils.ts:155-170` — `validateWorkspacePath` always returns `safe: true`; roots are unused. Fine for the container-is-the-jail Docker stance (documented in `FileHandler.ts:38-41`), but **the same code runs on hosts** via tray/standalone: a compromised backend can read `~/.ssh`, write `~/.bashrc`, and run arbitrary shell. | Add a containment mode (resolve + verify `startsWith(root + sep)` per root, post-symlink-resolution) **enabled by default when not in Docker** (env flag to opt out). The tray app should also pass a command policy: default-deny `command.run` outside the roots' project dirs, or an allowlist à la Claude Code's permission settings. |
| 3.2 | `MONGO_URI` + vault secrets inherited by every `command.run` child (`CommandHandler.ts:66`, `env: {...process.env}`) — an `env` command dumps credentials to the LLM. | Denylist known-secret env vars when spawning children. |
| 3.3 | Extension stores the API secret as a plain synced setting (`vscode-extension/package.json:61-65`); standalone writes it 0644 to `~/.prism-workspace-agent.json`. | Extension → `context.secrets` (SecretStorage); standalone → `writeFile(..., {mode: 0o600})`. Tray already uses `safeStorage` — good, keep. |
| 3.4 | Standalone ws-shim puts the secret in the URL query (`standalone/shims/ws-shim.mjs:26-31`) → proxy access logs. | First-message auth handshake over the established socket (server is yours; additive: accept both during transition). |
| 3.5 | Extension URI handler auto-connects to any backend a webpage supplies (`extension.ts:321-334`) — a malicious `vscode://` link mounts an attacker filesystem + terminal profile. | Modal confirmation showing backend + workspace before connecting. |
| 3.6 | Unauthenticated installer upload (see 1.9) and unauthenticated `/health` on all interfaces disclosing roots/hostname. | Auth the upload route; bind health to loopback or add a token. |

---

## Phase 4 — VS Code extension fixes

1. **Reconnect throws on duplicate registration** (`extension.ts:243-260`): `onConnected`
   re-runs `registerSearchCommands` + `registerTerminalProfileProvider` on every reconnect →
   `command 'workspace.searchFiles' already exists`. Register once in `activate()` against a
   mutable holder — the `WorkspaceFileSystem.setRpcClient` swap pattern already in the code
   is the exact template.
2. **Binary writes corrupt files** (`WorkspaceFileSystem.ts:193-197` coerces via UTF-8; the
   server has no base64 write path). Add additive `contentBase64` to `file.write`
   server-side; extension detects non-UTF-8 payloads. Also make read-side binary detection
   content-based (null-byte sniff) rather than extension-list-based.
3. **Pending RPCs not rejected on unexpected close** (`RpcClient.ts:164-176`) → 15s frozen
   explorer spinners per op on every drop. Run the same reject loop as `disconnect()`.
4. **`disconnect()` during CONNECTING leaks socket + heartbeat interval and can fire
   `onConnected` post-disconnect** (`RpcClient.ts:87-91`) — reachable from the discovery
   flow's 5s timeout. Close/terminate for any non-CLOSED state; remove listeners.
5. Persist the secret the user types (`extension.ts:124-125` saves backendUrl only) → into
   SecretStorage (3.3); add auth-failure detection so a bad secret stops the reconnect loop
   with a real message (port from AgentClient).
6. Port the **application-level heartbeat** from `src/AgentClient.ts` into the extension's
   RpcClient — it currently uses WS ping/pong, which this repo's own comments document as
   absorbed by the Cloudflare/nginx proxy → perpetual terminate/reconnect cycles that then
   trigger (1).
7. Resubscribe watches on reconnect with a refcounted `Map<path, {recursive, count}>`
   (fixes both lost watches and the shared-path unsubscribe collision).
8. Terminal: accept multi-char input (paste is currently dropped —
   `WorkspaceTerminal.ts:121-125`), use `command.stream` for incremental output + Ctrl+C
   cancellation, fix `cd` edge cases.
9. Packaging: `vsce package --no-dependencies` while `ws` is a runtime dep → the next
   packaged vsix crashes on activation. Bundle with esbuild (mirror the standalone build)
   or drop the flag.

## Phase 4b — Standalone launcher

- Windows folder dialog is broken by quote nesting (`workspace-agent.mjs:136-144`, swallowed
  by catch → silently falls back to manual entry). Use `powershell -EncodedCommand`.
- `build-binaries.mjs` silently no-ops on win32 (no node.exe copy/postject branch) while the
  launcher clearly anticipates a Windows exe — add the branch or fail loudly.
- Wizard should prompt only for missing fields and save the *effective* merged config
  (`workspace-agent.mjs:224-239` currently discards fresh answers and can persist values it
  didn't use).
- Make backend URL normalization idempotent (strip an existing `/ws/...` before appending
  `/ws/agent`), shared as one utility with `src/bin/workspace-service.ts`, the extension
  (`extension.ts:130-135` duplicates it), and `AgentProcess.start` — four copies today.

---

## Phase 5 — Harness-inspired enhancements (optional, high leverage)

Patterns borrowed from Claude Code's own tool harness that fit this RPC surface:

1. **Background commands with handles.** `command.stream` exists; add
   `command.run {background: true}` → returns a task id; `command.output(id)` polls
   incremental output, `command.kill(id)` terminates the process group. Lets the LLM start
   dev servers/watchers without holding an RPC open (and pairs with 2.3's group-kill).
2. **Explicit, uniform truncation + pagination.** Every capped tool result carries
   `truncated: true` + how to get more (`offset/limit` on `file.read` already exists —
   extend the idiom to grep/list/tree). An agent that can't tell "empty" from "truncated"
   silently reasons from wrong data (2.4, 2.13).
3. **Edit-safety: read-before-write staleness guard.** Optional `expectedMtimeMs` param on
   `file.write`/`file.strReplace`; reject with a structured `stale-file` error if the file
   changed since the caller's last read. Cheap concurrency insurance for multi-agent use
   (mirrors the harness's file-state tracking; additive, callers that omit it keep today's
   semantics).
4. **Structured error envelope.** Handlers return `{error: string}` as *successful* results;
   real JSON-RPC errors only on throws — two channels every consumer must check. Keep the
   wire shape (tools-service depends on it) but add `errorCode` + `hint` fields so the LLM
   gets actionable, machine-checkable failures ("EISDIR — use directory.list").
5. **Permission modes for host installs.** A tray-configurable policy layer:
   `readOnly | project | full` (file ops confined to roots; commands allowlisted per mode) —
   the moral equivalent of Claude Code's permission modes, addressing 3.1 UX-wise instead of
   only technically.
6. **`/doctor`-style diagnostics RPC + tray button.** One call that runs: WS handshake test
   (the README's curl check, automated), auth check, roots exist/readable, node-in-WSL
   check, version match vs backend. Output feeds the "Copy diagnostics" button (1.8).
7. **Grep ergonomics.** `output_mode: files_with_matches | content | count`, `-C` context
   lines, `head_limit` — the exact knobs that make agent grep cheap; today every match ships
   full line content only.

---

## Phase 6 — Test strategy (locks in every fix above)

Current coverage is strong where it exists (path virtualization: 800+ adversarial lines;
heartbeat; ProjectHandler starvation regression; tray AgentProcess/WslDetector: 800 lines)
and absent exactly where the bugs are:

- **Reconnect**: "close with `intentionalClose=false` schedules reconnect" — would fail
  today and is the regression test for 1.1. Add auth-latch and epoch tests (2.6, 2.10).
- **AgentProcess races**: rapid `stop(); start()` — assert single live child, no
  status flap, kill-timer never touches the new generation (1.2). The mock-child harness in
  `tray-app/src/agent/__tests__/AgentProcess.test.ts` already supports this.
- **FileHandler / CommandHandler / GitHandler: zero tests today.** Priority cases: range
  clamping, strReplace overlap (2.8), truncation boundary (2.4), timeout group-kill (2.3),
  git status rename/detached-HEAD parsing.
- **RPC dispatch**: numeric id (2.2), method-not-found, handler-throw → -32000,
  virtualize round-trip through `_handleMessage`.
- Watch batching (2.5); URL normalization utility (4b) — pure functions, trivial to test.
- Wire `tray-app` tests into an explicit test script + CI (1.9, 0.6).

---

## Suggested execution order

1. **Week 1 — stop the bleeding:** 0.1 (unbreak lint), 1.1 (reconnect), 1.2 (lifecycle
   race), 1.3 (secret redaction), 2.2 (crash-on-numeric-id). Rebuild + redeploy bundle,
   rebuild tray installers. This alone should transform the tray app's reliability.
2. **Week 2 — tray UX + WSL:** 1.4–1.7, 2.1, 2.3, 2.4.
3. **Week 3 — security:** 3.1–3.6 (containment mode first).
4. **Week 4+ —** extension fixes (Phase 4), standalone (4b), then harness-inspired
   enhancements (Phase 5) as capacity allows, with Phase 6 tests landing alongside each fix.

## What's already good (don't regress)

- Path-virtualization design (field-allowlist translation at the RPC boundary) + its test
  suite — the strongest code in the repo.
- Application-level JSON heartbeat (proxy-safe) with documented rationale.
- Args-array spawning (no shell) for git, `GIT_TERMINAL_PROMPT=0` hang prevention,
  `settled`-guard pattern in spawn wrappers.
- Tray secret encryption via `safeStorage`; SEA pipeline with post-build export/method
  verification (`esbuild-standalone.mjs:124-177`) — keep the drift guard.
- Eager FS-provider registration + `setRpcClient` swap in the extension — extend it, don't
  replace it.
