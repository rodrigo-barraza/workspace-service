import { resolve } from "node:path";

// ────────────────────────────────────────────────────────────
// Root Virtualization
// ────────────────────────────────────────────────────────────
//
// The workspace agent exposes a virtual root "/" to the LLM so it can
// work with clean paths ("/src/foo.ts") instead of container-internal
// paths ("/workspace/src/foo.ts"). The actual mount point varies by
// deployment and MUST be explicitly configured via environment variable.
//
// WORKSPACE_VIRTUAL_ROOT  – the root the LLM sees (default: "/")
// WORKSPACE_ACTUAL_ROOT   – the real filesystem mount (default: "/", no-op)
//
// Docker deployments must set WORKSPACE_ACTUAL_ROOT=/workspace explicitly.
// When both are equal, virtualization is a no-op (standalone/WSL mode).

export const WORKSPACE_VIRTUAL_ROOT = process.env.WORKSPACE_VIRTUAL_ROOT || "/";
export const WORKSPACE_ACTUAL_ROOT  = process.env.WORKSPACE_ACTUAL_ROOT || WORKSPACE_VIRTUAL_ROOT;

// Whether virtualization is active (virtual ≠ actual)
export const isVirtualized =
  WORKSPACE_VIRTUAL_ROOT !== WORKSPACE_ACTUAL_ROOT;

/**
 * Convert a virtual path (LLM-facing) to an actual filesystem path.
 *
 * "/src/foo.ts"  →  "/workspace/src/foo.ts"
 * "."            →  "."   (relative paths pass through)
 * "/workspace/x" →  "/workspace/x"  (already actual, pass through)
 */
export function devirtualizePath(virtualPath: string): string {
  if (!virtualPath || !isVirtualized) return virtualPath;

  // Already points to actual root — pass through
  if (virtualPath === WORKSPACE_ACTUAL_ROOT || virtualPath.startsWith(WORKSPACE_ACTUAL_ROOT + "/")) {
    return virtualPath;
  }

  // Relative paths pass through — handlers resolve against roots[0]
  if (!virtualPath.startsWith("/")) return virtualPath;

  // Virtual root "/" maps to actual root "/workspace"
  if (virtualPath === "/") return WORKSPACE_ACTUAL_ROOT;
  return WORKSPACE_ACTUAL_ROOT + virtualPath;
}

/**
 * Convert an actual filesystem path to a virtual (LLM-facing) path.
 *
 * "/workspace/src/foo.ts"  →  "/src/foo.ts"
 * "/workspace"             →  "/"
 * "/etc/hosts"             →  "/etc/hosts"  (outside actual root, pass through)
 */
export function virtualizePath(actualPath: string): string {
  if (!actualPath || !isVirtualized) return actualPath;

  if (actualPath === WORKSPACE_ACTUAL_ROOT) return WORKSPACE_VIRTUAL_ROOT;
  if (actualPath.startsWith(WORKSPACE_ACTUAL_ROOT + "/")) {
    const relativeSuffix = actualPath.slice(WORKSPACE_ACTUAL_ROOT.length);
    return WORKSPACE_VIRTUAL_ROOT === "/"
      ? relativeSuffix
      : WORKSPACE_VIRTUAL_ROOT + relativeSuffix;
  }

  return actualPath;
}

// Known field names that contain filesystem paths in RPC requests.
// Only these fields are devirtualized on incoming RPC params.
const REQUEST_PATH_FIELD_NAMES = new Set([
  "path", "cwd", "source", "destination", "path1", "path2",
  "pathA", "pathB",
  "filePath", "repoPath", "projectPath", "watchRoot",
  "searchPath", "dirPath", "paths",
]);

// Known field names that contain filesystem paths in RPC responses.
// Only these fields are virtualized on outgoing RPC results.
const RESPONSE_PATH_FIELD_NAMES = new Set([
  "path", "filePath", "projectPath", "cwd", "source", "destination",
  "watchRoot", "resolved", "absolutePath", "file",
  "directory", "paths",
]);

/**
 * Recursively walk a JSON-serializable value and virtualize string
 * values in known path fields. Used at the RPC response boundary
 * so handler code doesn't need to know about virtualization.
 */
export function virtualizeResponsePaths(value: unknown, fieldName?: string): unknown {
  if (!isVirtualized) return value;

  if (typeof value === "string") {
    // Only virtualize if this is a known path field
    if (fieldName && RESPONSE_PATH_FIELD_NAMES.has(fieldName)) {
      return virtualizePath(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    // Arrays inherit the field name context (e.g., "paths": ["/workspace/a.ts"])
    return value.map((item) => virtualizeResponsePaths(item, fieldName));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, propertyValue] of Object.entries(value as Record<string, unknown>)) {
      result[key] = virtualizeResponsePaths(propertyValue, key);
    }
    return result;
  }
  return value;
}

/**
 * Recursively walk a JSON-serializable value and devirtualize string
 * values in known path fields. Used at the RPC request boundary
 * so handler code receives actual filesystem paths.
 */
export function devirtualizeRequestParams(value: unknown, fieldName?: string): unknown {
  if (!isVirtualized) return value;

  if (typeof value === "string") {
    // Only devirtualize if this is a known path field
    if (fieldName && REQUEST_PATH_FIELD_NAMES.has(fieldName)) {
      return devirtualizePath(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    // Arrays inherit the field name context (e.g., "paths": ["/src/a.ts"])
    return value.map((item) => devirtualizeRequestParams(item, fieldName));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, propertyValue] of Object.entries(value as Record<string, unknown>)) {
      result[key] = devirtualizeRequestParams(propertyValue, key);
    }
    return result;
  }
  return value;
}

// ────────────────────────────────────────────────────────────
// Centralized Path Validation
// ────────────────────────────────────────────────────────────

import type { PathValidation } from "./types.ts";

/**
 * Validate and resolve an input path against workspace roots.
 * Relative paths resolve against roots[0] (the workspace root),
 * absolute paths resolve directly.
 */
export function validateWorkspacePath(inputPath: string, roots: string[]): PathValidation {
  if (!inputPath || typeof inputPath !== "string") {
    return { safe: false, resolved: "", error: "Path is required" };
  }
  // Sanitize LLM-generated paths: strip surrounding quotes and whitespace.
  // Models sometimes send path values like `"."` or `'./src'` with literal
  // quote characters embedded in the string, producing invalid filesystem paths.
  const sanitizedPath = inputPath.trim().replace(/^["']+|["']+$/g, "").trim();
  if (!sanitizedPath) {
    return { safe: false, resolved: "", error: "Path is required" };
  }
  const resolved = sanitizedPath.startsWith("/")
    ? resolve(sanitizedPath)
    : resolve(roots[0], sanitizedPath);
  return { safe: true, resolved };
}
