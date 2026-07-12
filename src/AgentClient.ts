// ─── WebSocket Connection + JSON-RPC Dispatch ───────────────

import WebSocket from "ws";
import crypto from "node:crypto";
import { watch } from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import { resolve } from "node:path";
import logger from "./logger.ts";
import { FileHandler } from "./handlers/FileHandler.ts";
import { GitHandler } from "./handlers/GitHandler.ts";
import { CommandHandler } from "./handlers/CommandHandler.ts";
import { ProjectHandler } from "./handlers/ProjectHandler.ts";
import type { AgentClientOptions, RpcHandler, JsonRpcRequest, WatchParams } from "./types.ts";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import {
  translateRoots,
  WORKSPACE_VIRTUAL_ROOT,
  devirtualizeRequestParams,
  virtualizeResponsePaths,
} from "./utils.ts";

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const WATCH_DEBOUNCE_MS = 300;

// ────────────────────────────────────────────────────────────
// Agent Client
// ────────────────────────────────────────────────────────────

export class AgentClient extends EventEmitter {
  backendUrl: string;
  roots: string[];
  virtualRoots: string[];
  name: string;
  secret: string;
  reconnectInterval: number;
  agentId: string;
  ws: WebSocket | null;
  connected: boolean;
  intentionalClose: boolean;
  reconnectAttempts: number;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  heartbeatTimeout: ReturnType<typeof setTimeout> | null;
  watchers: Map<string, { watcher: import("node:fs").FSWatcher; debounceTimer: ReturnType<typeof setTimeout> | null }>;
  fileHandler: FileHandler;
  gitHandler: GitHandler;
  commandHandler: CommandHandler;
  projectHandler: ProjectHandler;
  methodMap: Map<string, RpcHandler>;

  constructor({ backendUrl, roots, name, secret, reconnectInterval = 5000 }: AgentClientOptions) {
    super();
    this.backendUrl = backendUrl;
    this.roots = translateRoots(roots);
    // The virtual roots are what the LLM / tools-service see.
    // The actual roots (this.roots) are used internally by handlers.
    this.virtualRoots = [WORKSPACE_VIRTUAL_ROOT];
    this.name = name;
    this.secret = secret;
    this.reconnectInterval = reconnectInterval;
    this.agentId = crypto.randomUUID();


    this.ws = null;
    this.connected = false;
    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    this.heartbeatTimer = null;
    this.heartbeatTimeout = null;

    this.watchers = new Map();

    // Initialize handlers
    this.fileHandler = new FileHandler(roots);
    this.gitHandler = new GitHandler(roots);
    this.commandHandler = new CommandHandler(roots);
    this.projectHandler = new ProjectHandler(roots);

    this.methodMap = new Map<string, RpcHandler>([
      // File operations
      ["file.read", (rpcParams) => this.fileHandler.readFile(rpcParams as unknown as Parameters<FileHandler["readFile"]>[0])],
      ["file.write", (rpcParams) => this.fileHandler.writeFile(rpcParams as unknown as Parameters<FileHandler["writeFile"]>[0])],
      ["file.strReplace", (rpcParams) => this.fileHandler.stringReplace(rpcParams as unknown as Parameters<FileHandler["stringReplace"]>[0])],
      ["file.patch", (rpcParams) => this.fileHandler.patchFile(rpcParams as unknown as Parameters<FileHandler["patchFile"]>[0])],
      ["file.info", (rpcParams) => this.fileHandler.fileInfo(rpcParams as unknown as Parameters<FileHandler["fileInfo"]>[0])],
      ["file.diff", (rpcParams) => this.fileHandler.fileDiff(rpcParams as unknown as Parameters<FileHandler["fileDiff"]>[0])],
      ["file.move", (rpcParams) => this.fileHandler.moveFile(rpcParams as unknown as Parameters<FileHandler["moveFile"]>[0])],
      ["file.delete", (rpcParams) => this.fileHandler.deleteFile(rpcParams as unknown as Parameters<FileHandler["deleteFile"]>[0])],
      ["file.readMulti", (rpcParams) => this.fileHandler.multiFileRead(rpcParams as unknown as Parameters<FileHandler["multiFileRead"]>[0])],

      // Directory operations
      ["directory.list", (rpcParams) => this.fileHandler.listDirectory(rpcParams as unknown as Parameters<FileHandler["listDirectory"]>[0])],
      ["directory.create", (rpcParams) => this.fileHandler.createDirectory(rpcParams as unknown as Parameters<FileHandler["createDirectory"]>[0])],
      ["directory.tree", (rpcParams) => this.fileHandler.directoryTree(rpcParams as unknown as Parameters<FileHandler["directoryTree"]>[0])],

      // Search operations
      ["search.grep", (rpcParams) => this.fileHandler.grepSearch(rpcParams as unknown as Parameters<FileHandler["grepSearch"]>[0])],
      ["search.glob", (rpcParams) => this.fileHandler.globFiles(rpcParams as unknown as Parameters<FileHandler["globFiles"]>[0])],

      // Git operations
      ["git.status", (rpcParams) => this.gitHandler.status(rpcParams as unknown as Parameters<GitHandler["status"]>[0])],
      ["git.diff", (rpcParams) => this.gitHandler.diff(rpcParams as unknown as Parameters<GitHandler["diff"]>[0])],
      ["git.log", (rpcParams) => this.gitHandler.log(rpcParams as unknown as Parameters<GitHandler["log"]>[0])],

      // Command execution
      ["command.run", (rpcParams) => this.commandHandler.run(rpcParams as unknown as Parameters<CommandHandler["run"]>[0])],
      ["command.stream", (rpcParams) => this.commandHandler.runStreaming(rpcParams as unknown as Parameters<CommandHandler["runStreaming"]>[0], (event: string, data: Record<string, unknown>) => this._sendNotification(event, data))],

      // Project intelligence
      ["project.summary", (rpcParams) => this.projectHandler.summary(rpcParams as unknown as Parameters<ProjectHandler["summary"]>[0])],

      // File watching (for VS Code FileSystemProvider)
      ["watch.subscribe", (rpcParams) => this._watchPath(rpcParams as unknown as WatchParams)],
      ["watch.unsubscribe", (rpcParams) => this._unwatchPath(rpcParams as unknown as WatchParams)],
    ]);
  }

