// ============================================================
// Agent Client — WebSocket Connection + JSON-RPC Dispatch
// ============================================================
// Maintains a persistent WebSocket connection to tools-service.
// On connect, registers this agent's workspace roots.
// Dispatches incoming RPC requests to operation handlers.
//
// Features:
//   - Auto-reconnect with exponential backoff
//   - Heartbeat ping/pong (30s interval)
//   - JSON-RPC 2.0 protocol
//   - Graceful deregister on shutdown
// ============================================================

import WebSocket from "ws";
import crypto from "node:crypto";
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

// ────────────────────────────────────────────────────────────
// Agent Client
// ────────────────────────────────────────────────────────────

export class AgentClient {
  /**
   * @param {object} opts
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

    /** @type {WebSocket|null} */
    this.ws = null;
    this.connected = false;
    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    this.heartbeatTimer = null;
    this.heartbeatTimeout = null;

    // Initialize handlers
    this.fileHandler = new FileHandler(roots);
    this.gitHandler = new GitHandler(roots);
    this.commandHandler = new CommandHandler(roots);
    this.projectHandler = new ProjectHandler(roots);

    // Method → handler dispatch map
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
    ]);
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
          const msg = JSON.parse(raw.toString());
          this._handleMessage(msg);
        } catch (err) {
          logger.error(`Failed to parse message: ${err.message}`);
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

      this.ws.on("error", (err) => {
        // Suppress ECONNREFUSED spam during reconnect — the close event will handle retry
        if (err.code === "ECONNREFUSED") {
          if (this.reconnectAttempts <= 1) {
            logger.error(`Connection refused: ${this.backendUrl}`);
          }
        } else {
          logger.error(`WebSocket error: ${err.message}`);
        }
      });
    } catch (err) {
      logger.error(`Failed to connect: ${err.message}`);
      this._scheduleReconnect();
    }
  }

  disconnect() {
    this.intentionalClose = true;
    this._stopHeartbeat();

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

  async _handleMessage(msg) {
    // Server acknowledgements / notifications (no id = notification)
    if (!msg.id && msg.method) {
      if (msg.method === "agent.registered") {
        logger.success(`Server confirmed registration`);
      } else if (msg.method === "agent.ping") {
        // Respond to application-level ping
        this._send({ jsonrpc: "2.0", method: "agent.pong", params: { agentId: this.agentId } });
      }
      return;
    }

    // RPC request (has id + method)
    if (msg.id && msg.method) {
      logger.rpc("in", msg.method, msg.id);

      const handler = this.methodMap.get(msg.method);
      if (!handler) {
        this._sendResponse(msg.id, null, {
          code: -32601,
          message: `Method not found: ${msg.method}`,
        });
        return;
      }

      try {
        const result = await handler(msg.params || {});
        this._sendResponse(msg.id, result);
      } catch (err) {
        logger.error(`Handler error (${msg.method}): ${err.message}`);
        this._sendResponse(msg.id, null, {
          code: -32000,
          message: err.message,
        });
      }
      return;
    }

    // RPC response (has id + result/error) — we don't currently send requests to the server
    if (msg.id && (msg.result !== undefined || msg.error)) {
      logger.debug(`Received response for ${msg.id}`);
      return;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Transport
  // ──────────────────────────────────────────────────────────

  _send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  _sendResponse(id, result, error) {
    logger.rpc("out", error ? "error" : "result", id);
    const msg = { jsonrpc: "2.0", id };
    if (error) {
      msg.error = error;
    } else {
      msg.result = result;
    }
    this._send(msg);
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
}
