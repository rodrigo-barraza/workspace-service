# Workspace Remote — VS Code Extension

Connect VS Code to remote workspaces served by workspace-service agents over WebSocket. Your files live on a remote machine (NAS, cloud, Docker), but VS Code works with them as if they were local.

## Architecture

```
Your Machine                           Remote Backend
┌──────────────────────────────┐       ┌────────────────────────────────┐
│  VS Code                     │       │  tools-service (:5590)         │
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

## Quick Start

### 1. Install the Extension

```bash
cd workspace-service/vscode-extension
npm install
npm run compile
npm run package
code --install-extension workspace-remote-0.1.0.vsix
```

### 2. Connect to a Workspace

1. Open VS Code
2. `Ctrl+Shift+P` → **Workspace Remote: Connect**
3. Enter the tools-service URL (e.g. `ws://192.168.86.2:5590`)
4. Enter the API secret (if required)
5. Pick a device and workspace root from the discovered agents

### 3. Open via Deep Link

Generate a URI from your client app:

```
vscode://rodrigo-barraza.workspace-remote/open?backend=ws://192.168.86.2:5590&workspace=/home/rodrigo/development
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

## Development

```bash
npm install
npm run compile    # one-shot
npm run watch      # auto-compile on save
npm run package    # build .vsix
```

To debug: open this folder in VS Code, press `F5` to launch the Extension Development Host.
