import { fork, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { app } from "electron";
import { EventEmitter } from "node:events";
import type { AgentConfiguration, AgentConnectionStatus, AgentStatusInfo, LogEntry } from "../shared/types.js";

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

    this.appendLog("info", `Starting agent process → ${backendUrl}`);
  }

  stop(): void {
    if (this.childProcess) {
      this.appendLog("info", "Stopping agent process…");
      this.childProcess.send({ type: "shutdown" });
      const killTimeout = setTimeout(() => {
        if (this.childProcess) {
          this.childProcess.kill("SIGKILL");
          this.childProcess = null;
        }
      }, 3000);

      this.childProcess.on("exit", () => {
        clearTimeout(killTimeout);
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
