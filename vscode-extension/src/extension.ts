// ─── Workspace Remote Extension ─────────────────────────────
// Registers the workspace:// FileSystemProvider, search commands,
// and terminal profile — giving VS Code full access to remote
// workspaces served by workspace-service via tools-service.

import * as vscode from "vscode";
import { RpcClient } from "./RpcClient.js";
import { WorkspaceFileSystem } from "./WorkspaceFileSystem.js";
import { registerSearchCommands } from "./WorkspaceSearch.js";
import { WorkspaceTerminalProvider } from "./WorkspaceTerminal.js";

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

interface AgentInfo {
  id: string;
  name: string;
  roots: string[];
  capabilities: string[];
  clientIp: string;
  connectedAt: string;
}

// ────────────────────────────────────────────────────────────
// State
// ────────────────────────────────────────────────────────────

let rpcClient: RpcClient | null = null;
let statusBarItem: vscode.StatusBarItem;
let fileSystem: WorkspaceFileSystem | null = null;

// ────────────────────────────────────────────────────────────
// Activation
// ────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  // Status bar indicator
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  statusBarItem.command = "workspace.connect";
  statusBarItem.text = "$(plug) Workspace: Disconnected";
  statusBarItem.tooltip = "Click to connect to a remote workspace";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Register the filesystem provider eagerly so workspace:// URIs always resolve.
  // On first activation it's backed by a dummy RPC — connect() swaps in the real one.
  const dummyRpc = new RpcClient("ws://localhost:0", "");
  fileSystem = new WorkspaceFileSystem(dummyRpc);

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(
      WorkspaceFileSystem.scheme,
      fileSystem,
      { isCaseSensitive: true },
    ),
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("workspace.connect", () => connectWorkspace(context)),
    vscode.commands.registerCommand("workspace.disconnect", disconnectWorkspace),
  );

  // Handle external URI activation (e.g. from "Open in VS Code" button)
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri): void {
        handleExternalUri(uri, context);
      },
    }),
  );

  // Auto-connect if we already have a workspace:// folder
  const remoteFolder = vscode.workspace.workspaceFolders?.find(
    (f) => f.uri.scheme === WorkspaceFileSystem.scheme,
  );
  if (remoteFolder) {
    const config = vscode.workspace.getConfiguration("workspaceRemote");
    const backendUrl = config.get<string>("backendUrl");
    if (backendUrl) {
      const secret = config.get<string>("apiSecret") || "";
      _connect(backendUrl, secret, remoteFolder.uri.path, remoteFolder.name, context);
    }
  }
}

export function deactivate(): void {
  if (rpcClient) {
    rpcClient.disconnect();
    rpcClient = null;
  }
}

// ────────────────────────────────────────────────────────────
// Connect Flow
// ────────────────────────────────────────────────────────────

async function connectWorkspace(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration("workspaceRemote");
  let backendUrl = config.get<string>("backendUrl") || "";

  if (!backendUrl) {
    backendUrl = await vscode.window.showInputBox({
      prompt: "Enter the tools-service URL",
      placeHolder: "ws://192.168.86.2:5590",
      value: "ws://192.168.86.2:5590",
    }) || "";
  }

  if (!backendUrl) return;

  let secret = config.get<string>("apiSecret") || "";
  if (!secret) {
    secret = await vscode.window.showInputBox({
      prompt: "Enter the API secret (leave blank if none)",
      password: true,
    }) || "";
  }

  // Persist settings
  await config.update("backendUrl", backendUrl, vscode.ConfigurationTarget.Global);

  // Discover available agents
  statusBarItem.text = "$(sync~spin) Discovering agents…";

  let wsUrl = backendUrl;
  if (wsUrl.startsWith("http://")) wsUrl = wsUrl.replace("http://", "ws://");
  if (wsUrl.startsWith("https://")) wsUrl = wsUrl.replace("https://", "wss://");
  if (!wsUrl.includes("/ws/workspace")) {
    wsUrl = wsUrl.replace(/\/+$/, "").replace(/\/ws\/.*$/, "") + "/ws/workspace";
  }

  // Temporarily connect to discover agents
  const tempClient = new RpcClient(wsUrl, secret);

  const agentsPromise = new Promise<AgentInfo[]>((resolve) => {
    let resolved = false;

    tempClient.connect({
      onConnected: async () => {
        try {
          const agents = await tempClient.call<AgentInfo[]>("agents.list");
          resolved = true;
          resolve(agents || []);
        } catch {
          resolved = true;
          resolve([]);
        }
      },
      onDisconnected: () => {
        if (!resolved) {
          resolved = true;
          resolve([]);
        }
      },
    });

    // Timeout after 5s
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve([]);
      }
    }, 5000);
  });

  const agents = await agentsPromise;
  tempClient.disconnect();

  if (agents.length === 0) {
    statusBarItem.text = "$(plug) Workspace: Disconnected";
    vscode.window.showWarningMessage("No workspace agents found. Is workspace-service running?");
    return;
  }

  // Build picker items — one per root per agent
  interface WorkspacePickItem extends vscode.QuickPickItem {
    agentName: string;
    root: string;
    clientIp: string;
  }

  const items: WorkspacePickItem[] = [];
  for (const agent of agents) {
    for (const root of agent.roots) {
      const shortRoot = root.split("/").pop() || root;
      items.push({
        label: `$(server) ${agent.name}`,
        description: root,
        detail: `${agent.clientIp} · ${agent.capabilities.join(", ")}`,
        agentName: agent.name,
        root,
        clientIp: agent.clientIp,
      });
    }
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: "Select a remote workspace to open",
    title: "Workspace Remote — Connect",
  });

  if (!selected) {
    statusBarItem.text = "$(plug) Workspace: Disconnected";
    return;
  }

  const folderLabel = `${selected.agentName}: ${selected.root.split("/").pop()}`;
  _connect(backendUrl, secret, selected.root, folderLabel, context);
}

