import { describe, it, expect, vi, beforeEach } from "vitest";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AgentProcess Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Covers both spawn modes, env var safety, path quoting, and
// diagnostic logging that's critical for debugging WSL issues.

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

import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";

type MockChildProcess = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  send: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
};

const spawnedChildProcesses: MockChildProcess[] = [];

function createMockChildProcess(withIpc: boolean): MockChildProcess {
  const childProcess = new EventEmitter() as MockChildProcess;
  childProcess.stdout = new PassThrough();
  childProcess.stderr = new PassThrough();
  childProcess.stdin = new PassThrough();
  childProcess.send = vi.fn();
  childProcess.kill = vi.fn();
  childProcess.pid = 12345;
  if (!withIpc) {
    delete (childProcess as Record<string, unknown>).send;
  }
  return childProcess;
}

vi.mock("node:child_process", () => ({
  fork: (...arguments_: unknown[]) => {
    mockFork(...arguments_);
    const child = createMockChildProcess(true);
    spawnedChildProcesses.push(child);
    return child;
  },
  spawn: (...arguments_: unknown[]) => {
    mockSpawn(...arguments_);
    const child = createMockChildProcess(false);
    spawnedChildProcesses.push(child);
    return child;
  },
}));

// ── Mock WslDetector ─────────────────────────────────────────

