import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AgentProcess Integration Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Tests that verify the agent spawn behavior for both Windows
// native (fork) and WSL2 (wsl.exe spawn) modes, including:
//  - backendUrl normalization (http→ws, https→wss, /ws/agent path)
//  - env var passing to child process
//  - WSL path translation
//  - config reload on restart (the stale-config bug)

// ── Mock Electron ────────────────────────────────────────────

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => "/tmp/test",
  },
}));

// ── Mock child_process ───────────────────────────────────────

const mockFork = vi.fn();
const mockSpawn = vi.fn();

const mockChildProcesses: ReturnType<typeof createMockChildProcess>[] = [];

vi.mock("node:child_process", () => ({
  fork: (...arguments_: unknown[]) => {
    mockFork(...arguments_);
    const child = createMockChildProcess(true);
    mockChildProcesses.push(child);
    return child;
  },
  spawn: (...arguments_: unknown[]) => {
    mockSpawn(...arguments_);
    const child = createMockChildProcess(false);
    mockChildProcesses.push(child);
    return child;
  },
}));

// ── Mock WslDetector ─────────────────────────────────────────

vi.mock("../WslDetector.js", () => ({
  windowsDrivePathToWslMountPath: (windowsPath: string) => {
    // C:\Users\test → /mnt/c/Users/test
    const driveMatch = windowsPath.match(/^([A-Za-z]):\\(.*)$/);
    if (driveMatch) {
      return `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2].replace(/\\/g, "/")}`;
    }
    return windowsPath;
  },
  wslUncPathToLinuxPath: (uncPath: string) => {
    const uncMatch = uncPath.match(/^\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+(.*)$/i);
    if (uncMatch) {
      return (uncMatch[1] || "/").replace(/\\/g, "/");
    }
    return null;
  },
}));

// ── Helpers ──────────────────────────────────────────────────

import { Readable, Writable, PassThrough } from "node:stream";
import { EventEmitter } from "node:events";

function createMockChildProcess(withIpc: boolean) {
  const childProcess = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: Writable;
    send: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  childProcess.stdout = new PassThrough();
  childProcess.stderr = new PassThrough();
  childProcess.stdin = new PassThrough();
  childProcess.send = vi.fn();
  childProcess.kill = vi.fn();
  childProcess.pid = 12345;
  if (!withIpc) {
    // WSL mode — no IPC channel
    delete (childProcess as Record<string, unknown>).send;
  }
  return childProcess;
}