  // ──────────────────────────────────────────────────────────
  // Connection Lifecycle
  // ──────────────────────────────────────────────────────────

  connect() {
    this.intentionalClose = false;

    try {
      const headers: Record<string, string> = {};
      if (this.secret) {
        headers["x-api-secret"] = this.secret;
      }

      this.ws = new WebSocket(this.backendUrl, { headers });

      this.ws.on("open", () => {
        this.connected = true;
        this.reconnectAttempts = 0;
        logger.success(`Connected to ${this.backendUrl}`);
        this._register();
        this._startHeartbeat();
        this.emit("connected");
      });

      this.ws.on("message", (raw: WebSocket.RawData) => {
        try {
          const message = JSON.parse(raw.toString()) as JsonRpcRequest;
          this._handleMessage(message);
        } catch (error: unknown) {
          logger.error(`Failed to parse message: ${errorMessage(error)}`);
        }
      });


      this.ws.on("close", (code: number, reason: Buffer) => {
        this.connected = false;
        this._stopHeartbeat();
        const reasonString = reason?.toString() || "";
        logger.warn(`Disconnected (code=${code}${reasonString ? `, reason=${reasonString}` : ""})`);
        this.emit("disconnected", { code, reason: reasonString });

        if (!this.intentionalClose) {
          logger.warn(`Connection lost — use Save & Reconnect to retry`);
        }
      });

      this.ws.on("error", (wsError: Error) => {
        // Suppress ECONNREFUSED spam during reconnect — the close event will handle retry
        if ((wsError as NodeJS.ErrnoException).code === "ECONNREFUSED") {
          if (this.reconnectAttempts <= 1) {
            logger.error(`Connection refused: ${this.backendUrl}`);
          }
        } else {
          logger.error(`WebSocket error: ${wsError.message}`);
        }
        this.emit("error", { message: wsError.message });
      });

      this.ws.on("unexpected-response", (_request: unknown, response: import("node:http").IncomingMessage) => {
        const statusCode = response.statusCode || 0;
        if (statusCode === 401) {
          logger.error(`Authentication failed — invalid or missing API secret`);
          this.intentionalClose = true;
          this.ws?.close();
        } else {
          logger.error(`Unexpected HTTP ${statusCode} during WebSocket upgrade`);
        }
      });
    } catch (error: unknown) {
      logger.error(`Failed to connect: ${errorMessage(error)}`);
    }
  }

