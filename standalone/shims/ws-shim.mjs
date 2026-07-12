// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WebSocket Shim — Wraps Node.js built-in WebSocket
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Drop-in replacement for the `ws` npm package as used by
// AgentClient.ts. Maps the Node.js EventEmitter-style API
// (.on/.ping/.terminate) to the browser-compatible WebSocket
// API (addEventListener) available in Node.js 22+.
//
// Differences from the real `ws` package:
//   • Custom headers are NOT supported — authentication falls
//     back to query-string (?secret=...) appended to the URL.
//   • Protocol-level ping/pong is NOT available — .ping() is a
//     no-op; heartbeat uses application-level agent.pong messages.
//   • "unexpected-response" event is silently ignored.
//
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { EventEmitter } from "node:events";

class WebSocketShim extends EventEmitter {
  constructor(url, options = {}) {
    super();

    // The real `ws` package supports { headers: { "x-api-secret": "..." } }.
    // Built-in WebSocket does not support custom headers, so we fall back to
    // appending the secret as a query parameter on the URL.
    const headers = options.headers || {};
    const apiSecret = headers["x-api-secret"];
    if (apiSecret) {
      const separator = url.includes("?") ? "&" : "?";
      url = `${url}${separator}secret=${encodeURIComponent(apiSecret)}`;
    }

    this._socket = new WebSocket(url);
    this._readyState = WebSocket.CONNECTING;

    this._socket.addEventListener("open", () => {
      this._readyState = WebSocket.OPEN;
      this.emit("open");
    });

    this._socket.addEventListener("message", (event) => {
      // ws delivers raw Buffer/string; built-in WebSocket wraps in MessageEvent
      const data = typeof event.data === "string" ? event.data : event.data.toString();
      this.emit("message", data);
    });

    this._socket.addEventListener("close", (event) => {
      this._readyState = WebSocket.CLOSED;
      // ws passes (code, reason) as separate args; reason as Buffer
      this.emit("close", event.code, Buffer.from(event.reason || ""));
    });

    this._socket.addEventListener("error", (event) => {
      // ws passes an Error object; built-in WebSocket passes an Event
      const errorObject = new Error(event.message || "WebSocket error");
      this.emit("error", errorObject);
    });
  }

  get readyState() {
    return this._socket?.readyState ?? WebSocket.CLOSED;
  }

  send(data) {
    if (this._socket?.readyState === WebSocket.OPEN) {
      this._socket.send(data);
    }
  }

  close(code, reason) {
    if (this._socket) {
      this._socket.close(code, reason);
    }
  }

  terminate() {
    if (this._socket) {
      this._socket.close();
    }
  }

  // Built-in WebSocket doesn't support protocol-level ping.
  // AgentClient uses ping() for heartbeat; the standalone agent
  // uses application-level agent.pong messages instead. The
  // heartbeat timeout handler relies on the "pong" event, which
  // will never fire — the agent uses its own heartbeat logic.
  ping() {
    // No-op — heartbeat is handled at the application level
  }
}

// Mirror ws static constants
WebSocketShim.CONNECTING = 0;
WebSocketShim.OPEN = 1;
WebSocketShim.CLOSING = 2;
WebSocketShim.CLOSED = 3;

export default WebSocketShim;
export { WebSocketShim as WebSocket };
