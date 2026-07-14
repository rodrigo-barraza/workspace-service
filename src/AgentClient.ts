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
  WORKSPACE_VIRTUAL_ROOT,
  WORKSPACE_ACTUAL_ROOT,
  devirtualizeRequestParams,
  virtualizeResponsePaths,
  validateWorkspacePath,
} from "./utils.ts";

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const WATCH_DEBOUNCE_MS = 300;
// A steady stream of fs events resets the debounce forever — flush at least this often
const WATCH_MAX_WAIT_MS = 2_000;
const WATCH_MAX_BATCHED_EVENTS = 500;

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
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  heartbeatTimeout: ReturnType<typeof setTimeout> | null;
  watchers: Map<
    string,
    {
      watcher: import("node:fs").FSWatcher;
      debounceTimer: ReturnType<typeof setTimeout> | null;
      maxWaitTimer: ReturnType<typeof setTimeout> | null;
      pendingEvents: Array<{ eventType: string; filename: string | null }>;
      droppedEvents: number;
    }
  >;
  fileHandler: FileHandler;
  gitHandler: GitHandler;
  commandHandler: CommandHandler;
  projectHandler: ProjectHandler;
  methodMap: Map<string, RpcHandler>;

  constructor({ backendUrl, roots, name, secret, reconnectInterval = 5000 }: AgentClientOptions) {
    super();
    this.backendUrl = backendUrl;
    this.roots = roots.map((root: string) => resolve(root));
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
    this.reconnectTimer = null;
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
      ["file.blockReplace", (rpcParams) => this.fileHandler.blockReplace(rpcParams as unknown as Parameters<FileHandler["blockReplace"]>[0])],
      ["file.multiReplace", (rpcParams) => this.fileHandler.multiReplace(rpcParams as unknown as Parameters<FileHandler["multiReplace"]>[0])],
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

    // Cancel any pending reconnect so a manual connect() can't double-fire
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Tear down any previous socket — a lingering half-open socket's late
    // close/error events would otherwise corrupt the new connection's state.
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.terminate();
      } catch {
        // Already closed
      }
      this.ws = null;
    }

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
        // Any inbound traffic proves the connection is alive — don't let the
        // heartbeat watchdog kill a connection that's actively serving RPCs
        // just because the server's ping scheduler is busy.
        this._clearHeartbeatTimeout();

        try {
          const message = JSON.parse(raw.toString()) as JsonRpcRequest;
          // _handleMessage is async; without this catch, a rejection (e.g. a
          // throwing logger or serializer) becomes an unhandledRejection that
          // kills the whole process.
          Promise.resolve(this._handleMessage(message)).catch((error: unknown) => {
            logger.error(`Unhandled error in message handler: ${errorMessage(error)}`);
          });
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
          this._scheduleReconnect();
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
        // "error" is a reserved EventEmitter name: emitting it with no
        // listener throws ERR_UNHANDLED_ERROR and kills the process (observed
        // in the container binary, which — unlike the tray app — has no error
        // subscriber, when the backend dropped mid-deploy). Only re-emit when
        // someone is actually listening; the log line above already records it.
        if (this.listenerCount("error") > 0) {
          this.emit("error", { message: wsError.message });
        }
      });

      this.ws.on("unexpected-response", (_request: unknown, response: import("node:http").IncomingMessage) => {
        const statusCode = response.statusCode || 0;
        if (statusCode === 401) {
          logger.error(`Authentication failed — invalid or missing API secret`);
          // Deliberately latched: retrying a bad secret would hot-loop 401s.
          // Consumers (tray app) surface this as a distinct state instead of
          // a generic "disconnected".
          this.intentionalClose = true;
          this.emit("auth-failed", { statusCode });
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

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

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

    // Detect WSL2 from kernel release (e.g., "5.15.187.4-microsoft-standard-WSL2")
    const kernelRelease = os.release();
    const isWsl = /microsoft/i.test(kernelRelease);

    // WSL2 sets WSL_DISTRO_NAME automatically; tray app also forwards it as AGENT_WSL_DISTRO
    const wslDistro = process.env.WSL_DISTRO_NAME || process.env.AGENT_WSL_DISTRO || undefined;

    // Only include displayRoots when they provide meaningful path info.
    // Docker containers use WORKSPACE_ACTUAL_ROOT ("/workspace") — an internal
    // mount path that's not useful to display. In that case, omit displayRoots
    // so the UI falls back to the virtual root.
    const isDockerMount = this.roots.length === 1 && this.roots[0] === WORKSPACE_ACTUAL_ROOT;

    this._send({
      jsonrpc: "2.0",
      method: "agent.register",
      params: {
        agentId: this.agentId,
        name: this.name,
        roots: this.virtualRoots,
        ...(isDockerMount ? {} : { displayRoots: this.roots }),
        capabilities: ["file", "git", "command", "project"],
        machineInfo: {
          hostname: os.hostname(),
          platform: os.platform(),
          arch: os.arch(),
          release: kernelRelease,
          username: os.userInfo().username,
          cpuModel: primaryCpuModel,
          cpuCores: cpuModels.length,
          totalMemoryBytes: os.totalmem(),
          ...(isWsl ? { isWsl: true } : {}),
          ...(wslDistro ? { wslDistro } : {}),
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
        this._clearHeartbeatTimeout();
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
    } else {
      // Never silently drop — a response computed after a disconnect is a
      // debugging signal, not noise (the server will time the request out).
      const label = message.method || (message.id !== undefined ? `response ${String(message.id)}` : "message");
      logger.warn(`Dropped outbound ${label} — socket not open`);
    }
  }

  _sendResponse(id: string | number, result: unknown, error: { code: number; message: string } | undefined) {
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
    this.heartbeatTimer = null;
    this._clearHeartbeatTimeout();
  }

  _clearHeartbeatTimeout() {
    if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
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

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
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

    // Same sanitization every other handler gets (quote-stripping etc.)
    const validation = validateWorkspacePath(watchPath, this.roots);
    if (!validation.safe) return { error: validation.error };
    const resolved = validation.resolved;

    // Already watching?
    if (this.watchers.has(resolved)) {
      return { watching: true, path: resolved, message: "Already watching" };
    }

    try {
      const flushEvents = () => {
        const entry = this.watchers.get(resolved);
        if (!entry) return;

        if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
        if (entry.maxWaitTimer) clearTimeout(entry.maxWaitTimer);
        entry.debounceTimer = null;
        entry.maxWaitTimer = null;

        const events = entry.pendingEvents;
        const droppedEvents = entry.droppedEvents;
        entry.pendingEvents = [];
        entry.droppedEvents = 0;
        if (events.length === 0) return;

        const lastEvent = events[events.length - 1];
        this._sendNotification("watch.changed", {
          watchRoot: resolved,
          // Legacy single-event fields (last event) — kept for compatibility
          eventType: lastEvent.eventType,     // "rename" | "change"
          filename: lastEvent.filename,       // relative path within watchRoot
          // Full batch: a git checkout touching 50 files yields 50 entries,
          // not just the last one
          events,
          droppedEvents,
        });
      };

      const watcher = watch(resolved, { recursive }, (eventType: string, filename: string | null) => {
        const entry = this.watchers.get(resolved);
        if (!entry) return;

        if (entry.pendingEvents.length < WATCH_MAX_BATCHED_EVENTS) {
          entry.pendingEvents.push({ eventType, filename: filename || null });
        } else {
          entry.droppedEvents++;
        }

        // Debounce rapid changes (e.g. editor save → tmp → rename), but flush
        // at least every WATCH_MAX_WAIT_MS so a steady event stream can't
        // postpone the notification forever.
        if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
        entry.debounceTimer = setTimeout(flushEvents, WATCH_DEBOUNCE_MS);
        if (!entry.maxWaitTimer) {
          entry.maxWaitTimer = setTimeout(flushEvents, WATCH_MAX_WAIT_MS);
        }
      });

      watcher.on("error", (watchError: Error) => {
        logger.warn(`Watcher error on ${resolved}: ${watchError.message}`);
        this._unwatchPath({ path: resolved });
      });

      this.watchers.set(resolved, { watcher, debounceTimer: null, maxWaitTimer: null, pendingEvents: [], droppedEvents: 0 });
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

    const validation = validateWorkspacePath(watchPath, this.roots);
    if (!validation.safe) return { error: validation.error };
    const resolved = validation.resolved;
    const entry = this.watchers.get(resolved);
    if (!entry) return { watching: false, path: resolved, message: "Not watching" };

    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    if (entry.maxWaitTimer) clearTimeout(entry.maxWaitTimer);
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
      if (entry.maxWaitTimer) clearTimeout(entry.maxWaitTimer);
      entry.watcher.close();
      logger.debug(`Unwatched (shutdown): ${path}`);
    }
    this.watchers.clear();
  }
}
