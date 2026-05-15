# Workspace Remote — VS Code Extension

Connect VS Code (or Antigravity) to remote workspaces served by workspace-service agents over WebSocket. Your files live on a remote machine (NAS, cloud, Docker), but VS Code works with them as if they were local.

## Architecture

```
Your Machine                           Remote Backend
┌──────────────────────────────┐       ┌────────────────────────────────┐
│  VS Code / Antigravity       │       │  tools-service (:5590)         │
│  ┌────────────────────────┐  │  WS   │  ┌──────────────────────────┐  │
│  │  workspace-remote ext  │──┼───────┼─→│ AgentConnectionManager   │  │
│  │                        │  │       │  │ /ws/workspace (proxy)    │  │
│  │  FileSystemProvider    │  │       │  └──────────┬───────────────┘  │
│  │  TerminalProvider      │  │       │             │ JSON-RPC          │
│  │  Search Commands       │  │       │  ┌──────────▼───────────────┐  │
│  └────────────────────────┘  │       │  │  workspace-service       │  │
│                              │       │  │  (local filesystem)      │  │
│  Explorer, Editor, Terminal  │       │  └──────────────────────────┘  │
└──────────────────────────────┘       └────────────────────────────────┘
```

Supports multiple workspace-service instances across different devices — the connect flow discovers all available agents and lets you pick which one to open.

## Features

- **File Explorer** — Browse, create, rename, delete files/directories
- **Editor** — Open and edit files (text + binary) with full syntax highlighting
- **Search** — File search (Quick Open) and text search (grep) across the remote workspace
- **Terminal** — Run shell commands on the remote machine
- **Multi-Device** — Discover and connect to any workspace-service agent
- **File Watching** — Real-time updates when files change on the remote side
- **Auto-Reconnect** — Exponential backoff reconnection on network interruption
- **URI Handler** — Open workspaces from external apps via deep link

## Installation

### 1. Build the Extension

```bash
cd workspace-service/vscode-extension
npm install
npm run compile
npm run package
```

This produces `workspace-remote-0.1.0.vsix` in the extension directory.

### 2. Install the Extension

> **Important:** The extension must be installed on the **desktop (UI host)** side, not the
> remote/WSL side. If you're developing inside WSL, copy the `.vsix` to a Windows-accessible
> path first.

#### Standard VS Code

```bash
# From the machine where VS Code runs (e.g. PowerShell on Windows):
code --install-extension workspace-remote-0.1.0.vsix
```

#### Antigravity (Google's VS Code Fork)

Antigravity uses its own extension directory, separate from VS Code. You must use the
`antigravity` CLI instead of `code`:

```bash
# From PowerShell on Windows:
antigravity --install-extension workspace-remote-0.1.0.vsix
```

#### WSL Users (Windows + WSL2)

When working from WSL, the `code` / `antigravity` CLI routes through the remote server and
may fail to resolve Linux paths. Copy the `.vsix` to a Windows path first:

```bash
# In WSL — copy to Desktop
cp ~/development/workspace-service/vscode-extension/workspace-remote-0.1.0.vsix \
   /mnt/c/Users/<your-username>/Desktop/

# In PowerShell — install from the Windows path
# For VS Code:
code --install-extension C:\Users\<your-username>\Desktop\workspace-remote-0.1.0.vsix

# For Antigravity:
antigravity --install-extension C:\Users\<your-username>\Desktop\workspace-remote-0.1.0.vsix
```

### 3. Reload

After installing, reload the window: `Ctrl+Shift+P` → **Developer: Reload Window**

## Connecting to a Remote Workspace

### Prerequisites

- **tools-service** must be running with the `/ws/workspace` proxy endpoint
- **workspace-service** must be running on the remote machine and connected to tools-service
- The tools-service URL must be reachable from the machine running VS Code (not just from WSL)

### Connect

1. `Ctrl+Shift+P` → **Workspace Remote: Connect**
2. Enter the tools-service URL (e.g. `ws://192.168.86.2:5590`)
3. Enter the API secret (if required)
4. Pick a device and workspace root from the discovered agents

The status bar shows the connection state:
- `$(plug) Workspace: Disconnected` — not connected
- `$(sync~spin) Discovering agents…` — searching for workspace-service agents
- `$(check) synology-nas: development` — connected (agent name + workspace root)

### Open via Deep Link

Generate a URI from your client app:

```
vscode://rodrigo-barraza.workspace-remote/open?backend=ws://192.168.86.2:5590&workspace=/home/rodrigo/development&label=NAS
```

VS Code will auto-launch and connect.

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| `workspaceRemote.backendUrl` | WebSocket URL of tools-service | `""` |
| `workspaceRemote.apiSecret` | API secret for authentication | `""` |

## Commands

| Command | Description |
|---------|-------------|
| `Workspace Remote: Connect` | Discover agents and open a remote workspace |
| `Workspace Remote: Disconnect` | Disconnect from the current workspace |
| `Workspace Remote: Search Files` | Quick Open-style file search |
| `Workspace Remote: Search Text (Grep)` | Full-text search across files |

## Protocol

The extension communicates with tools-service using **JSON-RPC 2.0 over WebSocket** on the `/ws/workspace` endpoint. All file operations are routed through the `AgentConnectionManager`, which dispatches to the correct workspace-service agent based on the file path.

### Supported RPC Methods

| Method | Description |
|--------|-------------|
| `agents.list` | Discover connected workspace-service agents |
| `file.read` | Read file contents (text or binary via base64) |
| `file.write` | Write file contents |
| `file.info` | Stat a file or directory |
| `file.move` | Rename or move a file |
| `file.delete` | Delete a file |
| `directory.list` | List directory contents |
| `directory.create` | Create a directory (recursive) |
| `search.glob` | Search files by name pattern |
| `search.grep` | Full-text search across files |
| `command.run` | Execute a shell command on the remote machine |
| `watch.subscribe` | Subscribe to file-system change notifications |
| `watch.unsubscribe` | Unsubscribe from change notifications |

## Development

```bash
npm install
npm run compile    # one-shot
npm run watch      # auto-compile on save
npm run package    # build .vsix
```

To debug: open this folder in VS Code, press `F5` to launch the Extension Development Host.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Commands don't appear | Extension installed on wrong host | Use `antigravity` CLI for Antigravity, `code` for VS Code |
| Commands don't appear (WSL) | Extension installed in WSL server | Copy `.vsix` to Windows path and install from PowerShell |
| "provider already registered" | Extension re-registers on reconnect | Update to latest version (fixed in 0.1.0+) |
| "No workspace agents found" | workspace-service not connected | Verify workspace-service is running and connected to tools-service |
| Connection refused | tools-service unreachable from desktop | Ensure the URL is reachable from Windows, not just WSL |
