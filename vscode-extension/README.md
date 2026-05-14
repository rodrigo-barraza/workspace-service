# Prism Remote Workspace — VS Code Extension

A VS Code extension that opens remote workspaces served by [workspace-service](../workspace-service) through the `prism://` URI scheme. Your files live on a remote machine (NAS, cloud, Docker), but VS Code works with them as if they were local.

## Architecture

```
Your Machine                           Remote Backend
┌──────────────────────────────┐       ┌────────────────────────────────┐
│  VS Code                     │       │  tools-service (:5590)         │
│  ┌────────────────────────┐  │  WS   │  ┌──────────────────────────┐  │
│  │  prism-vscode extension│──┼───────┼─→│ AgentConnectionManager   │  │
│  │                        │  │       │  │ (routes by path → agent) │  │
│  │  FileSystemProvider    │  │       │  └──────────┬───────────────┘  │
│  │  TerminalProvider      │  │       │             │ JSON-RPC          │
│  │  Search Commands       │  │       │  ┌──────────▼───────────────┐  │
│  └────────────────────────┘  │       │  │  workspace-service       │  │
│                              │       │  │  (local filesystem)      │  │
│  Explorer, Editor, Terminal  │       │  └──────────────────────────┘  │
└──────────────────────────────┘       └────────────────────────────────┘
```

## Features

- **File Explorer** — Browse, create, rename, delete files/directories
- **Editor** — Open and edit files (text + binary) with full syntax highlighting
- **Search** — File search (Quick Open) and text search (grep) across the remote workspace
- **Terminal** — Run shell commands on the remote machine
- **File Watching** — Real-time updates when files change on the remote side
- **Auto-Reconnect** — Exponential backoff reconnection on network interruption
- **URI Handler** — Open workspaces from external apps (e.g. Prism client's "Open in VS Code" button)

## Quick Start

### 1. Install the Extension

```bash
cd prism-vscode
npm install
npm run compile
npx @vscode/vsce package --no-dependencies
code --install-extension prism-remote-workspace-0.1.0.vsix
```

### 2. Connect to a Workspace

1. Open VS Code
2. Press `Ctrl+Shift+P` → **Prism: Connect to Remote Workspace**
3. Enter the tools-service WebSocket URL (e.g. `ws://192.168.86.2:5590`)
4. Enter the API secret (if required)
5. Enter the remote workspace root path (e.g. `/home/rodrigo/development`)

### 3. Open from Prism Client

If your prism-client has an "Open in VS Code" button, it generates a URI like:

```
vscode://rodrigo-barraza.prism-remote-workspace/open?backend=ws://192.168.86.2:5590&workspace=/home/rodrigo/development&secret=xxx
```

VS Code will auto-launch and connect.

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| `prism.backendUrl` | WebSocket URL of tools-service | `""` |
| `prism.apiSecret` | API secret for authentication | `""` |

## Commands

| Command | Description |
|---------|-------------|
| `Prism: Connect to Remote Workspace` | Connect and open a remote workspace |
| `Prism: Disconnect Remote Workspace` | Disconnect from the current workspace |
| `Prism: Search Files (Remote)` | Quick Open-style file search |
| `Prism: Search Text (Remote Grep)` | Full-text search across files |

## Protocol

The extension communicates with tools-service using **JSON-RPC 2.0 over WebSocket** — the same protocol used by workspace-service. All file operations are routed through the `AgentConnectionManager`, which dispatches to the correct workspace-service agent based on the file path.

## Development

```bash
# Install dependencies
npm install

# Compile (one-shot)
npm run compile

# Watch mode (auto-compile on save)
npm run watch

# Package as .vsix
npm run package
```

To debug: open this folder in VS Code, press `F5` to launch the Extension Development Host.