function _connect(
  backendUrl: string,
  secret: string,
  workspaceRoot: string,
  folderLabel: string,
  context: vscode.ExtensionContext,
): void {
  // Disconnect existing connection
  if (rpcClient) {
    rpcClient.disconnect();
  }

  // Normalize WebSocket URL — connect to the client proxy endpoint
  let wsUrl = backendUrl;
  if (wsUrl.startsWith("http://")) wsUrl = wsUrl.replace("http://", "ws://");
  if (wsUrl.startsWith("https://")) wsUrl = wsUrl.replace("https://", "wss://");
  if (!wsUrl.includes("/ws/workspace")) {
    wsUrl = wsUrl.replace(/\/+$/, "").replace(/\/ws\/.*$/, "") + "/ws/workspace";
  }

  rpcClient = new RpcClient(wsUrl, secret);

  // Swap in the real RPC-backed filesystem provider
  fileSystem = new WorkspaceFileSystem(rpcClient);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(
      WorkspaceFileSystem.scheme,
      fileSystem,
      { isCaseSensitive: true },
    ),
  );

  rpcClient.connect({
    onConnected: () => {
      statusBarItem.text = `$(check) ${folderLabel}`;
      statusBarItem.tooltip = `Connected to ${backendUrl}\nWorkspace: ${workspaceRoot}`;
      statusBarItem.backgroundColor = undefined;

      vscode.window.showInformationMessage(`Connected to ${folderLabel}`);

      // Register search commands (QuickPick file search + grep)
      registerSearchCommands(context, rpcClient!, workspaceRoot);

      // Register terminal profile
      context.subscriptions.push(
        vscode.window.registerTerminalProfileProvider(
          "workspace.remoteTerminal",
          new WorkspaceTerminalProvider(rpcClient!, workspaceRoot),
        ),
      );

      // Add workspace folder if not already present
      const alreadyOpen = vscode.workspace.workspaceFolders?.some(
        (f) => f.uri.scheme === WorkspaceFileSystem.scheme && f.uri.path === workspaceRoot,
      );

      if (!alreadyOpen) {
        vscode.workspace.updateWorkspaceFolders(
          vscode.workspace.workspaceFolders?.length ?? 0,
          0,
          {
            uri: vscode.Uri.from({ scheme: WorkspaceFileSystem.scheme, path: workspaceRoot }),
            name: folderLabel,
          },
        );
      }
    },

    onDisconnected: () => {
      statusBarItem.text = "$(plug) Workspace: Disconnected";
      statusBarItem.tooltip = "Click to reconnect";
      statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    },

    onNotification: (method, params) => {
      if (method === "watch.changed" && fileSystem) {
        const { watchRoot, filename, eventType } = params as {
          watchRoot: string;
          filename: string | null;
          eventType: string;
        };
        fileSystem.fireExternalChange(watchRoot, filename, eventType);
      }
    },
  });
}

// ────────────────────────────────────────────────────────────
// Disconnect
// ────────────────────────────────────────────────────────────

function disconnectWorkspace(): void {
  if (rpcClient) {
    rpcClient.disconnect();
    rpcClient = null;
  }

  statusBarItem.text = "$(plug) Workspace: Disconnected";
  statusBarItem.tooltip = "Click to connect to a remote workspace";
  statusBarItem.backgroundColor = undefined;

  vscode.window.showInformationMessage("Disconnected from remote workspace");
}

// ────────────────────────────────────────────────────────────
// External URI Handler
// ────────────────────────────────────────────────────────────
// Handles URIs like:
//   vscode://rodrigo-barraza.workspace-remote/open?backend=ws://host:5590&workspace=/path&secret=xxx

function handleExternalUri(uri: vscode.Uri, context: vscode.ExtensionContext): void {
  const params = new URLSearchParams(uri.query);
  const backend = params.get("backend");
  const workspace = params.get("workspace");
  const secret = params.get("secret") || "";
  const label = params.get("label") || `Remote: ${workspace?.split("/").pop()}`;

  if (!backend || !workspace) {
    vscode.window.showErrorMessage("Invalid URI — missing backend or workspace parameter");
    return;
  }

  _connect(backend, secret, workspace, label, context);
}
