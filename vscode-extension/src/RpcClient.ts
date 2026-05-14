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
  private pendingRpc = new Map<string, PendingRpc>();
  private notificationHandler: NotificationHandler | null = null;

  private onConnected: (() => void) | null = null;
  private onDisconnected: (() => void) | null = null;

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
  }): void {
    this.intentionalClose = false;
    this.onConnected = opts?.onConnected ?? null;
    this.onDisconnected = opts?.onDisconnected ?? null;
    this.notificationHandler = opts?.onNotification ?? null;

    this._connect();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this._stopHeartbeat();

    // Reject all pending RPCs
    for (const [id, pending] of this.pendingRpc) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Client disconnecting"));
    }
    this.pendingRpc.clear();

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, "Client shutting down");
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
        this.connected = true;
        this.reconnectAttempts = 0;
        this._startHeartbeat();
        this.onConnected?.();
      });

      this.ws.on("message", (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          this._handleMessage(msg);
        } catch {
          // Ignore unparseable messages
        }
      });

      this.ws.on("pong", () => {
        if (this.heartbeatTimeout) {
          clearTimeout(this.heartbeatTimeout);
          this.heartbeatTimeout = null;
        }
      });

      this.ws.on("close", () => {
        const wasConnected = this.connected;
        this.connected = false;
        this._stopHeartbeat();

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
      this.notificationHandler?.(msg.method, msg.params || {});
      return;
    }
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
        this.ws.ping();
        this.heartbeatTimeout = setTimeout(() => {
          this.ws?.terminate();
        }, HEARTBEAT_TIMEOUT_MS);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private _stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.heartbeatTimeout) { clearTimeout(this.heartbeatTimeout); this.heartbeatTimeout = null; }
  }

  // ──────────────────────────────────────────────────────────
  // Reconnect
  // ──────────────────────────────────────────────────────────

  private _scheduleReconnect(): void {
    if (this.intentionalClose) return;

    this.reconnectAttempts++;
    const delay = Math.min(
      BASE_RECONNECT_MS * Math.pow(2, this.reconnectAttempts - 1),
      MAX_RECONNECT_DELAY_MS,
    );

    setTimeout(() => {
      if (!this.intentionalClose) {
        this._connect();
      }
    }, delay);
  }
}