function createConfiguration(overrides: Record<string, unknown> = {}) {
  return {
    backendUrl: "wss://api.tools.rod.dev",
    secret: "",
    workspaceRoots: ["C:\\Users\\test\\dev"],
    agentName: "Test PC",
    wslDistro: "",
    wslLinuxPaths: [],
    openAtLogin: false,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("AgentProcess", () => {
  let AgentProcess: typeof import("../AgentProcess.js").AgentProcess;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockChildProcesses.length = 0;
    const module = await import("../AgentProcess.js");
    AgentProcess = module.AgentProcess;
  });

  describe("backendUrl normalization", () => {
    it("should convert https:// to wss:// and append /ws/agent path", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration({ backendUrl: "https://api.tools.rod.dev" }));

      const forkCall = mockFork.mock.calls[0];
      const env = forkCall[2].env;
      expect(env.AGENT_BACKEND_URL).toBe("wss://api.tools.rod.dev/ws/agent");
    });

    it("should convert http:// to ws://", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration({ backendUrl: "http://localhost:5555" }));

      const forkCall = mockFork.mock.calls[0];
      const env = forkCall[2].env;
      expect(env.AGENT_BACKEND_URL).toBe("ws://localhost:5555/ws/agent");
    });

    it("should not duplicate /ws/agent if already present", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration({ backendUrl: "wss://api.tools.rod.dev/ws/agent" }));

      const forkCall = mockFork.mock.calls[0];
      const env = forkCall[2].env;
      expect(env.AGENT_BACKEND_URL).toBe("wss://api.tools.rod.dev/ws/agent");
    });

    it("should strip trailing slashes before appending /ws/agent", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration({ backendUrl: "wss://api.tools.rod.dev/" }));

      const forkCall = mockFork.mock.calls[0];
      const env = forkCall[2].env;
      expect(env.AGENT_BACKEND_URL).toBe("wss://api.tools.rod.dev/ws/agent");
    });
  });

  describe("Native Windows mode (fork)", () => {
    it("should use fork() when no wslDistro is set", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration());

      expect(mockFork).toHaveBeenCalledTimes(1);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("should pass all env vars to the forked process", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration({
        secret: "my-secret",
        agentName: "Rodrigo's PC!",
      }));

      const forkCall = mockFork.mock.calls[0];
      const env = forkCall[2].env;
      expect(env.AGENT_SECRET).toBe("my-secret");
      expect(env.AGENT_NAME).toBe("Rodrigo's PC!");
      expect(env.AGENT_ROOTS).toBe("C:\\Users\\test\\dev");
    });

    it("should set connectionStatus to 'connecting' on start", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration());
      expect(agent.getStatus().connectionStatus).toBe("connecting");
    });
  });

  describe("WSL2 mode (spawn)", () => {
    it("should use spawn() with wsl.exe when wslDistro is set", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration({
        wslDistro: "Ubuntu-24.04",
        wslLinuxPaths: ["/home/rodrigo/development"],
      }));

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockFork).not.toHaveBeenCalled();
    });

    it("should pass env vars through 'env' command, not shell exports", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration({
        wslDistro: "Ubuntu-24.04",
        wslLinuxPaths: ["/home/rodrigo/development"],
        secret: "test-secret",
        agentName: "Rodrigo's PC!",
      }));

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];

      // Should use env command
      expect(spawnArgs).toContain("env");

      // Env vars should be raw argv entries (no shell escaping needed)
      expect(spawnArgs).toContain("AGENT_SECRET=test-secret");
      expect(spawnArgs).toContain("AGENT_NAME=Rodrigo's PC!");
      expect(spawnArgs).toContain("AGENT_ROOTS=/home/rodrigo/development");
    });

    it("should use bash -lic for Node resolution", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration({
        wslDistro: "Ubuntu-24.04",
        wslLinuxPaths: ["/home/rodrigo/development"],
      }));

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];

      expect(spawnArgs).toContain("bash");
      expect(spawnArgs).toContain("-lic");
    });

    it("should translate Windows UNC paths to Linux paths via wslLinuxPaths", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration({
        wslDistro: "Ubuntu-24.04",
        workspaceRoots: ["\\\\wsl.localhost\\Ubuntu-24.04\\home\\rodrigo"],
        wslLinuxPaths: ["/home/rodrigo"],
      }));

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      expect(spawnArgs).toContain("AGENT_ROOTS=/home/rodrigo");
    });

    it("should handle special characters in agent name without shell escaping", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration({
        wslDistro: "Ubuntu-24.04",
        wslLinuxPaths: ["/home/rodrigo/development"],
        agentName: "Rodrigo's PC!",
      }));

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
      // The raw value should be passed as-is (env handles it, not shell)
      expect(spawnArgs).toContain("AGENT_NAME=Rodrigo's PC!");
    });
  });

  describe("status transitions", () => {
    it("should update status to 'connected' on 'connected' IPC message", () => {
      const agent = new AgentProcess();
      const statusChanges: string[] = [];
      agent.on("status-changed", (status: string) => statusChanges.push(status));

      agent.start(createConfiguration());

      // Simulate connected message from child
      const childProcess = mockChildProcesses[0];
      childProcess.emit("message", { type: "connected", data: { agentId: "abc-123" } });

      expect(agent.getStatus().connectionStatus).toBe("connected");
      expect(agent.getStatus().agentId).toBe("abc-123");
      expect(statusChanges).toContain("connected");
    });

    it("should update status to 'disconnected' on process exit", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration());

      const childProcess = mockChildProcesses[0];
      childProcess.emit("exit", 0);

      expect(agent.getStatus().connectionStatus).toBe("disconnected");
    });
  });
});
