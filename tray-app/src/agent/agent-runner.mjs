#!/usr/bin/env node

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Agent Runner — Forked child process for the tray app
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// This script is forked by AgentProcess.ts and communicates
// with the parent via IPC messages. It imports and runs the
// WorkspaceAgent from workspace-agent-core.mjs.
//
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { resolve } from "node:path";
import { existsSync } from "node:fs";

const corePath = process.env.AGENT_CORE_PATH;
if (!corePath || !existsSync(corePath)) {
  process.send?.({ type: "error", data: { message: `Agent core module not found at: ${corePath}` } });
  process.exit(1);
}

const { WorkspaceAgent, setLogger } = await import(corePath);

const backendUrl = process.env.AGENT_BACKEND_URL;
const secret = process.env.AGENT_SECRET || "";
const roots = (process.env.AGENT_ROOTS || "").split(",").map((root) => root.trim()).filter(Boolean);
const agentName = process.env.AGENT_NAME || "workspace-agent";

if (!backendUrl || roots.length === 0) {
  process.send?.({ type: "error", data: { message: "Missing AGENT_BACKEND_URL or AGENT_ROOTS" } });
  process.exit(1);
}

setLogger({
  info:    (message) => process.send?.({ type: "log", data: { level: "info", message } }),
  success: (message) => process.send?.({ type: "log", data: { level: "success", message } }),
  warn:    (message) => process.send?.({ type: "log", data: { level: "warn", message } }),
  error:   (message) => process.send?.({ type: "log", data: { level: "error", message } }),
  rpc:     (direction, method, id) => process.send?.({ type: "log", data: { level: "rpc", message: `${direction === "in" ? "←" : "→"} ${method} (${id})` } }),
});

const agent = new WorkspaceAgent({ backendUrl, roots, name: agentName, secret });

agent.on("connected", () => {
  process.send?.({ type: "connected", data: { agentId: agent.agentId } });
});

agent.on("disconnected", (detail) => {
  process.send?.({ type: "disconnected", data: detail });
});

agent.on("reconnecting", (detail) => {
  process.send?.({ type: "reconnecting", data: detail });
});

agent.on("error", (detail) => {
  process.send?.({ type: "error", data: detail });
});

agent.connect();

process.on("message", (message) => {
  if (message?.type === "shutdown") {
    agent.disconnect();
    setTimeout(() => process.exit(0), 500);
  }
});

process.on("SIGINT", () => {
  agent.disconnect();
  setTimeout(() => process.exit(0), 500);
});

process.on("SIGTERM", () => {
  agent.disconnect();
  setTimeout(() => process.exit(0), 500);
});
