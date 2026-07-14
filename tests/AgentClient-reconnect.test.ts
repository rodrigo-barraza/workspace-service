import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AgentClient Reconnect / Dispatch / Watch-Batching Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Regression guards for the historical failure modes:
//   • auto-reconnect was dead code (close handler never scheduled it) — any
//     network blip permanently killed the agent
//   • numeric JSON-RPC ids crashed the process via id.slice()
//   • only agent.ping cleared the heartbeat watchdog, so active RPC traffic
//     couldn't keep a connection alive
//   • the watch debounce dropped all but the last fs event

// ── Mock WebSocket ──────────────────────────────────────────

class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  sentMessages: Record<string, unknown>[] = [];
  terminated = false;

  constructor(..._arguments: unknown[]) {
    super();
  }

  send(data: string) {
    this.sentMessages.push(JSON.parse(data));
  }

  terminate() {
    this.terminated = true;
    this.readyState = MockWebSocket.CLOSED;
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }
}

// ── Mock fs.watch (captures the change listener) ────────────

type WatchListener = (eventType: string, filename: string | null) => void;
const registeredWatchListeners: WatchListener[] = [];

class MockFsWatcher extends EventEmitter {
  close = vi.fn();
}

// ── Mock Dependencies ───────────────────────────────────────

vi.mock("ws", () => ({
  default: MockWebSocket,
  WebSocket: MockWebSocket,
}));

vi.mock("node:fs", () => ({
  watch: vi.fn((_path: string, _options: unknown, listener: WatchListener) => {
    registeredWatchListeners.push(listener);
    return new MockFsWatcher();
  }),
  existsSync: vi.fn(() => false),
}));

vi.mock("../src/logger.ts", () => ({
  default: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    rpc: vi.fn(),
  },
}));

vi.mock("../src/handlers/FileHandler.ts", () => ({
  FileHandler: vi.fn(function () { return {}; }),
}));
vi.mock("../src/handlers/GitHandler.ts", () => ({
  GitHandler: vi.fn(function () { return {}; }),
}));
vi.mock("../src/handlers/CommandHandler.ts", () => ({
  CommandHandler: vi.fn(function () { return {}; }),
}));
vi.mock("../src/handlers/ProjectHandler.ts", () => ({
  ProjectHandler: vi.fn(function () { return {}; }),
}));

vi.mock("../src/utils.ts", () => ({
  WORKSPACE_VIRTUAL_ROOT: "/",
  WORKSPACE_ACTUAL_ROOT: "/",
  isVirtualized: false,
  devirtualizeRequestParams: vi.fn((params: unknown) => params),
  virtualizeResponsePaths: vi.fn((result: unknown) => result),
  validateWorkspacePath: vi.fn((inputPath: string) => ({ safe: true, resolved: inputPath })),
}));

