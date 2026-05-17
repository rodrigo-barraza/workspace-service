// ─── WebSocket Connection + JSON-RPC Dispatch ───────────────

import WebSocket from "ws";
import crypto from "node:crypto";
import { watch } from "node:fs";
import { resolve } from "node:path";
import logger from "./logger.js";
import { FileHandler } from "./handlers/FileHandler.js";
import { GitHandler } from "./handlers/GitHandler.js";
import { CommandHandler } from "./handlers/CommandHandler.js";
import { ProjectHandler } from "./handlers/ProjectHandler.js";

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

export class AgentClient {
  backendUrl: string;
  roots: string[];
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
  methodMap: Map<string, (params: any) => any>;
  /**

   * @param {string} opts.backendUrl - WebSocket URL (e.g. ws://host:5590/ws/agent)
   * @param {string[]} opts.roots - Local workspace root paths
   * @param {string} opts.name - Human-readable agent name
   * @param {string} opts.secret - API secret for auth
   * @param {number} opts.reconnectInterval - Base reconnect delay (ms)
   */
  constructor({ backendUrl, roots, name, secret, reconnectInterval = 5000 }) {
    this.backendUrl = backendUrl;
    this.roots = roots;
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

    /** @type {Map<string, { watcher: import('node:fs').FSWatcher, debounceTimer: NodeJS.Timeout|null }>} */
    this.watchers = new Map();

    // Initialize handlers
    this.fileHandler = new FileHandler(roots);
    this.gitHandler = new GitHandler(roots);
    this.commandHandler = new CommandHandler(roots);
    this.projectHandler = new ProjectHandler(roots);

    this.methodMap = new Map([
      // File operations
      ["file.read", (p) => this.fileHandler.readFile(p)],
      ["file.write", (p) => this.fileHandler.writeFile(p)],
      ["file.strReplace", (p) => this.fileHandler.strReplace(p)],
      ["file.patch", (p) => this.fileHandler.patchFile(p)],
      ["file.info", (p) => this.fileHandler.fileInfo(p)],
      ["file.diff", (p) => this.fileHandler.fileDiff(p)],
      ["file.move", (p) => this.fileHandler.moveFile(p)],
      ["file.delete", (p) => this.fileHandler.deleteFile(p)],
      ["file.readMulti", (p) => this.fileHandler.multiFileRead(p)],

      // Directory operations
      ["directory.list", (p) => this.fileHandler.listDirectory(p)],
      ["directory.create", (p) => this.fileHandler.createDirectory(p)],

      // Search operations
      ["search.grep", (p) => this.fileHandler.grepSearch(p)],
      ["search.glob", (p) => this.fileHandler.globFiles(p)],

      // Git operations
      ["git.status", (p) => this.gitHandler.status(p)],
      ["git.diff", (p) => this.gitHandler.diff(p)],
      ["git.log", (p) => this.gitHandler.log(p)],

      // Command execution
      ["command.run", (p) => this.commandHandler.run(p)],
      ["command.stream", (p) => this.commandHandler.runStreaming(p, (event, data) => this._sendNotification(event, data))],

      // Project intelligence
      ["project.summary", (p) => this.projectHandler.summary(p)],

      // File watching (for VS Code FileSystemProvider)
      ["watch.subscribe", (p) => this._watchPath(p)],
      ["watch.unsubscribe", (p) => this._unwatchPath(p)],
    ] as any);
  }

  // ──────────────────────────────────────────────────────────
  // Connection Lifecycle
  // ──────────────────────────────────────────────────────────

  connect() {
    this.intentionalClose = false;

    try {
      const headers = {};
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
      });

      this.ws.on("message", (raw) => {
        try {
          const message = JSON.parse(raw.toString());
          this._handleMessage(message);
        } catch (error) {
          logger.error(`Failed to parse message: ${error.message}`);
        }
      });

      this.ws.on("pong", () => {
        clearTimeout(this.heartbeatTimeout);
      });

