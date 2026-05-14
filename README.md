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
node bin/workspace-service.js \
  --backend ws://192.168.86.2:5590 \
  --workspace /home/you/projects \
  --secret your-api-secret

# Or with multiple workspaces
node bin/workspace-service.js \
  -b ws://your-nas:5590 \
  -w /home/you/project-a \
  -w /home/you/project-b \
  -s your-api-secret
```

## Running Locally (WSL / Bare Node)

If you're developing on a local machine (e.g. WSL2, Linux, macOS), you can run workspace-service directly with Node — no Docker required. This gives you native filesystem performance and full access to your local toolchain (git, npm, eslint, etc.).

```bash
# Install dependencies (one time)
cd ~/development/workspace-service
npm install

# Run with CLI flags
node bin/workspace-service.js \
  --backend ws://192.168.86.2:5590 \
  --workspace /home/you/development \
  --secret your-agent-secret

# Or run with env vars + auto-reload on file changes
WORKSPACE_BACKEND=ws://192.168.86.2:5590 \
WORKSPACE_ROOTS=/home/you/development \
WORKSPACE_SERVICE_SECRET=your-secret \
npm run dev
```

> **Tip:** You can run multiple workspace-service instances simultaneously (e.g. one on a NAS, one in WSL). Each registers with a unique `agentId` and the tools-service routes operations to whichever agent owns the requested path.

### Docker vs. Bare Node

| Concern | Docker (NAS / server) | Bare Node (local) |
|---|---|---|
| **Filesystem** | Volume-mounted `/workspace` | Direct access — no mount overhead |
| **Performance** | Container + NAS I/O | Native filesystem — faster grep, glob, git |
| **Git / Shell** | Must be installed in the container | Uses your host environment directly |
| **Use case** | Headless servers, Synology, always-on | Local development, WSL2, workstations |

## CLI Options

| Flag | Short | Required | Description |
|------|-------|----------|-------------|
| `--backend <url>` | `-b` | ✅ | WebSocket URL of tools-service |
| `--workspace <path>` | `-w` | ✅ | Local directory root(s) to expose (repeatable) |
| `--secret <secret>` | `-s` | ❌ | API secret (or `WORKSPACE_SERVICE_SECRET` env var) |
| `--name <name>` | `-n` | ❌ | Agent display name (defaults to hostname) |
| `--reconnect-interval <ms>` | `-r` | ❌ | Base reconnect delay (default: 5000) |

## Environment Variables

```bash
WORKSPACE_SERVICE_SECRET=your-api-secret  # Alternative to --secret flag
DEBUG=1                                   # Enable debug logging
```

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

- **Path sandbox**: All file operations are restricted to the registered workspace roots
- **Command allowlist**: Only project-safe commands (`npm`, `git`, `eslint`, etc.) are permitted
- **Blocked patterns**: `.env`, private keys, `node_modules/.git/objects` are always blocked
- **Auth**: WebSocket connection authenticates with `x-api-secret` header

## Scripts

```bash
npm run start         # Start the workspace agent
npm run dev           # Start with auto-reload (--watch)
npm run lint          # Run ESLint
npm run lint:fix      # Auto-fix lint issues
npm run format        # Format with Prettier
npm run format:check  # Check formatting
npm run deploy        # Deploy to production
npm run deploy:dry    # Validate deployment without deploying
```