vi.mock("@rodrigo-barraza/utilities-library", () => ({
  errorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

const { AgentClient } = await import("../src/AgentClient.ts");

function createAgentClient(overrides: Record<string, unknown> = {}) {
  return new AgentClient({
    backendUrl: "wss://api.tools.rod.dev/ws/agent",
    roots: ["/home/rodrigo/development"],
    name: "TestHost",
    secret: "test-secret",
    reconnectInterval: 1000,
    ...overrides,
  });
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("AgentClient — auto-reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    registeredWatchListeners.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("schedules a reconnect when the connection closes unintentionally (THE historical dead-code bug)", () => {
    const agent = createAgentClient();
    const reconnectingEvents: Array<{ attempt: number; delayMs: number }> = [];
    agent.on("reconnecting", (detail) => reconnectingEvents.push(detail));

    agent.connect();
    const firstSocket = agent.ws as unknown as MockWebSocket;
    firstSocket.emit("open");
    firstSocket.emit("close", 1006, Buffer.from(""));

    expect(reconnectingEvents).toHaveLength(1);
    expect(agent.reconnectAttempts).toBe(1);

    // After the backoff delay, a fresh connect() happens
    vi.advanceTimersByTime(1100);
    expect(agent.ws).not.toBe(firstSocket);
  });

  it("uses exponential backoff capped at 30s", () => {
    const agent = createAgentClient({ reconnectInterval: 5000 });
    const delays: number[] = [];
    agent.on("reconnecting", (detail: { delayMs: number }) => delays.push(detail.delayMs));

    agent.connect();
    for (let attempt = 0; attempt < 5; attempt++) {
      (agent.ws as unknown as MockWebSocket).emit("close", 1006, Buffer.from(""));
      vi.advanceTimersByTime(35_000);
    }

    expect(delays).toEqual([5000, 10_000, 20_000, 30_000, 30_000]);
  });

  it("does NOT reconnect after an intentional disconnect()", () => {
    const agent = createAgentClient();
    const reconnectingEvents: unknown[] = [];
    agent.on("reconnecting", (detail) => reconnectingEvents.push(detail));

    agent.connect();
    const socket = agent.ws as unknown as MockWebSocket;
    socket.emit("open");
    agent.disconnect();
    socket.emit("close", 1000, Buffer.from(""));

    vi.advanceTimersByTime(60_000);
    expect(reconnectingEvents).toHaveLength(0);
  });

  it("latches on 401 and emits auth-failed instead of hot-looping a bad secret", () => {
    const agent = createAgentClient();
    const authFailures: unknown[] = [];
    agent.on("auth-failed", (detail) => authFailures.push(detail));

    agent.connect();
    const socket = agent.ws as unknown as MockWebSocket;
    socket.emit("unexpected-response", {}, { statusCode: 401 });
    socket.emit("close", 1006, Buffer.from(""));

    vi.advanceTimersByTime(60_000);
    expect(authFailures).toEqual([{ statusCode: 401 }]);
    expect(agent.intentionalClose).toBe(true);
  });

  it("resets the attempt counter after a successful reconnect", () => {
    const agent = createAgentClient();
    agent.connect();

    (agent.ws as unknown as MockWebSocket).emit("close", 1006, Buffer.from(""));
    expect(agent.reconnectAttempts).toBe(1);

    vi.advanceTimersByTime(1100);
    (agent.ws as unknown as MockWebSocket).emit("open");
    expect(agent.reconnectAttempts).toBe(0);
  });

  it("tears down the previous socket on connect() so its late events can't corrupt state", () => {
    const agent = createAgentClient();
    agent.connect();
    const firstSocket = agent.ws as unknown as MockWebSocket;
    firstSocket.emit("open");

    agent.connect();
    expect(firstSocket.terminated).toBe(true);
    expect(firstSocket.listenerCount("close")).toBe(0);
  });
});

describe("AgentClient — heartbeat liveness", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("treats ANY inbound message as proof of liveness, not just agent.ping", () => {
    const agent = createAgentClient();
    agent.connect();
    const socket = agent.ws as unknown as MockWebSocket;
    socket.emit("open");

    // Heartbeat fires, watchdog armed
    vi.advanceTimersByTime(30_000);
    expect(agent.heartbeatTimeout).not.toBeNull();

    // Plain RPC traffic arrives (NOT agent.ping)
    socket.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: "x1", method: "nonexistent.method" })));

    // Watchdog must not kill the connection
    vi.advanceTimersByTime(10_000);
    expect(socket.terminated).toBe(false);
  });
});

