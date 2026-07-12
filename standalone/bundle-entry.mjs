// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Bundle Entry Point — Re-exports for standalone consumers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// This is the esbuild entry point. It imports the canonical
// AgentClient from the TS source and re-exports it under the
// name the tray app and CLI wrapper expect (WorkspaceAgent).
//
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { AgentClient } from "../src/AgentClient.ts";
import { setLogger } from "./shims/logger-shim.mjs";
import { hostname } from "node:os";

// Re-export AgentClient under the name consumers expect
export { AgentClient as WorkspaceAgent };
export { setLogger };
export { hostname };
export const AGENT_VERSION = "0.1.0";
