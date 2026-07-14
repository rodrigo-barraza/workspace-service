// ─── Health Server ──────────────────────────────────────────

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import logger from "./logger.ts";
import type { AgentClient } from "./AgentClient.ts";

const DEFAULT_PORT = 5605;

/**
 * Start a lightweight health HTTP server.
 */
export function startHealthServer(agent: AgentClient, port: number = DEFAULT_PORT) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
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

      // Always 200 — the service is alive, and disconnected states auto-reconnect
      // with backoff (see AgentClient close handler). A non-200 here would make
      // the Docker healthcheck restart the container while it waits for the backend.
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