  disconnect() {
    this.intentionalClose = true;
    this._stopHeartbeat();
    this._unwatchAll();

    if (this.ws && this.connected) {
      // Send deregister before closing
      this._send({
        jsonrpc: "2.0",
        method: "agent.deregister",
        params: { agentId: this.agentId },
      });
      this.ws.close(1000, "Agent shutting down");
    }

    this.ws = null;
    this.connected = false;
  }

  // ──────────────────────────────────────────────────────────
  // Registration
  // ──────────────────────────────────────────────────────────

  _register() {
    const cpuModels = os.cpus();
    const primaryCpuModel = cpuModels.length > 0 ? cpuModels[0].model.trim() : "unknown";

    this._send({
      jsonrpc: "2.0",
      method: "agent.register",
      params: {
        agentId: this.agentId,
        name: this.name,
        roots: this.virtualRoots,
        capabilities: ["file", "git", "command", "project"],
        machineInfo: {
          hostname: os.hostname(),
          platform: os.platform(),
          arch: os.arch(),
          release: os.release(),
          username: os.userInfo().username,
          cpuModel: primaryCpuModel,
          cpuCores: cpuModels.length,
          totalMemoryBytes: os.totalmem(),
        },
      },
    });
    logger.info(`Registered agent "${this.name}" with ${this.roots.length} root(s)`);
  }

  // ──────────────────────────────────────────────────────────
  // Message Handling
  // ──────────────────────────────────────────────────────────

