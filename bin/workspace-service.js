#!/usr/bin/env node
// ============================================================
// Workspace Service — CLI Entry Point
// ============================================================
// Usage:
//   workspace-service --backend ws://192.168.86.2:5590 --workspace /home/user/projects
//   workspace-service -b ws://localhost:5590 -w /home/user/repo1 -w /home/user/repo2
// ============================================================

import { program } from "commander";
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { AgentClient } from "../src/AgentClient.js";
import logger from "../src/logger.js";

program
  .name("workspace-service")
  .description("Remote development sidecar — connects local workspace to a remote tools-service backend")
  .version("0.1.0")
  .requiredOption("-b, --backend <url>", "WebSocket URL of tools-service (e.g. ws://192.168.86.2:5590)")
  .requiredOption(
    "-w, --workspace <paths...>",
    "Local directory root(s) to expose (repeatable)",
  )
  .option("-s, --secret <secret>", "API secret for authentication (or set WORKSPACE_SERVICE_SECRET env var)")
  .option("-n, --name <name>", "Human-readable name for this agent", hostname())
  .option("-r, --reconnect-interval <ms>", "Base reconnect delay in ms", "5000")
  .parse();

const opts = program.opts();

// ── Validate workspace paths ───────────────────────────────────
const roots = opts.workspace.map((p) => resolve(p));
for (const root of roots) {
  if (!existsSync(root)) {
    logger.error(`Workspace path does not exist: ${root}`);
    process.exit(1);
  }
  const st = statSync(root);
  if (!st.isDirectory()) {
    logger.error(`Workspace path is not a directory: ${root}`);
    process.exit(1);
  }
}

// ── Normalize backend URL ──────────────────────────────────────
let backendUrl = opts.backend;
// Ensure WebSocket protocol
if (backendUrl.startsWith("http://")) {
  backendUrl = backendUrl.replace("http://", "ws://");
} else if (backendUrl.startsWith("https://")) {
  backendUrl = backendUrl.replace("https://", "wss://");
}
// Append /ws/agent path if not already present
if (!backendUrl.includes("/ws/agent")) {
  backendUrl = backendUrl.replace(/\/+$/, "") + "/ws/agent";
}

const secret = opts.secret || process.env.WORKSPACE_SERVICE_SECRET || "";
const reconnectInterval = parseInt(opts.reconnectInterval, 10) || 5000;

// ── Banner ─────────────────────────────────────────────────────
console.log();
console.log("  🔌 Workspace Service");
console.log(`     Name ............. ${opts.name}`);
console.log(`     Backend .......... ${backendUrl}`);
console.log(`     Workspaces ....... ${roots.join(", ")}`);
console.log(`     Reconnect ........ ${reconnectInterval}ms`);
console.log(`     Auth ............. ${secret ? "secret configured" : "none"}`);
console.log();

// ── Start agent ────────────────────────────────────────────────
const agent = new AgentClient({
  backendUrl,
  roots,
  name: opts.name,
  secret,
  reconnectInterval,
});

agent.connect();

// ── Graceful shutdown ──────────────────────────────────────────
function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down…`);
  agent.disconnect();
  // Give the deregister message time to send
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
