// ─── JSON-RPC 2.0 Transport over WebSocket ──────────────────
// Mirrors the protocol used by workspace-service's AgentClient,
// but from the "caller" side — we send requests and receive results.

import WebSocket from "ws";
import * as crypto from "node:crypto";

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export interface RpcResult<T = unknown> {
  result?: T;
  error?: { code: number; message: string };
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type NotificationHandler = (method: string, params: Record<string, unknown>) => void;

/**
 * Mutable holder that always points at the current RPC client + workspace root.
 * Commands and providers are registered once at activation and read through
 * this holder, so connect/reconnect can swap the connection without
 * re-registering anything (re-registration throws "command already exists").
 */
export interface RpcConnectionHolder {
  rpc: RpcClient;
  workspaceRoot: string;
}

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const BASE_RECONNECT_MS = 3_000;

// ────────────────────────────────────────────────────────────
// RPC Client
// ────────────────────────────────────────────────────────────

export class RpcClient {
  private backendUrl: string;
  private secret: string;
  private ws: WebSocket | null = null;
  private connected = false;
  private intentionalClose = false;
  private reconnectAttempts = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRpc = new Map<string, PendingRpc>();
  private notificationHandler: NotificationHandler | null = null;

  private onConnected: (() => void) | null = null;
  private onDisconnected: (() => void) | null = null;
  private onAuthFailed: (() => void) | null = null;

  constructor(backendUrl: string, secret: string) {
    this.backendUrl = backendUrl;
    this.secret = secret;
  }

  // ──────────────────────────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────────────────────────

  connect(opts?: {
    onConnected?: () => void;
    onDisconnected?: () => void;
    onNotification?: NotificationHandler;
    onAuthFailed?: () => void;
  }): void {
    this.intentionalClose = false;
    this.onConnected = opts?.onConnected ?? null;
    this.onDisconnected = opts?.onDisconnected ?? null;
    this.notificationHandler = opts?.onNotification ?? null;
    this.onAuthFailed = opts?.onAuthFailed ?? null;

    this._connect();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this._stopHeartbeat();

    // Cancel any pending reconnect attempt
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject all pending RPCs
    this._rejectAllPending(new Error("Client disconnecting"));

    if (this.ws) {
      // Detach listeners first so a late 'open'/'close' on the old socket
      // can't restart the heartbeat or trigger a reconnect.
      this.ws.removeAllListeners();
      this.ws.on("error", () => {
        // Suppress — errors on a discarded socket are irrelevant
      });

      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, "Client shutting down");
      } else if (this.ws.readyState !== WebSocket.CLOSED) {
        // CONNECTING or CLOSING — terminate so the socket doesn't leak
        this.ws.terminate();
      }
    }
    this.ws = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ──────────────────────────────────────────────────────────
  // RPC
  // ──────────────────────────────────────────────────────────

  /**
   * Send a JSON-RPC 2.0 request and wait for the response.
   */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to backend");
    }

    const id = crypto.randomUUID();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`RPC timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingRpc.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }

  // ──────────────────────────────────────────────────────────
  // Internal Connection
  // ──────────────────────────────────────────────────────────

  private _connect(): void {
    try {
      const headers: Record<string, string> = {};
      if (this.secret) {
        headers["x-api-secret"] = this.secret;
      }

      this.ws = new WebSocket(this.backendUrl, { headers });

      this.ws.on("open", () => {
        if (this.intentionalClose) {
          // disconnect() raced the handshake — don't resurrect the connection
          this.ws?.terminate();
          return;
        }
        this.connected = true;
        this.reconnectAttempts = 0;
        this._startHeartbeat();
        this.onConnected?.();
      });

      this.ws.on("message", (raw: Buffer) => {
        // Any inbound traffic proves the connection is alive — don't let the
        // heartbeat watchdog kill a connection that's actively serving RPCs.
        this._clearHeartbeatTimeout();

        try {
          const msg = JSON.parse(raw.toString());
          this._handleMessage(msg);
        } catch {
          // Ignore unparseable messages
        }
      });

      this.ws.on("unexpected-response", (request, response) => {
        if (response.statusCode === 401) {
          // Auth failure — retrying with the same secret can never succeed,
          // so stop the reconnect loop and surface it to the caller.
          this.intentionalClose = true;
          this.connected = false;
          this._stopHeartbeat();
          this._rejectAllPending(new Error("Authentication failed (HTTP 401)"));
          request.destroy();
          this.onAuthFailed?.();
        } else {
          request.destroy();
          this._scheduleReconnect();
        }
      });

      this.ws.on("close", () => {
        const wasConnected = this.connected;
        this.connected = false;
        this._stopHeartbeat();

        // Fail fast — reject in-flight RPCs instead of letting each one
        // hang until its own timeout fires.
        this._rejectAllPending(new Error("Connection closed"));

        if (wasConnected) {
          this.onDisconnected?.();
        }

        if (!this.intentionalClose) {
          this._scheduleReconnect();
        }
      });

      this.ws.on("error", () => {
        // Suppress — the close event handles reconnection
      });
    } catch {
      this._scheduleReconnect();
    }
  }

  private _handleMessage(msg: { id?: string; method?: string; result?: unknown; error?: { code: number; message: string }; params?: Record<string, unknown> }): void {
    // RPC response
    if (msg.id && (msg.result !== undefined || msg.error)) {
      const pending = this.pendingRpc.get(msg.id);
      if (pending) {
        this.pendingRpc.delete(msg.id);
        clearTimeout(pending.timer);

        if (msg.error) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Notification (no id, has method)
    if (!msg.id && msg.method) {
      if (msg.method === "agent.ping") {
        // Respond to application-level ping — liveness proof for the server
        this._send({ jsonrpc: "2.0", method: "agent.pong", params: {} });
        return;
      }
      this.notificationHandler?.(msg.method, msg.params || {});
      return;
    }
  }

  private _rejectAllPending(err: Error): void {
    for (const pending of this.pendingRpc.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingRpc.clear();
  }

  private _send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // ──────────────────────────────────────────────────────────
  // Heartbeat
  // ──────────────────────────────────────────────────────────

  private _startHeartbeat(): void {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Application-level heartbeat instead of WebSocket control frames,
        // because reverse proxies (Cloudflare, nginx) absorb WS-level ping/pong.
        //
        // NOTE: this client connects to /ws/workspace, whose server-side
        // handler only processes RPC REQUESTS (id + method) and silently drops
        // notifications — an `agent.heartbeat` notification would never be
        // answered. `agents.list` is the endpoint's cheap meta-method, and any
        // response (even an error) clears the watchdog via the message handler.
        this.call("agents.list", {}, HEARTBEAT_TIMEOUT_MS).catch(() => {
          // Timeout/rejection is handled by the watchdog below — and a
          // rejected call after a dropped socket must not surface anywhere
        });
        if (!this.heartbeatTimeout) {
          this.heartbeatTimeout = setTimeout(() => {
            this.ws?.terminate();
          }, HEARTBEAT_TIMEOUT_MS);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private _stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this._clearHeartbeatTimeout();
  }

  private _clearHeartbeatTimeout(): void {
    if (this.heartbeatTimeout) { clearTimeout(this.heartbeatTimeout); this.heartbeatTimeout = null; }
  }

  // ──────────────────────────────────────────────────────────
  // Reconnect
  // ──────────────────────────────────────────────────────────

  private _scheduleReconnect(): void {
    if (this.intentionalClose) return;
    if (this.reconnectTimer) return; // already scheduled

    this.reconnectAttempts++;
    const delay = Math.min(
      BASE_RECONNECT_MS * Math.pow(2, this.reconnectAttempts - 1),
      MAX_RECONNECT_DELAY_MS,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.intentionalClose) {
        this._connect();
      }
    }, delay);
  }
}