  async _handleMessage(message: JsonRpcRequest) {
    // Server acknowledgements / notifications (no id = notification)
    if (!message.id && message.method) {
      if (message.method === "agent.registered") {
        logger.success(`Server confirmed registration`);
      } else if (message.method === "agent.ping") {
        // Respond to application-level ping + treat as heartbeat proof-of-liveness
        if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
        this._send({ jsonrpc: "2.0", method: "agent.pong", params: { agentId: this.agentId } });
      } else if (message.method === "agent.kicked") {
        // Server-initiated disconnect — suppress auto-reconnect
        const kickReason = (message.params as Record<string, unknown>)?.reason || "unknown";
        logger.warn(`Kicked by server: ${kickReason}`);
        this.intentionalClose = true;
      }
      return;
    }

    // RPC request (has id + method)
    if (message.id && message.method) {
      logger.rpc("in", message.method, message.id);

      const handler = this.methodMap.get(message.method);
      if (!handler) {
        this._sendResponse(message.id, null, {
          code: -32601,
          message: `Method not found: ${message.method}`,
        });
        return;
      }

      try {
        // Devirtualize incoming paths: "/src/foo.ts" → "/workspace/src/foo.ts"
        const translatedParams = devirtualizeRequestParams(message.params || {});
        const result = await handler(translatedParams as Record<string, unknown>);
        // Virtualize outgoing paths: "/workspace/src/foo.ts" → "/src/foo.ts"
        const translatedResult = virtualizeResponsePaths(result);
        this._sendResponse(message.id, translatedResult, undefined);
      } catch (error: unknown) {
        const messageText = errorMessage(error);
        logger.error(`Handler error (${message.method}): ${messageText}`);
        this._sendResponse(message.id, null, {
          code: -32000,
          message: messageText,
        });
      }
      return;
    }

    // RPC response (has id + result/error) — we don't currently send requests to the server
    if (message.id && (message.result !== undefined || message.error)) {
      logger.debug(`Received response for ${message.id}`);
      return;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Transport
  // ──────────────────────────────────────────────────────────

  _send(message: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  _sendResponse(id: string, result: unknown, error: { code: number; message: string } | undefined) {
    logger.rpc("out", error ? "error" : "result", id);
    const message: Record<string, unknown> = { jsonrpc: "2.0", id };
    if (error) {
      message.error = error;
    } else {
      message.result = result;
    }
    this._send(message);
  }

  _sendNotification(method: string, params: Record<string, unknown>) {
    this._send({ jsonrpc: "2.0", method, params });
  }

  // ──────────────────────────────────────────────────────────
  // Heartbeat
  // ──────────────────────────────────────────────────────────

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Use application-level JSON heartbeat instead of WebSocket control frames,
        // because reverse proxies (Cloudflare, nginx) absorb WS-level ping/pong.
        this._send({ jsonrpc: "2.0", method: "agent.heartbeat", params: { agentId: this.agentId } });
        this.heartbeatTimeout = setTimeout(() => {
          logger.warn("Heartbeat timeout — closing connection");
          this.ws?.terminate();
        }, HEARTBEAT_TIMEOUT_MS);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
    this.heartbeatTimer = null;
    this.heartbeatTimeout = null;
  }

  // ──────────────────────────────────────────────────────────
  // Reconnect
  // ──────────────────────────────────────────────────────────

  _scheduleReconnect() {
    this.reconnectAttempts++;
    // Exponential backoff: base * 2^(attempt-1), capped
    const delay = Math.min(
      this.reconnectInterval * Math.pow(2, this.reconnectAttempts - 1),
      MAX_RECONNECT_DELAY_MS,
    );

    if (this.reconnectAttempts <= 3 || this.reconnectAttempts % 10 === 0) {
      logger.info(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})…`);
    }
    this.emit("reconnecting", { attempt: this.reconnectAttempts, delayMs: delay });

    setTimeout(() => {
      if (!this.intentionalClose) {
        this.connect();
      }
    }, delay);
  }

  // ──────────────────────────────────────────────────────────
  // File Watching (for VS Code FileSystemProvider)
  // ──────────────────────────────────────────────────────────

  /**
   * Subscribe to file-system changes on a path.
   * Pushes `watch.changed` notifications over WebSocket on changes.
   */
  _watchPath({ path: watchPath, recursive = true }: WatchParams) {
    if (!watchPath) return { error: "path is required" };

    const resolved = resolve(watchPath);

    // Already watching?
    if (this.watchers.has(resolved)) {
      return { watching: true, path: resolved, message: "Already watching" };
    }

    try {
      const watcher = watch(resolved, { recursive }, (eventType: string, filename: string | null) => {
        // Debounce rapid changes (e.g. editor save → tmp → rename)
        const entry = this.watchers.get(resolved);
        if (!entry) return;

        if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
        entry.debounceTimer = setTimeout(() => {
          entry.debounceTimer = null;
          this._sendNotification("watch.changed", {
            watchRoot: resolved,
            eventType,                       // "rename" | "change"
            filename: filename || null,       // relative path within watchRoot
          });
        }, WATCH_DEBOUNCE_MS);
      });

      watcher.on("error", (watchError: Error) => {
        logger.warn(`Watcher error on ${resolved}: ${watchError.message}`);
        this._unwatchPath({ path: resolved });
      });

      this.watchers.set(resolved, { watcher, debounceTimer: null });
      logger.info(`Watching: ${resolved} (recursive=${recursive})`);
      return { watching: true, path: resolved };
    } catch (error: unknown) {
      return { error: `Failed to watch ${resolved}: ${errorMessage(error)}` };
    }
  }

  /**
   * Unsubscribe from file-system changes.
   */
  _unwatchPath({ path: watchPath }: WatchParams) {
    if (!watchPath) return { error: "path is required" };

    const resolved = resolve(watchPath);
    const entry = this.watchers.get(resolved);
    if (!entry) return { watching: false, path: resolved, message: "Not watching" };

    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.watcher.close();
    this.watchers.delete(resolved);

    logger.info(`Unwatched: ${resolved}`);
    return { watching: false, path: resolved };
  }

  /**
   * Close all active watchers (used during disconnect).
   */
  _unwatchAll() {
    for (const [path, entry] of this.watchers) {
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      entry.watcher.close();
      logger.debug(`Unwatched (shutdown): ${path}`);
    }
    this.watchers.clear();
  }
}
