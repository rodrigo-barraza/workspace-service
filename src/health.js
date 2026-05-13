// ─── Health Server ──────────────────────────────────────────

import { createServer } from "node:http";
import logger from "./logger.js";

const DEFAULT_PORT = 5605;

/**
 * Start a lightweight health HTTP server.
 * @param {import("./AgentClient.js").AgentClient} agent
 * @param {number} [port]
 * @returns {import("node:http").Server}
 */
export function startHealthServer(agent, port = DEFAULT_PORT) {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      const payload = {
        status: agent.connected ? "ok" : "disconnected",
        service: "workspace-service",
        agentId: agent.agentId,
        name: agent.name,
        connected: agent.connected,
        backendUrl: agent.backendUrl,
        roots: agent.roots,
        reconnectAttempts: agent.reconnectAttempts,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      };

      // Always 200 — the service is alive and reconnecting is a normal transient state.
      // Docker healthcheck would otherwise restart the container while it waits for the backend.
      const statusCode = 200;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(port, () => {
    logger.info(`Health server listening on :${port}/health`);
  });

  return server;
}
