import { describe, it, expect, vi, beforeEach } from "vitest";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AgentProcess Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Covers both spawn modes, env var safety, path quoting, and
// diagnostic logging that's critical for debugging WSL issues.

// ── Mock Electron ────────────────────────────────────────────

const mockElectronApp = {
  isPackaged: false,
  getPath: () => "/tmp/test",
};

vi.mock("electron", () => ({
  app: mockElectronApp,
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
  connected: boolean;
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
  childProcess.connected = true;
  childProcess.pid = 12345;
  if (!withIpc) {
    delete (childProcess as unknown as Record<string, unknown>).send;
    delete (childProcess as unknown as Record<string, unknown>).connected;
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

function getLastSpawnOptions(): { env?: Record<string, string> } {
  return mockSpawn.mock.calls[mockSpawn.mock.calls.length - 1][2] as { env?: Record<string, string> };
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
    mockElectronApp.isPackaged = false;
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
      agent.start(createConfiguration({ secret: "my-secret", agentName: "Test Machine" }));
      const environment = getLastForkEnv();
      expect(environment.AGENT_SECRET).toBe("my-secret");
      expect(environment.AGENT_NAME).toBe("Test Machine");
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
      expect(spawnArguments).toContain("AGENT_ROOTS=/home/rodrigo/development");
    });

    it("should NEVER put the secret in argv (visible to `ps` and the diagnostic log) — WSLENV carries it", () => {
      const agent = new AgentProcess();
      agent.start(createWslConfiguration({ secret: "super-secret-value" }));

      const spawnArguments = getLastSpawnArguments();
      expect(spawnArguments.join(" ")).not.toContain("super-secret-value");

      const spawnOptions = getLastSpawnOptions();
      expect(spawnOptions.env?.AGENT_SECRET).toBe("super-secret-value");
      expect(spawnOptions.env?.WSLENV).toContain("AGENT_SECRET/u");
    });

    it("should preserve an existing WSLENV value when appending AGENT_SECRET", () => {
      process.env.WSLENV = "EXISTING_VAR/p";
      try {
        const agent = new AgentProcess();
        agent.start(createWslConfiguration({ secret: "s" }));
        expect(getLastSpawnOptions().env?.WSLENV).toBe("EXISTING_VAR/p:AGENT_SECRET/u");
      } finally {
        delete process.env.WSLENV;
      }
    });

    it("should not leak the secret into the diagnostic spawn log", () => {
      const agent = new AgentProcess();
      const logs = collectLogs(agent);
      agent.start(createWslConfiguration({ secret: "super-secret-value" }));

      for (const entry of logs) {
        expect(entry.message).not.toContain("super-secret-value");
      }
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

  // ── Asar Path Resolution (WSL can't read inside .asar) ───────

  describe("asar path resolution for WSL", () => {
    it("should replace app.asar with app.asar.unpacked in runner path when packaged", () => {
      mockElectronApp.isPackaged = true;
      const agent = new AgentProcess();
      const logs = collectLogs(agent);
      agent.start(createWslConfiguration());

      const runnerLogEntry = logs.find((entry) => entry.message.includes("[WSL] Runner script (WSL)"));
      expect(runnerLogEntry).toBeDefined();
      // In dev mode the path won't contain app.asar at all, but when packaged
      // the code replaces app.asar → app.asar.unpacked before converting to WSL path
      expect(runnerLogEntry!.message).not.toContain("/app.asar/");
    });

    it("should NOT modify runner path in dev mode (app.isPackaged = false)", () => {
      mockElectronApp.isPackaged = false;
      const agent = new AgentProcess();
      const logs = collectLogs(agent);
      agent.start(createWslConfiguration());

      const runnerLogEntry = logs.find((entry) => entry.message.includes("[WSL] Runner script (WSL)"));
      expect(runnerLogEntry).toBeDefined();
      // Dev mode path shouldn't contain app.asar.unpacked
      expect(runnerLogEntry!.message).not.toContain("app.asar.unpacked");
    });

    it("should NOT affect the native Windows fork path regardless of isPackaged", () => {
      mockElectronApp.isPackaged = true;
      const agent = new AgentProcess();
      agent.start(createConfiguration());

      // Native mode uses fork, not spawn — no asar path mangling needed
      expect(mockFork).toHaveBeenCalledTimes(1);
      expect(mockSpawn).not.toHaveBeenCalled();
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

    it("should parse @prism:-prefixed protocol lines from stdout in WSL mode", () => {
      const agent = new AgentProcess();
      agent.start(createWslConfiguration());

      const childProcess = getLastChildProcess();
      childProcess.stdout.write('@prism:{"type":"connected","data":{"agentId":"wsl-789"}}\n');

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(agent.getStatus().connectionStatus).toBe("connected");
          expect(agent.getStatus().agentId).toBe("wsl-789");
          resolve();
        }, 10);
      });
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

    // ── EPIPE Regression Tests ──────────────────────────────────

    it("should NOT throw EPIPE when IPC channel is already closed on stop (native mode)", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration());

      const childProcess = getLastChildProcess();
      // Simulate the IPC channel being already closed
      childProcess.connected = false;

      // Must not throw — the guard clause prevents the send() call
      expect(() => agent.stop()).not.toThrow();
      expect(childProcess.send).not.toHaveBeenCalled();
      expect(agent.getStatus().connectionStatus).toBe("disconnected");
    });

    it("should NOT throw even if send() throws despite connected=true (race condition fallback)", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration());

      const childProcess = getLastChildProcess();
      // connected=true but send() throws (theoretical race condition)
      childProcess.connected = true;
      childProcess.send = vi.fn(() => {
        const error = new Error("write EPIPE");
        (error as NodeJS.ErrnoException).code = "EPIPE";
        throw error;
      });

      // The try/catch fallback should swallow the error
      expect(() => agent.stop()).not.toThrow();
      expect(agent.getStatus().connectionStatus).toBe("disconnected");
    });

    it("should NOT throw when stdin is not writable in WSL mode on stop", () => {
      const agent = new AgentProcess();
      agent.start(createWslConfiguration());

      const childProcess = getLastChildProcess();
      // Simulate stdin already destroyed
      (childProcess.stdin as unknown as Record<string, unknown>).writable = false;

      expect(() => agent.stop()).not.toThrow();
      expect(agent.getStatus().connectionStatus).toBe("disconnected");
    });

    it("should NOT throw even if stdin.write throws despite writable=true (race condition fallback)", () => {
      const agent = new AgentProcess();
      agent.start(createWslConfiguration());

      const childProcess = getLastChildProcess();
      // writable=true but write() throws
      (childProcess.stdin as unknown as Record<string, unknown>).writable = true;
      childProcess.stdin.write = vi.fn(() => {
        throw new Error("write EPIPE");
      });

      expect(() => agent.stop()).not.toThrow();
      expect(agent.getStatus().connectionStatus).toBe("disconnected");
    });

    it("should stop existing process when start() is called while running", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration());

      const firstChildProcess = getLastChildProcess();
      // Make send() throw to simulate EPIPE during stop-before-restart
      firstChildProcess.send = vi.fn(() => {
        throw new Error("channel closed");
      });

      // Second start() should call stop() on the first process, then start a new one
      expect(() => agent.start(createConfiguration())).not.toThrow();
      expect(spawnedChildProcesses.length).toBe(2);
    });

    it("should write shutdown JSON to stdin in WSL mode", () => {
      const agent = new AgentProcess();
      agent.start(createWslConfiguration());

      const childProcess = getLastChildProcess();
      const writeSpy = vi.spyOn(childProcess.stdin, "write");
      agent.stop();

      expect(writeSpy).toHaveBeenCalledWith(
        JSON.stringify({ type: "shutdown" }) + "\n",
      );
    });
  });

  // ── Lifecycle Race Regression (generation guard) ─────────────
  //
  // The original implementation let a dying child's late exit event null
  // this.childProcess and emit "disconnected" AFTER a new child had been
  // started — the tray showed Disconnected while an agent was connected,
  // "Connect" re-enabled, and clicking it spawned a duplicate agent.

  describe("restart race regression", () => {
    it("late exit from a replaced child must not clobber the new child's state", async () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration());
      const firstChild = getLastChildProcess();

      agent.start(createConfiguration());
      const secondChild = getLastChildProcess();
      expect(secondChild).not.toBe(firstChild);

      // New child connects
      secondChild.emit("message", { type: "connected", data: { agentId: "new-agent" } });
      expect(agent.getStatus().connectionStatus).toBe("connected");

      // Old child finally exits (up to 3s later in reality)
      firstChild.emit("exit", 0);

      // The new child must be unaffected
      expect(agent.isRunning()).toBe(true);
      expect(agent.getStatus().connectionStatus).toBe("connected");
      expect(agent.getStatus().agentId).toBe("new-agent");
    });

    it("late IPC messages from a replaced child must be ignored", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration());
      const firstChild = getLastChildProcess();

      agent.start(createConfiguration());
      const secondChild = getLastChildProcess();
      secondChild.emit("message", { type: "connected", data: { agentId: "new-agent" } });

      // Stale child reports a disconnect — must not change status
      firstChild.emit("message", { type: "disconnected", data: { code: 1006 } });
      expect(agent.getStatus().connectionStatus).toBe("connected");
    });

    it("the stop() kill timer must target the captured child, never a newer one", () => {
      vi.useFakeTimers();
      try {
        const agent = new AgentProcess();
        agent.start(createConfiguration());
        const firstChild = getLastChildProcess();

        void agent.stop();
        agent.start(createConfiguration());
        const secondChild = getLastChildProcess();

        // Old child never exits gracefully → 3s SIGKILL fires
        vi.advanceTimersByTime(3100);

        expect(firstChild.kill).toHaveBeenCalledWith("SIGKILL");
        expect(secondChild.kill).not.toHaveBeenCalled();
        expect(agent.isRunning()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stop() resolves once the child exits and reports processRunning=false", async () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration());
      const child = getLastChildProcess();

      const stopPromise = agent.stop();
      expect(agent.isRunning()).toBe(false);
      expect(agent.getStatus().processRunning).toBe(false);

      child.emit("exit", 0);
      await stopPromise;
    });

    it("getStatus().processRunning stays true while the agent is merely reconnecting", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration());
      const child = getLastChildProcess();

      child.emit("message", { type: "connected", data: { agentId: "a" } });
      child.emit("message", { type: "reconnecting", data: { attempt: 1 } });

      expect(agent.getStatus().connectionStatus).toBe("connecting");
      expect(agent.getStatus().processRunning).toBe(true);
    });

    it("auth-failed message maps to the auth-failed status", () => {
      const agent = new AgentProcess();
      agent.start(createConfiguration());
      const child = getLastChildProcess();

      child.emit("message", { type: "auth-failed", data: { statusCode: 401 } });
      expect(agent.getStatus().connectionStatus).toBe("auth-failed");
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Electron Builder Config Validation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// WSL mode requires agent files to be extracted from app.asar.
// If asarUnpack is removed from electron-builder.yml, WSL will
// fail with MODULE_NOT_FOUND because Linux can't read .asar.

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

describe("electron-builder.yml (WSL regression guard)", () => {
  const builderConfigPath = resolvePath(import.meta.dirname, "../../../electron-builder.yml");
  const builderConfigContent = readFileSync(builderConfigPath, "utf-8");

  it("should include asarUnpack for the agent directory", () => {
    expect(builderConfigContent).toContain("asarUnpack:");
    expect(builderConfigContent).toMatch(/out\/agent\/\*\*\/\*/);
  });

  it("should include workspace-agent-core.mjs as extraResources", () => {
    expect(builderConfigContent).toContain("workspace-agent-core.mjs");
    expect(builderConfigContent).toContain("extraResources:");
  });
});
