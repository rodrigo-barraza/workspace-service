#!/usr/bin/env node

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Agent Runner — Forked child process for the tray app
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// This script is forked by AgentProcess.ts and communicates
// with the parent via IPC messages. It imports and runs the
// WorkspaceAgent from workspace-agent-core.mjs.
//
// Transport modes (auto-detected):
//   • IPC mode:   process.send() exists (Node fork with IPC channel)
//   • Stdio mode: no IPC — uses stdout JSON lines + stdin for shutdown
//                 (used when spawned inside WSL2 via wsl.exe)
//
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

const isIpcAvailable = typeof process.send === "function";

function sendMessage(message) {
  if (isIpcAvailable) {
    process.send(message);
  } else {
    process.stdout.write(JSON.stringify(message) + "\n");
  }
}

const corePath = process.env.AGENT_CORE_PATH;
if (!corePath || !existsSync(corePath)) {
  sendMessage({ type: "error", data: { message: `Agent core module not found at: ${corePath}` } });
  process.exit(1);
}

const { WorkspaceAgent, setLogger } = await import(pathToFileURL(corePath).href);

const backendUrl = process.env.AGENT_BACKEND_URL;
const secret = process.env.AGENT_SECRET || "";
const roots = (process.env.AGENT_ROOTS || "").split(",").map((root) => root.trim()).filter(Boolean);
const agentName = process.env.AGENT_NAME || "workspace-agent";

if (!backendUrl || roots.length === 0) {
  sendMessage({ type: "error", data: { message: "Missing AGENT_BACKEND_URL or AGENT_ROOTS" } });
  process.exit(1);
}

setLogger({
  info:    (message) => sendMessage({ type: "log", data: { level: "info", message } }),
  success: (message) => sendMessage({ type: "log", data: { level: "success", message } }),
  warn:    (message) => sendMessage({ type: "log", data: { level: "warn", message } }),
  error:   (message) => sendMessage({ type: "log", data: { level: "error", message } }),
  rpc:     (direction, method, id) => sendMessage({ type: "log", data: { level: "rpc", message: `${direction === "in" ? "←" : "→"} ${method} (${id})` } }),
});

const agent = new WorkspaceAgent({ backendUrl, roots, name: agentName, secret });

agent.on("connected", () => {
  sendMessage({ type: "connected", data: { agentId: agent.agentId } });
});

agent.on("disconnected", (detail) => {
  sendMessage({ type: "disconnected", data: detail });
});

agent.on("reconnecting", (detail) => {
  sendMessage({ type: "reconnecting", data: detail });
});

agent.on("error", (detail) => {
  sendMessage({ type: "error", data: detail });
});

agent.connect();

// ── Shutdown listeners ─────────────────────────────────────────

function gracefulShutdown() {
  agent.disconnect();
  setTimeout(() => process.exit(0), 500);
}

if (isIpcAvailable) {
  // IPC mode: parent sends { type: "shutdown" } over the IPC channel
  process.on("message", (message) => {
    if (message?.type === "shutdown") {
      gracefulShutdown();
    }
  });
} else {
  // Stdio mode: parent writes JSON lines to our stdin
  const stdinReader = createInterface({ input: process.stdin });
  stdinReader.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (message?.type === "shutdown") {
        gracefulShutdown();
      }
    } catch {
      // Ignore non-JSON input
    }
  });
  stdinReader.on("close", () => {
    gracefulShutdown();
  });
}

process.on("SIGINT", () => {
  gracefulShutdown();
});

process.on("SIGTERM", () => {
  gracefulShutdown();
});
