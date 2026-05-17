// ── Smoke tests for workspace-service ──
// workspace-service is a CLI sidecar (not an Express service via createService),
// so we test the health server shape directly.
import { describe, it, expect } from "vitest";
describe("Health server", () => {
    it("startHealthServer is importable", async () => {
        const mod = await import("../src/health.js");
        expect(mod.startHealthServer).toBeTypeOf("function");
    });
});
describe("AgentClient", () => {
    it("AgentClient is importable", async () => {
        const mod = await import("../src/AgentClient.js");
        expect(mod.AgentClient).toBeTypeOf("function");
    });
});
describe("Logger", () => {
    it("exports a logger instance", async () => {
        const mod = await import("../src/logger.js");
        expect(mod.default).toBeTruthy();
    });
});
