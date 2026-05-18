#!/usr/bin/env node
// ─── CLI Entry Point ────────────────────────────────────────

import { program } from "commander";
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { AgentClient } from "../AgentClient.ts";
import { startHealthServer } from "../health.ts";
import logger from "../logger.ts";

program
  .name("workspace-service")
  .description("Remote development sidecar — connects local workspace to a remote tools-service backend")
  .version("0.1.0")
  .option("-b, --backend <url>", "WebSocket URL of tools-service (or set WORKSPACE_BACKEND env var)")
  .option(
    "-w, --workspace <paths...>",
    "Local directory root(s) to expose (or set WORKSPACE_ROOTS env var, comma-separated)",
  )
  .option("-s, --secret <secret>", "API secret for authentication (or set WORKSPACE_SERVICE_SECRET env var)")
  .option("-n, --name <name>", "Human-readable name for this agent", hostname())
  .option("-r, --reconnect-interval <ms>", "Base reconnect delay in ms", "5000")
  .option("-p, --health-port <port>", "Health endpoint port", "5605")
  .parse();

const opts = program.opts();

// ── Resolve backend (CLI flag → env var) ───────────────────────
if (!opts.backend) {
  opts.backend = process.env.WORKSPACE_BACKEND;
}
if (!opts.backend) {
  logger.error("Missing --backend flag or WORKSPACE_BACKEND env var");
  process.exit(1);
}

// ── Resolve workspace roots (CLI flag → env var) ───────────────
if (!opts.workspace || opts.workspace.length === 0) {
  const envRoots = process.env.WORKSPACE_ROOTS;
  if (envRoots) {
    opts.workspace = envRoots.split(",").map((s: any) => s.trim()).filter(Boolean);
  }
}
if (!opts.workspace || opts.workspace.length === 0) {
  logger.error("Missing --workspace flag or WORKSPACE_ROOTS env var");
  process.exit(1);
}

// ── Validate workspace paths ───────────────────────────────────
const roots = opts.workspace.map((p: any) => resolve(p));
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
const healthPort = parseInt(opts.healthPort, 10) || 5605;

// ── Banner ─────────────────────────────────────────────────────
logger.info("Workspace Service");
logger.info(`Name ............. ${opts.name}`);
logger.info(`Backend .......... ${backendUrl}`);
logger.info(`Workspaces ....... ${roots.join(", ")}`);
logger.info(`Reconnect ........ ${reconnectInterval}ms`);
logger.info(`Health ........... :${healthPort}/health`);
logger.info(`Auth ............. ${secret ? "secret configured" : "none"}`);

// ── Start agent ────────────────────────────────────────────────
const agent = new AgentClient({
  backendUrl,
  roots,
  name: opts.name,
  secret,
  reconnectInterval,
});

agent.connect();

// ── Start health server ────────────────────────────────────────
startHealthServer(agent, healthPort);

// ── Graceful shutdown ──────────────────────────────────────────
function shutdown(signal: any) {
  logger.info(`Received ${signal}, shutting down…`);
  agent.disconnect();
  // Give the deregister message time to send
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

