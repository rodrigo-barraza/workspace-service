// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WebSocket Shim — Wraps Node.js built-in WebSocket
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Drop-in replacement for the `ws` npm package as used by
// AgentClient.ts and TaskEngine.ts (a ws monitor). Maps the
// Node.js EventEmitter-style API (.on/.ping/.terminate) to the
// browser-compatible WebSocket API (addEventListener) available
// in Node.js 22+. Both `new WebSocket(url, options)` and
// `new WebSocket(url, protocols, options)` are accepted, and
// "message" carries ws's (data, isBinary).
//
// Differences from the real `ws` package:
//   • Custom headers (the x-api-secret the backend requires) go
//     through the built-in WebSocket's init object, which Node 22+
//     honours. Nothing goes in the URL: tools-service accepts the
//     secret only as a header.
//   • Protocol-level ping/pong is NOT available — .ping() is a
//     no-op; heartbeat uses application-level agent.pong messages.
//   • "unexpected-response" event is silently ignored.
//
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { EventEmitter } from "node:events";

class WebSocketShim extends EventEmitter {
  constructor(url, protocolsOrOptions, maybeOptions) {
    super();
    const hasProtocols = typeof protocolsOrOptions === "string" || Array.isArray(protocolsOrOptions);
    const protocols = hasProtocols ? protocolsOrOptions : undefined;
    const options = (hasProtocols ? maybeOptions : protocolsOrOptions) || {};

    const headers = options.headers || {};
    this._socket = new WebSocket(url, {
      ...(protocols === undefined ? {} : { protocols }),
      headers,
    });
    this._socket.binaryType = "arraybuffer";
    this._readyState = WebSocket.CONNECTING;

    this._socket.addEventListener("open", () => {
      this._readyState = WebSocket.OPEN;
      this.emit("open");
    });

    this._socket.addEventListener("message", (event) => {
      // ws delivers (data, isBinary); built-in WebSocket wraps the frame in a MessageEvent
      const isBinary = typeof event.data !== "string";
      this.emit("message", isBinary ? Buffer.from(event.data) : event.data, isBinary);
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