describe("AgentClient — RPC dispatch robustness", () => {
  afterEach(() => vi.clearAllMocks());

  it("survives numeric JSON-RPC ids (used to crash the process via id.slice())", async () => {
    const agent = createAgentClient();
    agent.connect();
    const socket = agent.ws as unknown as MockWebSocket;
    socket.emit("open");

    socket.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 42, method: "no.such.method" })));
    await flushMicrotasks();

    const response = socket.sentMessages.find((message) => message.id === 42);
    expect(response).toBeDefined();
    expect((response!.error as { code: number }).code).toBe(-32601);
  });

  it("maps handler throws to a -32000 error response instead of an unhandled rejection", async () => {
    const agent = createAgentClient();
    agent.methodMap.set("test.boom", () => {
      throw new Error("kaboom");
    });

    agent.connect();
    const socket = agent.ws as unknown as MockWebSocket;
    socket.emit("open");

    socket.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: "req-1", method: "test.boom" })));
    await flushMicrotasks();

    const response = socket.sentMessages.find((message) => message.id === "req-1");
    expect(response).toBeDefined();
    expect((response!.error as { code: number; message: string })).toEqual({ code: -32000, message: "kaboom" });
  });

  it("dispatches to a registered handler and sends its result", async () => {
    const agent = createAgentClient();
    agent.methodMap.set("test.echo", (params) => ({ echoed: params }));

    agent.connect();
    const socket = agent.ws as unknown as MockWebSocket;
    socket.emit("open");

    socket.emit("message", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: "req-2", method: "test.echo", params: { a: 1 } })));
    await flushMicrotasks();

    const response = socket.sentMessages.find((message) => message.id === "req-2");
    expect(response!.result).toEqual({ echoed: { a: 1 } });
  });
});

describe("AgentClient — watch event batching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    registeredWatchListeners.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function connectAndWatch() {
    const agent = createAgentClient();
    agent.connect();
    const socket = agent.ws as unknown as MockWebSocket;
    socket.emit("open");
    const result = agent._watchPath({ path: "/watched/root" });
    expect(result).toMatchObject({ watching: true });
    return { agent, socket, fireEvent: registeredWatchListeners[registeredWatchListeners.length - 1] };
  }

  it("batches a burst of events into ONE notification carrying ALL of them (git checkout case)", () => {
    const { socket, fireEvent } = connectAndWatch();

    fireEvent("change", "a.ts");
    fireEvent("change", "b.ts");
    fireEvent("rename", "c.ts");
    vi.advanceTimersByTime(350);

    const notifications = socket.sentMessages.filter((message) => message.method === "watch.changed");
    expect(notifications).toHaveLength(1);
    const params = notifications[0].params as { events: unknown[]; filename: string };
    expect(params.events).toEqual([
      { eventType: "change", filename: "a.ts" },
      { eventType: "change", filename: "b.ts" },
      { eventType: "rename", filename: "c.ts" },
    ]);
    // Legacy fields still present (last event) for older consumers
    expect(params.filename).toBe("c.ts");
  });

  it("flushes at the max-wait even under a steady event stream (debounce starvation guard)", () => {
    const { socket, fireEvent } = connectAndWatch();

    // An event every 200ms forever — the 300ms debounce alone would never fire
    for (let tick = 0; tick < 12; tick++) {
      fireEvent("change", `file-${tick}.ts`);
      vi.advanceTimersByTime(200);
    }

    const notifications = socket.sentMessages.filter((message) => message.method === "watch.changed");
    expect(notifications.length).toBeGreaterThanOrEqual(1);
  });
});

describe("AgentClient — websocket error resilience", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("survives a socket error with no consumer 'error' subscriber (ERR_UNHANDLED_ERROR regression)", () => {
    // Observed in production: the container binary (no error subscriber)
    // crashed with ERR_UNHANDLED_ERROR when the backend dropped mid-deploy.
    const agent = createAgentClient();
    agent.connect();
    const socket = agent.ws as unknown as MockWebSocket;

    expect(() => socket.emit("error", new Error("socket hang up"))).not.toThrow();
  });

  it("still re-emits socket errors to consumers that subscribe (tray app)", () => {
    const agent = createAgentClient();
    agent.connect();
    const seen: unknown[] = [];
    agent.on("error", (detail: unknown) => seen.push(detail));

    (agent.ws as unknown as MockWebSocket).emit("error", new Error("boom"));

    expect(seen).toEqual([{ message: "boom" }]);
  });
});
