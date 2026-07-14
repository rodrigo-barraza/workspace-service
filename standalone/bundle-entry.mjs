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
// Version literal with an env override for builds. Ideally
// esbuild-standalone.mjs should eventually inject this at bundle
// time (e.g. via esbuild's `define`) instead of hardcoding it here.
export const AGENT_VERSION = process.env.AGENT_VERSION || "0.1.0";
