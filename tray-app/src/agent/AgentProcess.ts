import { fork, spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { app } from "electron";
import { EventEmitter } from "node:events";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { AgentConfiguration, AgentConnectionStatus, AgentStatusInfo, LogEntry } from "../shared/types.js";
import { windowsDrivePathToWslMountPath, wslUncPathToLinuxPath } from "./WslDetector.js";

const MAX_LOG_ENTRIES = 500;
const STOP_KILL_TIMEOUT_MS = 3000;
// Stdio-protocol frame prefix (WSL mode). Distinguishes control messages from
// stray shell output (.bashrc echo, bash job-control warnings) that would
// otherwise interleave with the JSON-line protocol.
const STDIO_PROTOCOL_PREFIX = "@prism:";

const AGENT_CORE_PATH = resolve(app.isPackaged
  ? resolve(process.resourcesPath, "workspace-agent-core.mjs")
  : resolve(import.meta.dirname, "../../../standalone/workspace-agent-core.mjs")
);

export class AgentProcess extends EventEmitter {
  private childProcess: ChildProcess | null = null;
  // Incremented on every start() and stop(). Handlers attached to a child
  // capture the generation at spawn time and no-op if it has moved on — a
  // dying child's late exit/error events can no longer clobber the state of
  // a newer child (the root cause of "tray says Disconnected while an agent
  // is connected" and duplicate-agent spawns).
  private generation = 0;
  private connectionStatus: AgentConnectionStatus = "disconnected";
  private reconnectAttempts = 0;
  private agentId: string | null = null;
  private currentConfiguration: AgentConfiguration | null = null;
  private logBuffer: LogEntry[] = [];
  private stdoutLineReader: ReadlineInterface | null = null;

  start(configuration: AgentConfiguration): void {
    if (this.childProcess) {
      // Fire-and-forget: stop() detaches the old child synchronously (it can
      // no longer touch our state) and reaps it in the background.
      void this.stop();
    }

    this.currentConfiguration = configuration;
    const spawnGeneration = ++this.generation;
    this.setStatus("connecting");

    let backendUrl = configuration.backendUrl;
    if (backendUrl.startsWith("http://")) backendUrl = backendUrl.replace("http://", "ws://");
    else if (backendUrl.startsWith("https://")) backendUrl = backendUrl.replace("https://", "wss://");
    if (!backendUrl.includes("/ws/agent")) backendUrl = backendUrl.replace(/\/+$/, "") + "/ws/agent";

    const isWslMode = !!(configuration.wslDistro && configuration.wslDistro.trim());

    if (isWslMode) {
      this.startWslAgent(configuration, backendUrl, spawnGeneration);
    } else {
      this.startNativeAgent(configuration, backendUrl, spawnGeneration);
    }
  }

  // ── Native Windows Mode (fork with IPC) ────────────────────

  private startNativeAgent(configuration: AgentConfiguration, backendUrl: string, spawnGeneration: number): void {
    const agentScriptPath = resolve(import.meta.dirname, "./agent-runner.mjs");

    this.childProcess = fork(agentScriptPath, [], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        AGENT_BACKEND_URL: backendUrl,
        AGENT_SECRET: configuration.secret,
        AGENT_ROOTS: configuration.workspaceRoots.join(","),
        AGENT_NAME: configuration.agentName,
        AGENT_CORE_PATH: AGENT_CORE_PATH,
      },
    });

    this.childProcess.on("message", (message: unknown) => {
      if (spawnGeneration !== this.generation) return;
      const typedMessage = message as { type: string; data?: Record<string, unknown> };
      this.handleChildMessage(typedMessage);
    });

    this.attachOutputListeners(spawnGeneration);
    this.appendLog("info", `Starting agent process → ${backendUrl}`);
  }

  // ── WSL2 Mode (spawn wsl.exe with stdio JSON-line protocol) ──

  private startWslAgent(configuration: AgentConfiguration, backendUrl: string, spawnGeneration: number): void {
    const distroName = configuration.wslDistro.trim();

    // Translate paths: Windows → Linux-native
    const workspaceRoots = this.resolveWslRoots(configuration);
    const wslCorePath = windowsDrivePathToWslMountPath(AGENT_CORE_PATH);

    // The runner script lives inside Electron's app.asar when packaged.
    // WSL/Linux can't read inside .asar archives — it's an opaque file to the
    // native filesystem. electron-builder's asarUnpack extracts agent files to
    // app.asar.unpacked/, so we swap the path segment for WSL access.
    let agentScriptPath = resolve(import.meta.dirname, "./agent-runner.mjs");
    if (app.isPackaged) {
      agentScriptPath = agentScriptPath.replace("app.asar", "app.asar.unpacked");
    }
    const wslRunnerPath = windowsDrivePathToWslMountPath(agentScriptPath);

    // Log all resolved paths and env values for diagnostics (never the secret)
    this.appendLog("info", `[WSL] Distro: ${distroName}`);
    this.appendLog("info", `[WSL] AGENT_CORE_PATH (Windows): ${AGENT_CORE_PATH}`);
    this.appendLog("info", `[WSL] AGENT_CORE_PATH (WSL):     ${wslCorePath}`);
    this.appendLog("info", `[WSL] Runner script (Windows):    ${agentScriptPath}`);
    this.appendLog("info", `[WSL] Runner script (WSL):        ${wslRunnerPath}`);
    this.appendLog("info", `[WSL] AGENT_ROOTS:                ${workspaceRoots.join(",")}`);
    this.appendLog("info", `[WSL] AGENT_NAME:                 ${configuration.agentName}`);
    this.appendLog("info", `[WSL] AGENT_BACKEND_URL:          ${backendUrl}`);

    // Build spawn args — env vars as raw argv entries (no shell escaping),
    // bash -lic to resolve Node through .bashrc/nvm initialization.
    // See WslDetector.ts header for why this specific pattern is required.
    //
    // The secret is deliberately NOT an argv entry: argv is visible to every
    // process in the distro via `ps`, and used to leak into the diagnostic
    // spawn log below (shown in the Settings → Logs tab). It crosses the
    // Windows→WSL boundary via WSLENV instead.
    const spawnArguments = [
      "-d", distroName,
      "--",
      "env",
      `AGENT_BACKEND_URL=${backendUrl}`,
      `AGENT_ROOTS=${workspaceRoots.join(",")}`,
      `AGENT_NAME=${configuration.agentName}`,
      `AGENT_CORE_PATH=${wslCorePath}`,
      `AGENT_WSL_DISTRO=${distroName}`,
      "bash", "-lic", `exec node '${wslRunnerPath}'`,
    ];

    this.appendLog("info", `[WSL] spawn("wsl.exe", ${JSON.stringify(spawnArguments)})`);

    // WSLENV with the /u flag forwards the variable from Windows into WSL.
    const existingWslEnv = process.env.WSLENV;
    const wslEnvForwarding = existingWslEnv ? `${existingWslEnv}:AGENT_SECRET/u` : "AGENT_SECRET/u";

    this.childProcess = spawn("wsl.exe", spawnArguments, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        AGENT_SECRET: configuration.secret,
        WSLENV: wslEnvForwarding,
      },
    });

    // In WSL mode, IPC messages arrive as prefixed JSON lines on stdout.
    // We use readline to parse them line-by-line.
    if (this.childProcess.stdout) {
      this.stdoutLineReader = createInterface({ input: this.childProcess.stdout });
      this.stdoutLineReader.on("line", (line: string) => {
        if (spawnGeneration !== this.generation) return;
        const trimmedLine = line.trim();
        if (!trimmedLine) return;

        // Preferred framing: "@prism:{json}" — immune to stray shell output
        const jsonPayload = trimmedLine.startsWith(STDIO_PROTOCOL_PREFIX)
          ? trimmedLine.slice(STDIO_PROTOCOL_PREFIX.length)
          : trimmedLine;

        try {
          const parsedMessage = JSON.parse(jsonPayload);
          if (parsedMessage && typeof parsedMessage.type === "string") {
            this.handleChildMessage(parsedMessage);
            return;
          }
        } catch {
          // Not JSON — treat as raw log output
        }

        this.appendLog("info", trimmedLine);
      });
    }

    this.childProcess.stderr?.on("data", (chunk: Buffer) => {
      if (spawnGeneration !== this.generation) return;
      const text = chunk.toString("utf-8").trim();
      if (text) this.appendLog("error", text);
    });

    this.attachExitListeners(spawnGeneration);

    this.appendLog("info", `Starting WSL2 agent (${distroName}) → ${backendUrl}`);
    this.appendLog("info", `WSL roots: ${workspaceRoots.join(", ")}`);
  }

  // ── Shared Lifecycle ───────────────────────────────────────

  private attachOutputListeners(spawnGeneration: number): void {
    if (!this.childProcess) return;

    this.childProcess.stdout?.on("data", (chunk: Buffer) => {
      if (spawnGeneration !== this.generation) return;
      const text = chunk.toString("utf-8").trim();
      if (text) this.appendLog("info", text);
    });

    this.childProcess.stderr?.on("data", (chunk: Buffer) => {
      if (spawnGeneration !== this.generation) return;
      const text = chunk.toString("utf-8").trim();
      if (text) this.appendLog("error", text);
    });

    this.attachExitListeners(spawnGeneration);
  }

  private attachExitListeners(spawnGeneration: number): void {
    if (!this.childProcess) return;

    this.childProcess.on("exit", (code) => {
      if (spawnGeneration !== this.generation) return;
      this.cleanupStdoutReader();
      this.childProcess = null;
      this.appendLog("warn", `Agent process exited with code ${code}`);
      this.setStatus("disconnected");
    });

    this.childProcess.on("error", (error) => {
      if (spawnGeneration !== this.generation) return;
      this.cleanupStdoutReader();
      this.appendLog("error", `Agent process error: ${error.message}`);
      this.setStatus("disconnected");
    });
  }

  /**
   * Stop the current agent child. Synchronously detaches it from this
   * instance's state (so a subsequent start() is immediately safe), then
   * reaps it in the background: graceful shutdown message → SIGKILL after
   * STOP_KILL_TIMEOUT_MS. The returned promise resolves when the child has
   * exited (or been sent SIGKILL) — await it where the actual exit matters,
   * e.g. before app quit.
   */
  stop(): Promise<void> {
    const child = this.childProcess;
    // Invalidate all handlers attached to the current child
    this.generation++;
    this.childProcess = null;
    this.cleanupStdoutReader();

    if (!child) {
      this.setStatus("disconnected");
      return Promise.resolve();
    }

    this.appendLog("info", "Stopping agent process…");

    const isWslMode = !!(this.currentConfiguration?.wslDistro?.trim());

    if (isWslMode) {
      // Stdio mode: send shutdown JSON to stdin
      try {
        if (child.stdin?.writable) {
          child.stdin.write(JSON.stringify({ type: "shutdown" }) + "\n");
        }
      } catch {
        // stdin may already be closed
      }
    } else {
      // IPC mode: send via process.send()
      try {
        if (child.connected) {
          child.send({ type: "shutdown" });
        }
      } catch {
        // IPC channel may already be closed
      }
    }

    this.setStatus("disconnected");

    return new Promise<void>((resolvePromise) => {
      let settled = false;
      const finish = (exitCode: number | null | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        this.appendLog("info", `Agent process stopped${exitCode !== undefined ? ` (code ${exitCode})` : ""}`);
        resolvePromise();
      };

      // The timer holds the CAPTURED child — never this.childProcess, which
      // may already point at a newer process by the time it fires.
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already dead
        }
        finish(undefined);
      }, STOP_KILL_TIMEOUT_MS);
      killTimer.unref?.();

      child.once("exit", (code) => finish(code));
    });
  }

  async restart(): Promise<void> {
    if (this.currentConfiguration) {
      // start() detaches the old child itself — no sleep needed (the old
      // 500ms setTimeout dance was a race with the 3s kill timer)
      this.start(this.currentConfiguration);
    }
  }

  getStatus(): AgentStatusInfo {
    return {
      connectionStatus: this.connectionStatus,
      processRunning: this.isRunning(),
      reconnectAttempts: this.reconnectAttempts,
      agentId: this.agentId,
      backendUrl: this.currentConfiguration?.backendUrl ?? null,
      roots: this.currentConfiguration?.workspaceRoots ?? [],
      name: this.currentConfiguration?.agentName ?? null,
    };
  }

  getLogs(): LogEntry[] {
    return [...this.logBuffer];
  }

  isRunning(): boolean {
    return this.childProcess !== null;
  }

  // ── WSL Path Resolution ────────────────────────────────────

  private resolveWslRoots(configuration: AgentConfiguration): string[] {
    // If the user already provided explicit Linux paths, use those
    if (configuration.wslLinuxPaths && configuration.wslLinuxPaths.length > 0) {
      return configuration.wslLinuxPaths;
    }

    // Otherwise translate Windows UNC paths → Linux paths
    return configuration.workspaceRoots.map((windowsRoot) => {
      const uncResult = wslUncPathToLinuxPath(windowsRoot);
      if (uncResult) {
        return uncResult.linuxPath;
      }
      // If it's a regular Windows drive path, mount via /mnt/
      return windowsDrivePathToWslMountPath(windowsRoot);
    });
  }

  // ── Internal Helpers ───────────────────────────────────────

  private setStatus(status: AgentConnectionStatus): void {
    if (this.connectionStatus === status) return;
    this.connectionStatus = status;
    this.emit("status-changed", status);
  }

  private cleanupStdoutReader(): void {
    if (this.stdoutLineReader) {
      this.stdoutLineReader.close();
      this.stdoutLineReader = null;
    }
  }

  private handleChildMessage(message: { type: string; data?: Record<string, unknown> }): void {
    switch (message.type) {
      case "connected":
        this.reconnectAttempts = 0;
        this.agentId = (message.data?.agentId as string) || null;
        this.appendLog("success", "Connected to backend");
        this.setStatus("connected");
        break;

      case "disconnected":
        this.appendLog("warn", `Disconnected: code=${message.data?.code ?? "unknown"}`);
        this.setStatus("disconnected");
        break;

      case "reconnecting":
        this.reconnectAttempts = (message.data?.attempt as number) || 0;
        this.appendLog("info", `Reconnecting (attempt ${this.reconnectAttempts})…`);
        this.setStatus("connecting");
        break;

      case "auth-failed":
        this.appendLog("error", "Authentication failed — check the API secret in Settings");
        this.setStatus("auth-failed");
        break;

      case "error":
        this.appendLog("error", (message.data?.message as string) || "Unknown error");
        break;

      case "log":
        this.appendLog(
          (message.data?.level as LogEntry["level"]) || "info",
          (message.data?.message as string) || ""
        );
        break;
    }
  }

  private appendLog(level: LogEntry["level"], message: string): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };
    this.logBuffer.push(entry);
    if (this.logBuffer.length > MAX_LOG_ENTRIES) {
      this.logBuffer = this.logBuffer.slice(-MAX_LOG_ENTRIES);
    }
    this.emit("log", entry);
  }
}

export const agentProcess = new AgentProcess();
