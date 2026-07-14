# Workspace Service

A lightweight Node.js CLI that bridges your local development files to a remote [tools-service](../tools-service) backend via WebSocket. This enables AI-assisted coding regardless of where the backend is deployed (Docker, NAS, cloud).

## Architecture

```
Your Machine                                Remote Backend
┌──────────────────────┐    WebSocket      ┌────────────────────────┐
│  workspace-service   │ ──────────────→   │  tools-service:5590    │
│                      │                   │                        │
│  Exposes:            │  ← RPC request    │  Routes file/git/shell │
│  /home/you/projects  │  → RPC response   │  to the right agent    │
└──────────────────────┘                   └────────────────────────┘
```

## Quick Start

```bash
# Install dependencies
npm install

# Connect to a remote backend
node dist/bin/workspace-service.js \
  --backend ws://192.168.86.2:5590 \
  --workspace /home/you/projects \
  --secret your-api-secret

# Or with multiple workspaces
node dist/bin/workspace-service.js \
  -b ws://your-nas:5590 \
  -w /home/you/project-a \
  -w /home/you/project-b \
  -s your-api-secret
```

## Running Locally (WSL / Bare Node)

If you're developing on a local machine (e.g. WSL2, Linux, macOS), you can run workspace-service directly with Node — no Docker required. This gives you native filesystem performance and full access to your local toolchain (git, npm, eslint, etc.).

### 1. Install dependencies

```bash
cd ~/development/workspace-service
npm install
```

### 2. Configure (optional)

Secrets are resolved from vault-service automatically. If you need local
overrides (e.g. a different `WORKSPACE_ROOTS`), create a `.env`:

```env
WORKSPACE_ROOTS=/home/you/development
```

### 3. Start the service

```bash
# Recommended — loads .env automatically with file-watch reload
npm run dev:local
```

You should see output like:

```
[18:31:22] INFO  [workspace] Workspace Service
[18:31:22] INFO  [workspace] Name ............. YOUR-HOSTNAME
[18:31:22] INFO  [workspace] Backend .......... ws://192.168.86.2:5590/ws/agent
[18:31:22] INFO  [workspace] Workspaces ....... /home/you/development
[18:31:22] INFO  [workspace] Reconnect ........ 5000ms
[18:31:22] INFO  [workspace] Health ........... :5605/health
[18:31:22] INFO  [workspace] Auth ............. secret configured
[18:31:22] OK    [workspace] Connected to ws://192.168.86.2:5590/ws/agent
[18:31:22] INFO  [workspace] Registered agent "YOUR-HOSTNAME" with 1 root(s)
[18:31:22] OK    [workspace] Server confirmed registration
```

### Alternative: inline env vars

If you prefer not to create a `.env` file, you can pass env vars inline:

```bash
WORKSPACE_BACKEND=ws://192.168.86.2:5590 \
WORKSPACE_ROOTS=/home/you/development \
WORKSPACE_SERVICE_SECRET=your-secret \
npm run dev
```

### Alternative: CLI flags

```bash
node dist/bin/workspace-service.js \
  --backend ws://192.168.86.2:5590 \
  --workspace /home/you/development \
  --secret your-agent-secret
```

> **Tip:** You can run multiple workspace-service instances simultaneously (e.g. one on a NAS, one in WSL). Each registers with a unique `agentId` and the tools-service routes operations to whichever agent owns the requested path.

### Docker vs. Bare Node

| Concern | Docker (NAS / server) | Bare Node (local) |
|---|---|---|
| **Filesystem** | Volume-mounted `/workspace` | Direct access — no mount overhead |
| **Performance** | Container + NAS I/O | Native filesystem — faster grep, glob, git |
| **Git / Shell** | Must be installed in the container | Uses your host environment directly |
| **Use case** | Headless servers, Synology, always-on | Local development, WSL2, workstations |

## Standalone Agent (Windows / macOS / Linux)

The standalone agent is a **Single Executable Application (SEA)** — a self-contained binary with Node.js and the agent code baked in. No Node.js installation required on the target machine.

### Downloading

The tools-service compiles and serves the standalone binary on demand:

```
GET https://api.tools.rod.dev/agents/download/agent?platform=<platform>
```

| Platform | Value | Output |
|---|---|---|
| Windows x64 | `win-x64` | `workspace-agent.exe` |
| Linux x64 | `linux-x64` | `workspace-agent` |
| macOS x64 | `mac-x64` | `workspace-agent` |
| macOS ARM | `mac-arm64` | `workspace-agent` |

Example:

```bash
# Download the Windows binary
curl -o workspace-agent.exe "https://api.tools.rod.dev/agents/download/agent?platform=win-x64"
```

> **Note:** The backend URL and API secret are pre-baked into the binary at compile time. No manual configuration of those values is needed.

### First Run

On first launch, the agent runs an interactive **setup wizard** that asks for:

1. **Workspace directory** — the local path to expose (e.g. `C:\workspace`)

The wizard saves your choices to a persistent config file:

| OS | Config File |
|---|---|
| Windows | `C:\Users\<username>\.prism-workspace-agent.json` |
| macOS / Linux | `~/.prism-workspace-agent.json` |

On subsequent launches, the agent reads from this file automatically — no re-prompting.

### Reconfiguring

To re-run the wizard or change settings:

