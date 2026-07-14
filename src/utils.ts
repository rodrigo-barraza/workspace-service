import { resolve, sep } from "node:path";
import { existsSync } from "node:fs";

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

// ── Containment ─────────────────────────────────────────────
//
// Inside Docker the container is the jail and containment is unnecessary
// (and would break legitimate access to e.g. /tmp). But the same code runs
// directly on user machines via the tray app and standalone binaries — there,
// without containment, any connected backend could read ~/.ssh or write
// ~/.bashrc. Default: ON outside Docker, OFF inside.
//
// Override with WORKSPACE_CONTAINMENT=on|off.
//
// Docker detection: /.dockerenv, or path virtualization being active
// (only the Docker deployment sets WORKSPACE_ACTUAL_ROOT).
const isDockerDeployment = existsSync("/.dockerenv") || isVirtualized;

export function isContainmentEnabled(): boolean {
  const setting = (process.env.WORKSPACE_CONTAINMENT || "").toLowerCase();
  if (setting === "on") return true;
  if (setting === "off") return false;
  return !isDockerDeployment;
}

function isContainedInRoots(resolved: string, roots: string[]): boolean {
  return roots.some((root) => {
    const resolvedRoot = resolve(root);
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + sep);
  });
}

// ── Blocked patterns ────────────────────────────────────────
//
// Mirrors the tools-service local BLOCKED_PATTERNS so an operation is refused
// the same way whether it executes locally on the server or remotely here.
// Always blocked — package internals and git object stores:
const BLOCKED_PATTERNS = [
  /node_modules\//,
  /\.git\/objects\//,
  /\.git\/hooks\//,
];
// Blocked unless this machine opts out. The server-side equivalent is the
// dynamic `security.allowEnvFiles` setting; the agent has no settings-store
// access, so the waiver is the machine-local env var WORKSPACE_ALLOW_ENV_FILES=on
// (these files live on THIS machine, so consent belongs here too).
const CREDENTIAL_PATTERNS = [
  /\.env$/,
  /\.env\.(?!example|sample|template|defaults|dist).+$/,
  /\.pem$/,
  /\.key$/,
  /id_rsa/,
  /id_ed25519/,
];

function credentialFilesAllowed(): boolean {
  return (process.env.WORKSPACE_ALLOW_ENV_FILES || "").toLowerCase() === "on";
}

/**
 * Validate and resolve an input path against workspace roots.
 * Relative paths resolve against roots[0] (the workspace root),
 * absolute paths resolve directly.
 *
 * When containment is enabled (host installs — see above), the resolved
 * path must fall under one of the configured roots. Note: containment is
 * lexical (`..` is normalized by resolve()); symlinks inside a root that
 * point outside it are not chased.
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

  if (isContainmentEnabled() && roots.length > 0 && !isContainedInRoots(resolved, roots)) {
    return {
      safe: false,
      resolved: "",
      error: `Path is outside the workspace root(s): ${sanitizedPath}. Accessible root(s): ${roots.join(", ")}`,
    };
  }

  // Normalize separators so patterns match on Windows binary builds too.
  const normalized = resolved.replace(/\\/g, "/");
  const activePatterns = credentialFilesAllowed()
    ? BLOCKED_PATTERNS
    : [...BLOCKED_PATTERNS, ...CREDENTIAL_PATTERNS];
  for (const pattern of activePatterns) {
    if (pattern.test(normalized)) {
      return {
        safe: false,
        resolved: "",
        error: `Path '${resolved}' matches blocked pattern: ${pattern.source}`,
      };
    }
  }

  return { safe: true, resolved };
}