vi.mock("../WslDetector.js", () => ({
  windowsDrivePathToWslMountPath: (windowsPath: string) => {
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

function createWslConfiguration(overrides: Record<string, unknown> = {}) {
  return createConfiguration({
    wslDistro: "Ubuntu-24.04",
    wslLinuxPaths: ["/home/rodrigo/development"],
    ...overrides,
  });
}

function getLastSpawnArguments(): string[] {
  return mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1][1] as string[];
}

function getLastForkEnv(): Record<string, string> {
  const lastCall = mockFork.mock.calls[mockFork.mock.calls.length - 1];
  return lastCall[2].env;
}

function getLastChildProcess(): MockChildProcess {
  return spawnedChildProcesses[spawnedChildProcesses.length - 1];
}

function collectLogs(agent: InstanceType<typeof AgentProcess>): Array<{ level: string; message: string }> {
  const collected: Array<{ level: string; message: string }> = [];
  agent.on("log", (entry: { level: string; message: string }) => collected.push(entry));
  return collected;
}

// ── Tests ────────────────────────────────────────────────────

let AgentProcess: typeof import("../AgentProcess.js").AgentProcess;

describe("AgentProcess", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    spawnedChildProcesses.length = 0;
    const module = await import("../AgentProcess.js");
    AgentProcess = module.AgentProcess;
  });

  // ── Backend URL Normalization ────────────────────────────────

  describe("backendUrl normalization", () => {
    it("should convert https:// to wss:// and append /ws/agent path", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration({ backendUrl: "https://api.tools.rod.dev" }));
      expect(getLastForkEnv().AGENT_BACKEND_URL).toBe("wss://api.tools.rod.dev/ws/agent");
    });

    it("should convert http:// to ws://", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration({ backendUrl: "http://localhost:5555" }));
      expect(getLastForkEnv().AGENT_BACKEND_URL).toBe("ws://localhost:5555/ws/agent");
    });

    it("should preserve wss:// and not duplicate /ws/agent", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration({ backendUrl: "wss://api.tools.rod.dev/ws/agent" }));
      expect(getLastForkEnv().AGENT_BACKEND_URL).toBe("wss://api.tools.rod.dev/ws/agent");
    });

    it("should strip trailing slashes before appending path", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration({ backendUrl: "wss://api.tools.rod.dev/" }));
      expect(getLastForkEnv().AGENT_BACKEND_URL).toBe("wss://api.tools.rod.dev/ws/agent");
    });
  });

  // ── Native Windows Mode ──────────────────────────────────────

  describe("Native Windows mode (fork)", () => {
    it("should use fork() when no wslDistro is set", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration());
      expect(mockFork).toHaveBeenCalledTimes(1);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("should pass all env vars to the forked process", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration({ secret: "my-secret", agentName: "Test Host" }));
      const environment = getLastForkEnv();
      expect(environment.AGENT_SECRET).toBe("my-secret");
      expect(environment.AGENT_NAME).toBe("Test Host");
      expect(environment.AGENT_ROOTS).toBe("C:\\Users\\test\\dev");
      expect(environment.AGENT_CORE_PATH).toBeDefined();
    });

    it("should set connectionStatus to 'connecting' on start", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration());
      expect(agent.getStatus().connectionStatus).toBe("connecting");
    });

    it("should pass empty string for empty secret (not undefined)", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration({ secret: "" }));
      expect(getLastForkEnv().AGENT_SECRET).toBe("");
    });
  });

  // ── WSL2 Mode ────────────────────────────────────────────────

  describe("WSL2 mode (spawn)", () => {
    it("should use spawn() with wsl.exe when wslDistro is set", () => {
      const agent = new AgentProcess();
      agent.start(createWslConfiguration());
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockFork).not.toHaveBeenCalled();
      expect(mockSpawn.mock.calls[0][0]).toBe("wsl.exe");
    });

    it("should pass -d <distro> -- as the first spawn arguments", () => {
      const agent = new AgentProcess();
      agent.start(createWslConfiguration());
      const spawnArguments = getLastSpawnArguments();
      expect(spawnArguments[0]).toBe("-d");
      expect(spawnArguments[1]).toBe("Ubuntu-24.04");
      expect(spawnArguments[2]).toBe("--");
    });

    it("should pass env vars as raw argv entries via the env command", () => {
      const agent = new AgentProcess();
      agent.start(createWslConfiguration({ secret: "test-secret" }));
      const spawnArguments = getLastSpawnArguments();

      expect(spawnArguments).toContain("env");
      expect(spawnArguments).toContain("AGENT_SECRET=test-secret");
      expect(spawnArguments).toContain("AGENT_ROOTS=/home/rodrigo/development");
    });

    it("should handle special characters in agent name (spaces, quotes, bangs)", () => {
      const agent = new AgentProcess();
      agent.start(createWslConfiguration({ agentName: "Rodrigo's PC!" }));
      const spawnArguments = getLastSpawnArguments();
      // The raw value must be passed as a single argv entry — no shell escaping
      expect(spawnArguments).toContain("AGENT_NAME=Rodrigo's PC!");
    });

    it("should use bash -lic for Node/NVM resolution", () => {
      const agent = new AgentProcess();
      agent.start(createWslConfiguration());
      const spawnArguments = getLastSpawnArguments();
      expect(spawnArguments).toContain("bash");
      expect(spawnArguments).toContain("-lic");
    });

    it("should single-quote the runner path in the bash command to handle spaces", () => {
      const agent = new AgentProcess();
      agent.start(createWslConfiguration());
      const spawnArguments = getLastSpawnArguments();

      // Find the bash command string (the argument after -lic)
      const bashCommandIndex = spawnArguments.indexOf("-lic") + 1;
      const bashCommand = spawnArguments[bashCommandIndex];

      // Runner path must be single-quoted to survive shell word-splitting
      expect(bashCommand).toMatch(/^exec node '.+'$/);
    });

    it("should translate workspace roots using wslLinuxPaths when provided", () => {
      const agent = new AgentProcess();
      agent.start(createWslConfiguration({
        workspaceRoots: ["\\\\wsl.localhost\\Ubuntu-24.04\\home\\rodrigo"],
        wslLinuxPaths: ["/home/rodrigo"],
      }));
      const spawnArguments = getLastSpawnArguments();
      expect(spawnArguments).toContain("AGENT_ROOTS=/home/rodrigo");
    });

    it("should convert Windows drive paths to /mnt/ paths as fallback", () => {
      const agent = new AgentProcess();
      agent.start(createWslConfiguration({
        wslLinuxPaths: [], // force fallback
        workspaceRoots: ["C:\\Users\\rodrigo\\dev"],
      }));
      const spawnArguments = getLastSpawnArguments();
      expect(spawnArguments).toContain("AGENT_ROOTS=/mnt/c/Users/rodrigo/dev");
    });
  });

  // ── Diagnostic Logging ───────────────────────────────────────

  describe("WSL diagnostic logging", () => {
    it("should log all resolved paths before spawning", () => {
      const agent = new AgentProcess();
      const logs = collectLogs(agent);
      agent.start(createWslConfiguration());

      const logMessages = logs.map((entry) => entry.message);
      expect(logMessages.some((message) => message.includes("[WSL] Distro: Ubuntu-24.04"))).toBe(true);
      expect(logMessages.some((message) => message.includes("[WSL] AGENT_ROOTS:"))).toBe(true);
      expect(logMessages.some((message) => message.includes("[WSL] AGENT_BACKEND_URL:"))).toBe(true);
      expect(logMessages.some((message) => message.includes("[WSL] Runner script (WSL):"))).toBe(true);
    });

    it("should log the full spawn arguments as JSON for debugging", () => {
      const agent = new AgentProcess();
      const logs = collectLogs(agent);
      agent.start(createWslConfiguration());

      const spawnLogEntry = logs.find((entry) => entry.message.includes('spawn("wsl.exe"'));
      expect(spawnLogEntry).toBeDefined();
      expect(spawnLogEntry!.message).toContain("-d");
      expect(spawnLogEntry!.message).toContain("Ubuntu-24.04");
    });

    it("should NOT log diagnostic spawn info for native Windows mode", () => {
      const agent = new AgentProcess();
      const logs = collectLogs(agent);
      agent.start(createConfiguration());

      const wslLogs = logs.filter((entry) => entry.message.includes("[WSL]"));
      expect(wslLogs).toHaveLength(0);
    });
  });

  // ── Status Transitions ───────────────────────────────────────

  describe("status transitions", () => {
    it("should update to 'connected' on connected IPC message (native)", () => {
      const agent = new AgentProcess();
      const statusChanges: string[] = [];
      agent.on("status-changed", (status: string) => statusChanges.push(status));

      agent.start(createConfiguration());
      const childProcess = getLastChildProcess();
      childProcess.emit("message", { type: "connected", data: { agentId: "abc-123" } });

      expect(agent.getStatus().connectionStatus).toBe("connected");
      expect(agent.getStatus().agentId).toBe("abc-123");
      expect(statusChanges).toContain("connected");
    });

    it("should update to 'disconnected' on process exit", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration());

      const childProcess = getLastChildProcess();
      childProcess.emit("exit", 0);

      expect(agent.getStatus().connectionStatus).toBe("disconnected");
      expect(agent.isRunning()).toBe(false);
    });

    it("should update to 'connecting' on reconnecting message", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration());

      const childProcess = getLastChildProcess();
      childProcess.emit("message", { type: "connected", data: { agentId: "abc" } });
      childProcess.emit("message", { type: "reconnecting", data: { attempt: 3, delayMs: 5000 } });

      expect(agent.getStatus().connectionStatus).toBe("connecting");
      expect(agent.getStatus().reconnectAttempts).toBe(3);
    });

    it("should parse JSON lines from stdout in WSL mode as IPC messages", () => {
      const agent = new AgentProcess();
      agent.start(createWslConfiguration());

      const childProcess = getLastChildProcess();
      const statusChanges: string[] = [];
      agent.on("status-changed", (status: string) => statusChanges.push(status));

      // Simulate agent-runner writing JSON to stdout (WSL stdio protocol)
      childProcess.stdout.write('{"type":"connected","data":{"agentId":"wsl-456"}}\n');

      // Allow readline to process
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(agent.getStatus().connectionStatus).toBe("connected");
          expect(agent.getStatus().agentId).toBe("wsl-456");
          resolve();
        }, 10);
      });
    });

    it("should log non-JSON stdout lines as raw info in WSL mode", () => {
      const agent = new AgentProcess();
      const logs = collectLogs(agent);
      agent.start(createWslConfiguration());

      const childProcess = getLastChildProcess();
      childProcess.stdout.write("bash: no job control in this shell\n");

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const rawLogs = logs.filter((entry) =>
            entry.message.includes("bash: no job control")
          );
          expect(rawLogs.length).toBeGreaterThan(0);
          resolve();
        }, 10);
      });
    });
  });

  // ── Stop / Lifecycle ─────────────────────────────────────────

  describe("stop and lifecycle", () => {
    it("should send IPC shutdown message in native mode", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration());

      const childProcess = getLastChildProcess();
      agent.stop();

      expect(childProcess.send).toHaveBeenCalledWith({ type: "shutdown" });
    });

    it("should set status to disconnected after stop", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration());
      agent.stop();
      expect(agent.getStatus().connectionStatus).toBe("disconnected");
    });

    it("should report isRunning as false before start", () => {
      const agent = new AgentProcess();
      expect(agent.isRunning()).toBe(false);
    });

    it("should report isRunning as true after start", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration());
      expect(agent.isRunning()).toBe(true);
    });
  });
});
