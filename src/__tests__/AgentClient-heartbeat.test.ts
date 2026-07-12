import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AgentClient Heartbeat Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Verifies the application-level heartbeat mechanism that replaced
// WebSocket control-frame ping/pong (which reverse proxies absorb).

// ── Mock WebSocket ──────────────────────────────────────────

class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  sentMessages: Record<string, unknown>[] = [];

  send(data: string) {
    this.sentMessages.push(JSON.parse(data));
  }

  ping() {
    // Should NOT be called anymore
  }

  terminate() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", 1006, Buffer.from(""));
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", 1000, Buffer.from(""));
  }
}

// ── Mock Dependencies ───────────────────────────────────────

vi.mock("ws", () => ({
  default: MockWebSocket,
  WebSocket: MockWebSocket,
}));

vi.mock("../logger.ts", () => ({
  default: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../handlers/FileHandler.ts", () => ({
  FileHandler: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../handlers/GitHandler.ts", () => ({
  GitHandler: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../handlers/CommandHandler.ts", () => ({
  CommandHandler: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../handlers/ProjectHandler.ts", () => ({
  ProjectHandler: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../utils.ts", () => ({
  translateRoots: (roots: string[]) => roots,
  WORKSPACE_VIRTUAL_ROOT: "/workspace",
  devirtualizeRequestParams: vi.fn((params: unknown) => params),
  virtualizeResponsePaths: vi.fn((result: unknown) => result),
}));