      this.ws.on("close", (code, reason) => {
        this.connected = false;
        this._stopHeartbeat();
        const reasonStr = reason?.toString() || "";
        logger.warn(`Disconnected (code=${code}${reasonStr ? `, reason=${reasonStr}` : ""})`);

        if (!this.intentionalClose) {
          this._scheduleReconnect();
        }
      });

      this.ws.on("error", (wsError) => {
        // Suppress ECONNREFUSED spam during reconnect — the close event will handle retry
        if ((wsError as any).code === "ECONNREFUSED") {
          if (this.reconnectAttempts <= 1) {
            logger.error(`Connection refused: ${this.backendUrl}`);
          }
        } else {
          logger.error(`WebSocket error: ${wsError.message}`);
        }
      });
    } catch (error) {
      logger.error(`Failed to connect: ${error.message}`);
      this._scheduleReconnect();
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
    this._send({
      jsonrpc: "2.0",
      method: "agent.register",
      params: {
        agentId: this.agentId,
        name: this.name,
        roots: this.roots,
        capabilities: ["file", "git", "command", "project"],
        version: "0.1.0",
      },
    });
    logger.info(`Registered agent "${this.name}" with ${this.roots.length} root(s)`);
  }

  // ──────────────────────────────────────────────────────────
  // Message Handling
  // ──────────────────────────────────────────────────────────

  async _handleMessage(message) {
    // Server acknowledgements / notifications (no id = notification)
    if (!message.id && message.method) {
      if (message.method === "agent.registered") {
        logger.success(`Server confirmed registration`);
      } else if (message.method === "agent.ping") {
        // Respond to application-level ping
        this._send({ jsonrpc: "2.0", method: "agent.pong", params: { agentId: this.agentId } });
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
        const result = await handler(message.params || {});
        this._sendResponse(message.id, result, undefined);
      } catch (error) {
        logger.error(`Handler error (${message.method}): ${error.message}`);
        this._sendResponse(message.id, null, {
          code: -32000,
          message: error.message,
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

  _send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  _sendResponse(id: any, result: any, error: any) {
    logger.rpc("out", error ? "error" : "result", id);
    const message: Record<string, any> = { jsonrpc: "2.0", id };
    if (error) {
      message.error = error;
    } else {
      message.result = result;
    }
    this._send(message);
  }

  _sendNotification(method, params) {
    this._send({ jsonrpc: "2.0", method, params });
  }

  // ──────────────────────────────────────────────────────────
  // Heartbeat
  // ──────────────────────────────────────────────────────────

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
        this.heartbeatTimeout = setTimeout(() => {
          logger.warn("Heartbeat timeout — closing connection");
          this.ws?.terminate();
        }, HEARTBEAT_TIMEOUT_MS);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  _stopHeartbeat() {
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.heartbeatTimeout);
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
   *
   * @param {{ path: string, recursive?: boolean }} params
   * @returns {{ watching: boolean, path: string }}
   */
  _watchPath({ path: watchPath, recursive = true }) {
    if (!watchPath) return { error: "path is required" };

    const resolved = resolve(watchPath);

    // Already watching?
    if (this.watchers.has(resolved)) {
      return { watching: true, path: resolved, message: "Already watching" };
    }

    try {
      const watcher = watch(resolved, { recursive }, (eventType, filename) => {
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

      watcher.on("error", (watchError) => {
        logger.warn(`Watcher error on ${resolved}: ${watchError.message}`);
        this._unwatchPath({ path: resolved });
      });

      this.watchers.set(resolved, { watcher, debounceTimer: null });
      logger.info(`Watching: ${resolved} (recursive=${recursive})`);
      return { watching: true, path: resolved };
    } catch (error) {
      return { error: `Failed to watch ${resolved}: ${error.message}` };
    }
  }

  /**
   * Unsubscribe from file-system changes.
   * @param {{ path: string }} params
   */
  _unwatchPath({ path: watchPath }) {
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