- **Delete the config file** and relaunch
- **Edit the JSON directly:**
  ```json
  {
    "backend": "wss://api.tools.rod.dev",
    "secret": "your-api-secret",
    "workspace": ["C:\\workspace"]
  }
  ```

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Opens and closes immediately | Unhandled error before the pause-on-exit handler | Run from a terminal (`cmd` or PowerShell) to see the error output |
| `WebSocket error: connection failed` | Reverse proxy not forwarding WebSocket upgrades | See [Reverse Proxy Configuration](#reverse-proxy-configuration) below |
| Doesn't ask for settings on relaunch | Config was saved from a previous wizard run | Delete `~/.prism-workspace-agent.json` to reset |

---

## Reverse Proxy Configuration

The workspace agent connects to `wss://api.tools.rod.dev/ws/agent` via WebSocket. If the tools-service sits behind a reverse proxy (nginx, Synology DSM, Caddy, etc.), the proxy **must** be configured to forward WebSocket upgrade headers. Without this, the proxy strips the `Upgrade` and `Connection` hop-by-hop headers (especially over HTTP/2) and the connection fails with code `1006`.

### Synology DSM

1. Open **Control Panel → Login Portal → Advanced → Reverse Proxy**
2. Select the `api.tools.rod.dev` rule → **Edit**
3. Go to the **Custom Header** tab
4. Click **Create → WebSocket** (adds both headers automatically), or add manually:

| Header Name | Value |
|---|---|
| `Upgrade` | `$http_upgrade` |
| `Connection` | `$connection_upgrade` |

5. Click **Save**

### Raw nginx

Add or update the `location` block for the WebSocket path:

```nginx
location /ws/ {
    proxy_pass http://127.0.0.1:5590;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
}
```

Key directives:

| Directive | Why |
|---|---|
| `proxy_http_version 1.1` | WebSocket upgrade requires HTTP/1.1 between nginx and the backend (HTTP/2 strips hop-by-hop headers) |
| `proxy_set_header Upgrade` | Forwards the client's `Upgrade: websocket` header to the backend |
| `proxy_set_header Connection "upgrade"` | Tells the backend this is an upgrade request |
| `proxy_read_timeout 86400s` | Prevents nginx from closing idle WebSocket connections (default is 60s) |

### Caddy

Caddy handles WebSocket upgrades automatically — no extra configuration needed.

### Verifying

Test the WebSocket handshake from any machine:

```bash
curl -v \
  -H "Upgrade: websocket" \
  -H "Connection: Upgrade" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  "https://api.tools.rod.dev/ws/agent" 2>&1 | grep "HTTP/"
```

- ✅ **`HTTP/1.1 101 Switching Protocols`** — WebSocket upgrade successful
- ❌ **`HTTP/2 404`** — proxy is using HTTP/2 and stripping upgrade headers (fix: add `proxy_http_version 1.1`)
- ❌ **`HTTP/1.1 401`** — secret mismatch

---

## CLI Options

| Flag | Short | Required | Description |
|------|-------|----------|-------------|
| `--backend <url>` | `-b` | ✅ | WebSocket URL of tools-service |
| `--workspace <path>` | `-w` | ✅ | Local directory root(s) to expose (repeatable) |
| `--secret <secret>` | `-s` | ❌ | API secret (or `WORKSPACE_SERVICE_SECRET` env var) |
| `--name <name>` | `-n` | ❌ | Agent display name (defaults to hostname) |
| `--reconnect-interval <ms>` | `-r` | ❌ | Base reconnect delay (default: 5000) |

## Environment Variables

| Variable | Description |
|---|---|
| `WORKSPACE_BACKEND` | WebSocket URL of the tools-service backend (auto-converts `http://` → `ws://`) |
| `WORKSPACE_ROOTS` | Comma-separated workspace root directories to expose |
| `WORKSPACE_SERVICE_SECRET` | API secret for authenticating with tools-service |
| `WORKSPACE_CONTAINMENT` | `on`/`off` — restrict file/git/watch operations to the workspace roots. Defaults to **on** outside Docker (tray app, standalone, bare Node) and **off** inside Docker, where the container is the jail |
| `DEBUG` | Set to `1` to enable debug logging |

## Protocol

Uses JSON-RPC 2.0 over WebSocket. The agent responds to the following RPC methods:

### File Operations
- `file.read` — Read file with optional line range
- `file.write` — Create or overwrite a file
- `file.strReplace` — Targeted string replacement
- `file.patch` — Apply unified diff
- `file.info` — Stat one or more files
- `file.diff` — Diff two files
- `file.move` — Move/rename file
- `file.delete` — Delete file
- `file.readMulti` — Batch read multiple files

### Directory & Search
- `directory.list` — List directory contents
- `search.grep` — Pattern search across files
- `search.glob` — Find files by glob pattern

### Git
- `git.status` — Repository status
- `git.diff` — Git diff output
- `git.log` — Commit history

### Commands
- `command.run` — Execute allowlisted shell command
- `command.stream` — Execute with streaming output

### Project
- `project.summary` — Directory tree analysis

## Security

- **Path containment**: On host installs (tray app, standalone binary, bare Node), file/git/watch operations are restricted to the registered workspace roots (`WORKSPACE_CONTAINMENT`, default on). Inside Docker the container itself is the jail and containment defaults to off.
- **Command execution**: `command.run` is unrestricted by design — on Docker the container is the boundary; on host installs treat the backend as trusted (it can run shell commands as your user).
- **Secret env stripping**: `command.run` children never inherit credential-shaped env vars (`MONGO_URI`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`, `*_API_KEY`, …)
- **Auth**: WebSocket connection authenticates with `x-api-secret` header; a 401 latches with an explicit `auth-failed` state instead of retry-looping

## Scripts

```bash
npm run start         # Start the workspace agent
npm run dev           # Start with auto-reload (--watch)
npm run dev:local     # Start with auto-reload, loading .env automatically
npm run lint          # Run ESLint
npm run lint:fix      # Auto-fix lint issues
npm run format        # Format with Prettier
npm run format:check  # Check formatting
npm run deploy        # Deploy to production
npm run deploy:dry    # Validate deployment without deploying
```