vi.mock("@rodrigo-barraza/utilities-library", () => ({
  errorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

// ── Test Helpers ────────────────────────────────────────────

function createAgentClient(overrides: Record<string, unknown> = {}) {
  // Use require-style import to get the mocked version
  const { AgentClient } = require("../AgentClient.ts") as {
    AgentClient: new (options: Record<string, unknown>) => AgentClientInstance;
  };

  return new AgentClient({
    backendUrl: "wss://api.tools.rod.dev/ws/agent",
    roots: ["/home/rodrigo/development"],
    name: "TestHost",
    secret: "test-secret",
    ...overrides,
  });
}

interface AgentClientInstance extends EventEmitter {
  ws: MockWebSocket | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  heartbeatTimeout: ReturnType<typeof setTimeout> | null;
  agentId: string;
  connected: boolean;
  _startHeartbeat: () => void;
  _stopHeartbeat: () => void;
  _handleMessage: (message: Record<string, unknown>) => void;
  _send: (message: Record<string, unknown>) => void;
}

// ── Tests ───────────────────────────────────────────────────

describe("AgentClient — heartbeat mechanism", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("should send application-level agent.heartbeat JSON (not WS ping) on each heartbeat interval", () => {
    const agent = createAgentClient() as unknown as AgentClientInstance;
    agent.ws = new MockWebSocket();
    agent.connected = true;

    agent._startHeartbeat();

    // Advance past the 30s interval
    vi.advanceTimersByTime(30_000);

    // Should have sent an application-level heartbeat message
    const heartbeatMessage = agent.ws.sentMessages.find(
      (message) => message.method === "agent.heartbeat",
    );
    expect(heartbeatMessage).toBeDefined();
    expect(heartbeatMessage!.jsonrpc).toBe("2.0");
    expect(heartbeatMessage!.params).toEqual({ agentId: agent.agentId });

    agent._stopHeartbeat();
  });

  it("should NOT use WebSocket-level ping() frames", () => {
    const agent = createAgentClient() as unknown as AgentClientInstance;
    agent.ws = new MockWebSocket();
    agent.connected = true;

    const pingSpy = vi.spyOn(agent.ws, "ping");

    agent._startHeartbeat();
    vi.advanceTimersByTime(30_000);

    // WebSocket ping must NOT be called — reverse proxies absorb them
    expect(pingSpy).not.toHaveBeenCalled();

    agent._stopHeartbeat();
  });

  it("should terminate connection after heartbeat timeout (30s + 10s = 40s)", () => {
    const agent = createAgentClient() as unknown as AgentClientInstance;
    agent.ws = new MockWebSocket();
    agent.connected = true;

    const terminateSpy = vi.spyOn(agent.ws, "terminate");

    agent._startHeartbeat();

    // Advance 30s (interval fires, sends heartbeat, starts timeout)
    vi.advanceTimersByTime(30_000);
    expect(terminateSpy).not.toHaveBeenCalled();

    // Advance 10s more (timeout fires without receiving a response)
    vi.advanceTimersByTime(10_000);
    expect(terminateSpy).toHaveBeenCalledTimes(1);

    agent._stopHeartbeat();
  });

  it("should clear heartbeat timeout when server responds with agent.ping", () => {
    const agent = createAgentClient() as unknown as AgentClientInstance;
    agent.ws = new MockWebSocket();
    agent.connected = true;

    agent._startHeartbeat();

    // Advance 30s to trigger heartbeat
    vi.advanceTimersByTime(30_000);
    expect(agent.heartbeatTimeout).not.toBeNull();

    // Server responds with agent.ping — simulates the agent.heartbeat response
    agent._handleMessage({
      jsonrpc: "2.0",
      method: "agent.ping",
      params: {},
    });

    // The raw timeout reference won't be null (clearTimeout doesn't null the
    // field), but the timeout callback should NOT fire. Verify by advancing:
    const terminateSpy = vi.spyOn(agent.ws, "terminate");
    vi.advanceTimersByTime(10_000);
    expect(terminateSpy).not.toHaveBeenCalled();

    agent._stopHeartbeat();
  });

  it("should respond with agent.pong when receiving agent.ping from server", () => {
    const agent = createAgentClient() as unknown as AgentClientInstance;
    agent.ws = new MockWebSocket();
    agent.connected = true;

    agent._handleMessage({
      jsonrpc: "2.0",
      method: "agent.ping",
      params: {},
    });

    const pongMessage = agent.ws.sentMessages.find(
      (message) => message.method === "agent.pong",
    );
    expect(pongMessage).toBeDefined();
    expect(pongMessage!.params).toEqual({ agentId: agent.agentId });
  });

  it("should cleanly stop heartbeat — clearing both interval and timeout", () => {
    const agent = createAgentClient() as unknown as AgentClientInstance;
    agent.ws = new MockWebSocket();
    agent.connected = true;

    agent._startHeartbeat();
    expect(agent.heartbeatTimer).not.toBeNull();

    // Trigger a heartbeat to create a pending timeout
    vi.advanceTimersByTime(30_000);
    expect(agent.heartbeatTimeout).not.toBeNull();

    // Stop should clear everything
    agent._stopHeartbeat();
    expect(agent.heartbeatTimer).toBeNull();
    expect(agent.heartbeatTimeout).toBeNull();

    // Advancing further should NOT terminate the connection
    const terminateSpy = vi.spyOn(agent.ws, "terminate");
    vi.advanceTimersByTime(60_000);
    expect(terminateSpy).not.toHaveBeenCalled();
  });

  it("should survive multiple heartbeat cycles with server responses", () => {
    const agent = createAgentClient() as unknown as AgentClientInstance;
    agent.ws = new MockWebSocket();
    agent.connected = true;

    agent._startHeartbeat();

    // Simulate 5 successful heartbeat cycles
    for (let cycle = 0; cycle < 5; cycle++) {
      vi.advanceTimersByTime(30_000);

      // Server responds before the 10s timeout
      agent._handleMessage({
        jsonrpc: "2.0",
        method: "agent.ping",
        params: {},
      });
    }

    // Connection should still be alive after all cycles
    expect(agent.ws.readyState).toBe(MockWebSocket.OPEN);
    expect(agent.ws.sentMessages.filter(
      (message) => message.method === "agent.heartbeat",
    )).toHaveLength(5);

    agent._stopHeartbeat();
  });
});
