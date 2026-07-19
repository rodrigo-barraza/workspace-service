// ─── Workspace Remote Extension ─────────────────────────────
// Registers the workspace:// FileSystemProvider, search commands,
// and terminal profile — giving VS Code full access to remote
// workspaces served by workspace-service via tools-service.

import * as vscode from "vscode";
import { RpcClient, RpcConnectionHolder } from "./RpcClient.js";
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

interface WatchChangedEvent {
  eventType: string;
  filename: string | null;
}

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

// SecretStorage key for the API secret — never persisted to settings
const SECRET_STORAGE_KEY = "workspaceRemote.apiSecret";

// ────────────────────────────────────────────────────────────
// State
// ────────────────────────────────────────────────────────────

let rpcClient: RpcClient | null = null;
let statusBarItem: vscode.StatusBarItem;
let fileSystem: WorkspaceFileSystem | null = null;

// Mutable holder read by the search commands and terminal profile provider
// (registered once at activation) — connect/reconnect swaps its contents,
// mirroring the WorkspaceFileSystem.setRpcClient pattern.
let connectionHolder: RpcConnectionHolder | null = null;

// ────────────────────────────────────────────────────────────
// URL Normalization
// ────────────────────────────────────────────────────────────

/**
 * Convert an http(s) backend URL to ws(s) and append the /ws/workspace
 * proxy endpoint unless the URL already ends with it.
 */
function normalizeWebSocketUrl(backendUrl: string): string {
  let websocketUrl = backendUrl;
  if (websocketUrl.startsWith("http://")) websocketUrl = websocketUrl.replace("http://", "ws://");
  if (websocketUrl.startsWith("https://")) websocketUrl = websocketUrl.replace("https://", "wss://");
  if (!/\/ws\/workspace\/?$/.test(websocketUrl)) {
    websocketUrl = websocketUrl.replace(/\/+$/, "") + "/ws/workspace";
  }
  return websocketUrl;
}

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
  connectionHolder = { rpc: dummyRpc, workspaceRoot: "" };

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

  // Register search commands and the terminal profile provider ONCE —
  // re-registering on every socket open throws "command already exists".
  // They read the current connection through the mutable holder.
  registerSearchCommands(context, connectionHolder);
  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider(
      "workspace.remoteTerminal",
      new WorkspaceTerminalProvider(connectionHolder),
    ),
  );

  // Handle external URI activation (e.g. from "Open in VS Code" button)
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri): void {
        void handleExternalUri(uri, context);
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
      // SecretStorage first, falling back to the (legacy) apiSecret setting
      void context.secrets.get(SECRET_STORAGE_KEY).then((storedSecret) => {
        const secret = storedSecret || config.get<string>("apiSecret") || "";
        _connect(backendUrl, secret, remoteFolder.uri.path, remoteFolder.name, context);
      });
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
      placeHolder: "ws://localhost:5590",
      value: "ws://localhost:5590",
    }) || "";
  }

  if (!backendUrl) return;

  // SecretStorage first, falling back to the (legacy) apiSecret setting
  let secret = (await context.secrets.get(SECRET_STORAGE_KEY))
    || config.get<string>("apiSecret")
    || "";
  if (!secret) {
    secret = await vscode.window.showInputBox({
      prompt: "Enter the API secret (leave blank if none)",
      password: true,
    }) || "";
  }

  // Persist settings — the URL goes to settings, the secret to SecretStorage
  // (never to settings, which are stored in plaintext)
  await config.update("backendUrl", backendUrl, vscode.ConfigurationTarget.Global);
  if (secret) {
    await context.secrets.store(SECRET_STORAGE_KEY, secret);
  }

  // Discover available agents
  statusBarItem.text = "$(sync~spin) Discovering agents…";

  const websocketUrl = normalizeWebSocketUrl(backendUrl);

  // Temporarily connect to discover agents
  const tempClient = new RpcClient(websocketUrl, secret);

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
      onAuthFailed: () => {
        vscode.window.showErrorMessage(
          "Workspace Remote: authentication failed — check your API secret",
        );
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
  const websocketUrl = normalizeWebSocketUrl(backendUrl);

  rpcClient = new RpcClient(websocketUrl, secret);

  // Swap the RPC client on the existing filesystem provider (registered once in activate())
  if (fileSystem) {
    fileSystem.setRpcClient(rpcClient);
  }

  // Swap the connection on the holder read by the search commands and
  // terminal profile provider (also registered once in activate())
  if (connectionHolder) {
    connectionHolder.rpc = rpcClient;
    connectionHolder.workspaceRoot = workspaceRoot;
  }

  rpcClient.connect({
    onConnected: () => {
      statusBarItem.text = `$(check) ${folderLabel}`;
      statusBarItem.tooltip = `Connected to ${backendUrl}\nWorkspace: ${workspaceRoot}`;
      statusBarItem.backgroundColor = undefined;

      vscode.window.showInformationMessage(`Connected to ${folderLabel}`);

      // Replay watch subscriptions — the server loses them when the socket drops
      fileSystem?.resubscribeWatchers();

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

    onAuthFailed: () => {
      statusBarItem.text = "$(plug) Workspace: Auth Failed";
      statusBarItem.tooltip = "Authentication failed — click to reconnect with a new secret";
      statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");

      vscode.window.showErrorMessage(
        "Workspace Remote: authentication failed — check your API secret",
      );
    },

    onNotification: (method, params) => {
      if (method === "watch.changed" && fileSystem) {
        const { watchRoot, filename, eventType, events } = params as {
          watchRoot: string;
          filename: string | null;
          eventType: string;
          events?: WatchChangedEvent[];
        };

        // Prefer the batched events array — the legacy top-level
        // eventType/filename fields only carry the last event.
        if (Array.isArray(events) && events.length > 0) {
          for (const event of events) {
            fileSystem.fireExternalChange(watchRoot, event.filename, event.eventType);
          }
        } else {
          fileSystem.fireExternalChange(watchRoot, filename, eventType);
        }
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

async function handleExternalUri(uri: vscode.Uri, context: vscode.ExtensionContext): Promise<void> {
  const params = new URLSearchParams(uri.query);
  const backend = params.get("backend");
  const workspace = params.get("workspace");
  const secret = params.get("secret") || "";
  const label = params.get("label") || `Remote: ${workspace?.split("/").pop()}`;

  if (!backend || !workspace) {
    vscode.window.showErrorMessage("Invalid URI — missing backend or workspace parameter");
    return;
  }

  // Never auto-connect from an external link — a malicious page could point
  // the extension at an attacker-controlled backend. Require confirmation.
  const confirmation = await vscode.window.showWarningMessage(
    "Workspace Remote: connect to this backend?",
    {
      modal: true,
      detail: `Backend: ${backend}\nWorkspace: ${workspace}\n\nOnly connect if you opened this link yourself and trust its source.`,
    },
    "Connect",
  );

  if (confirmation !== "Connect") {
    return;
  }

  _connect(backend, secret, workspace, label, context);
}
