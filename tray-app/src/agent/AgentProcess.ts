import { fork, spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { app } from "electron";
import { EventEmitter } from "node:events";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { AgentConfiguration, AgentConnectionStatus, AgentStatusInfo, LogEntry } from "../shared/types.js";
import { windowsDrivePathToWslMountPath, wslUncPathToLinuxPath } from "./WslDetector.js";

const MAX_LOG_ENTRIES = 500;
const AGENT_CORE_PATH = resolve(app.isPackaged
  ? resolve(process.resourcesPath, "workspace-agent-core.mjs")
  : resolve(import.meta.dirname, "../../../standalone/workspace-agent-core.mjs")
);

export class AgentProcess extends EventEmitter {
  private childProcess: ChildProcess | null = null;
  private connectionStatus: AgentConnectionStatus = "disconnected";
  private reconnectAttempts = 0;
  private agentId: string | null = null;
  private currentConfiguration: AgentConfiguration | null = null;
  private logBuffer: LogEntry[] = [];
  private stdoutLineReader: ReadlineInterface | null = null;

  start(configuration: AgentConfiguration): void {
    if (this.childProcess) {
      this.stop();
    }

    this.currentConfiguration = configuration;
    this.connectionStatus = "connecting";
    this.emit("status-changed", this.connectionStatus);

    let backendUrl = configuration.backendUrl;
    if (backendUrl.startsWith("http://")) backendUrl = backendUrl.replace("http://", "ws://");
    else if (backendUrl.startsWith("https://")) backendUrl = backendUrl.replace("https://", "wss://");
    if (!backendUrl.includes("/ws/agent")) backendUrl = backendUrl.replace(/\/+$/, "") + "/ws/agent";

    const isWslMode = !!(configuration.wslDistro && configuration.wslDistro.trim());

    if (isWslMode) {
      this.startWslAgent(configuration, backendUrl);
    } else {
      this.startNativeAgent(configuration, backendUrl);
    }
  }

  // ── Native Windows Mode (fork with IPC) ────────────────────

  private startNativeAgent(configuration: AgentConfiguration, backendUrl: string): void {
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
      const typedMessage = message as { type: string; data?: Record<string, unknown> };
      this.handleChildMessage(typedMessage);
    });

    this.attachOutputListeners();
    this.appendLog("info", `Starting agent process → ${backendUrl}`);
  }

  // ── WSL2 Mode (spawn wsl.exe with stdio JSON-line protocol) ──

  private startWslAgent(configuration: AgentConfiguration, backendUrl: string): void {
    const distroName = configuration.wslDistro.trim();

    // Translate paths: Windows → Linux-native
    const workspaceRoots = this.resolveWslRoots(configuration);
    const wslCorePath = windowsDrivePathToWslMountPath(AGENT_CORE_PATH);
    const agentScriptPath = resolve(import.meta.dirname, "./agent-runner.mjs");
    const wslRunnerPath = windowsDrivePathToWslMountPath(agentScriptPath);

    this.childProcess = spawn("wsl.exe", [
      "-d", distroName,
      "--",
      "env",
      `AGENT_BACKEND_URL=${backendUrl}`,
      `AGENT_SECRET=${configuration.secret}`,
      `AGENT_ROOTS=${workspaceRoots.join(",")}`,
      `AGENT_NAME=${configuration.agentName}`,
      `AGENT_CORE_PATH=${wslCorePath}`,
      "node", wslRunnerPath,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    // In WSL mode, IPC messages arrive as JSON lines on stdout.
    // We use readline to parse them line-by-line.
    if (this.childProcess.stdout) {
      this.stdoutLineReader = createInterface({ input: this.childProcess.stdout });
      this.stdoutLineReader.on("line", (line: string) => {
        const trimmedLine = line.trim();
        if (!trimmedLine) return;

        try {
          const parsedMessage = JSON.parse(trimmedLine);
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
      const text = chunk.toString("utf-8").trim();
      if (text) this.appendLog("error", text);
    });

    this.childProcess.on("exit", (code) => {
      this.cleanupStdoutReader();
      this.childProcess = null;
      this.connectionStatus = "disconnected";
      this.appendLog("warn", `Agent process exited with code ${code}`);
      this.emit("status-changed", this.connectionStatus);
    });

    this.childProcess.on("error", (error) => {
      this.cleanupStdoutReader();
      this.appendLog("error", `Agent process error: ${error.message}`);
      this.connectionStatus = "disconnected";
      this.emit("status-changed", this.connectionStatus);
    });

    this.appendLog("info", `Starting WSL2 agent (${distroName}) → ${backendUrl}`);
    this.appendLog("info", `WSL roots: ${workspaceRoots.join(", ")}`);
  }

  // ── Shared Lifecycle ───────────────────────────────────────

  private attachOutputListeners(): void {
    if (!this.childProcess) return;

    this.childProcess.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text) this.appendLog("info", text);
    });

    this.childProcess.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text) this.appendLog("error", text);
    });

    this.childProcess.on("exit", (code) => {
      this.childProcess = null;
      this.connectionStatus = "disconnected";
      this.appendLog("warn", `Agent process exited with code ${code}`);
      this.emit("status-changed", this.connectionStatus);
    });

    this.childProcess.on("error", (error) => {
      this.appendLog("error", `Agent process error: ${error.message}`);
      this.connectionStatus = "disconnected";
      this.emit("status-changed", this.connectionStatus);
    });
  }

  stop(): void {
    if (this.childProcess) {
      this.appendLog("info", "Stopping agent process…");

      const isWslMode = !!(this.currentConfiguration?.wslDistro?.trim());

      if (isWslMode) {
        // Stdio mode: send shutdown JSON to stdin
        try {
          this.childProcess.stdin?.write(JSON.stringify({ type: "shutdown" }) + "\n");
        } catch {
          // stdin may already be closed
        }
      } else {
        // IPC mode: send via process.send()
        this.childProcess.send({ type: "shutdown" });
      }

      const killTimeout = setTimeout(() => {
        if (this.childProcess) {
          this.childProcess.kill("SIGKILL");
          this.cleanupStdoutReader();
          this.childProcess = null;
        }
      }, 3000);

      this.childProcess.on("exit", () => {
        clearTimeout(killTimeout);
        this.cleanupStdoutReader();
        this.childProcess = null;
      });
    }
    this.connectionStatus = "disconnected";
    this.emit("status-changed", this.connectionStatus);
  }

  restart(): void {
    if (this.currentConfiguration) {
      this.stop();
      setTimeout(() => {
        if (this.currentConfiguration) {
          this.start(this.currentConfiguration);
        }
      }, 500);
    }
  }

  getStatus(): AgentStatusInfo {
    return {
      connectionStatus: this.connectionStatus,
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

  private cleanupStdoutReader(): void {
    if (this.stdoutLineReader) {
      this.stdoutLineReader.close();
      this.stdoutLineReader = null;
    }
  }

  private handleChildMessage(message: { type: string; data?: Record<string, unknown> }): void {
    switch (message.type) {
      case "connected":
        this.connectionStatus = "connected";
        this.reconnectAttempts = 0;
        this.agentId = (message.data?.agentId as string) || null;
        this.appendLog("success", "Connected to backend");
        this.emit("status-changed", this.connectionStatus);
        break;

      case "disconnected":
        this.connectionStatus = "disconnected";
        this.appendLog("warn", `Disconnected: code=${message.data?.code ?? "unknown"}`);
        this.emit("status-changed", this.connectionStatus);
        break;

      case "reconnecting":
        this.connectionStatus = "connecting";
        this.reconnectAttempts = (message.data?.attempt as number) || 0;
        this.appendLog("info", `Reconnecting (attempt ${this.reconnectAttempts})…`);
        this.emit("status-changed", this.connectionStatus);
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
