// ============================================================
// Command Handler — Sandboxed Local Command Execution
// ============================================================
// Mirrors AgenticCommandService — allowlisted commands,
// CWD scoped to registered roots, subprocess with timeout.
// ============================================================

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import logger from "../logger.js";

// ────────────────────────────────────────────────────────────
// Constants (mirrored from AgenticCommandService)
// ────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

const ALLOWED_COMMANDS = new Set([
  "npm", "npx", "node",
  "eslint", "prettier", "tsc", "stylelint",
  "python3", "pip", "pip3",
  "git",
  "cat", "ls", "find", "wc", "diff", "which", "file", "head", "tail",
  "tree", "du",
  "ps", "lsof",
]);

const ALLOWED_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "branch", "tag",
  "stash", "remote", "describe", "shortlog",
  "rev-parse", "ls-files", "ls-tree", "blame",
  "config", "reflog",
  "add", "commit", "checkout", "switch", "restore",
  "merge", "rebase", "cherry-pick", "reset",
  "push", "pull", "fetch",
]);

const BLOCKED_PATTERNS = [
  /`/,
  /\$\(/,
  /\.\.\//,
  /\/dev\//,
  /\/proc\//,
  /\/sys\//,
  /\/etc\//,
  />\s*\//,
  />\s*~/,
  /rm\s+-rf/i,
  /\|\s*(bash|sh|zsh|dash)\b/,
  /eval\s+/,
  /source\s+/,
];

// ────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────

function validateCommand(command) {
  if (!command || typeof command !== "string") {
    return { valid: false, error: "Command is required (string)" };
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { valid: false, error: `Command contains blocked pattern: ${pattern.source}` };
    }
  }

  const tokens = command.trim().split(/\s+/);
  const binary = tokens[0];

  if (!ALLOWED_COMMANDS.has(binary)) {
    return {
      valid: false,
      error: `Command '${binary}' is not allowed. Allowed: ${[...ALLOWED_COMMANDS].sort().join(", ")}`,
    };
  }

  if (binary === "git" && tokens.length > 1) {
    let subIdx = 1;
    while (subIdx < tokens.length && tokens[subIdx].startsWith("-")) {
      subIdx += (tokens[subIdx] === "-C" || tokens[subIdx] === "--git-dir") ? 2 : 1;
    }
    const subcommand = tokens[subIdx];
    if (subcommand && !ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
      return {
        valid: false,
        error: `Git subcommand '${subcommand}' is not allowed.`,
      };
    }
  }

  return { valid: true };
}

// ────────────────────────────────────────────────────────────
// Command Handler
// ────────────────────────────────────────────────────────────

export class CommandHandler {
  constructor(roots) {
    this.roots = roots.map((r) => resolve(r));
  }

  validateCwd(inputPath) {
    if (!inputPath || typeof inputPath !== "string") {
      return { safe: false, resolved: "", error: "CWD is required" };
    }
    const resolved = resolve(inputPath);
    const inRoot = this.roots.some(
      (root) => resolved.startsWith(root + "/") || resolved === root,
    );
    if (!inRoot) {
      return { safe: false, resolved, error: `CWD '${resolved}' is outside allowed roots` };
    }
    return { safe: true, resolved };
  }

  async run({ command, cwd, timeout = DEFAULT_TIMEOUT_MS }) {
    const clampedTimeout = Math.min(Math.max(timeout, 1000), MAX_TIMEOUT_MS);

    const cmdValidation = validateCommand(command);
    if (!cmdValidation.valid) {
      return { success: false, stdout: "", stderr: "", exitCode: null, executionTimeMs: 0, error: cmdValidation.error };
    }

    const cwdValidation = this.validateCwd(cwd || this.roots[0]);
    if (!cwdValidation.safe) {
      return { success: false, stdout: "", stderr: "", exitCode: null, executionTimeMs: 0, error: `Invalid working directory: ${cwdValidation.error}` };
    }

    const startTime = performance.now();

    return new Promise((res) => {
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutLen = 0;
      let stderrLen = 0;
      let timedOut = false;
      let settled = false;

      const child = spawn("bash", ["-l", "-c", command], {
        cwd: cwdValidation.resolved,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CI: "true",
          FORCE_COLOR: "0",
          NO_COLOR: "1",
        },
        detached: false,
      });

      child.stdin.end();

      child.stdout.on("data", (chunk) => {
        if (stdoutLen < MAX_OUTPUT_BYTES) {
          stdoutChunks.push(chunk);
          stdoutLen += chunk.length;
        }
      });

      child.stderr.on("data", (chunk) => {
        if (stderrLen < MAX_OUTPUT_BYTES) {
          stderrChunks.push(chunk);
          stderrLen += chunk.length;
        }
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, clampedTimeout);

      function finish(exitCode) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        const executionTimeMs = Math.round(performance.now() - startTime);

        res({
          success: exitCode === 0 && !timedOut,
          stdout: stdoutLen > MAX_OUTPUT_BYTES ? stdout + "\n... [output truncated]" : stdout,
          stderr: stderrLen > MAX_OUTPUT_BYTES ? stderr + "\n... [output truncated]" : stderr,
          exitCode: timedOut ? null : exitCode,
          executionTimeMs,
          timedOut,
          ...(timedOut && { error: `Command timed out after ${clampedTimeout}ms` }),
        });
      }

      child.on("close", (code) => finish(code));
      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          res({
            success: false, stdout: "", stderr: "", exitCode: null,
            executionTimeMs: Math.round(performance.now() - startTime),
            error: `Process error: ${err.message}`,
          });
        }
      });
    });
  }

  /**
   * Streaming variant — sends chunked notifications during execution.
   * @param {object} params - { command, cwd, timeout }
   * @param {function} notify - (method, params) => void — sends RPC notifications back
   */
  async runStreaming({ command, cwd, timeout = DEFAULT_TIMEOUT_MS }, notify) {
    const clampedTimeout = Math.min(Math.max(timeout, 1000), MAX_TIMEOUT_MS);

    const cmdValidation = validateCommand(command);
    if (!cmdValidation.valid) {
      return { success: false, stdout: "", stderr: "", exitCode: null, executionTimeMs: 0, error: cmdValidation.error };
    }

    const cwdValidation = this.validateCwd(cwd || this.roots[0]);
    if (!cwdValidation.safe) {
      return { success: false, stdout: "", stderr: "", exitCode: null, executionTimeMs: 0, error: `Invalid working directory: ${cwdValidation.error}` };
    }

    const startTime = performance.now();

    return new Promise((res) => {
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutLen = 0;
      let stderrLen = 0;
      let timedOut = false;
      let settled = false;

      const child = spawn("bash", ["-l", "-c", command], {
        cwd: cwdValidation.resolved,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CI: "true",
          FORCE_COLOR: "0",
          NO_COLOR: "1",
        },
        detached: false,
      });

      child.stdin.end();

      child.stdout.on("data", (chunk) => {
        if (stdoutLen < MAX_OUTPUT_BYTES) {
          stdoutChunks.push(chunk);
          stdoutLen += chunk.length;
          // Send streaming chunk notification
          notify?.("command.stdout", { data: chunk.toString("utf-8") });
        }
      });

      child.stderr.on("data", (chunk) => {
        if (stderrLen < MAX_OUTPUT_BYTES) {
          stderrChunks.push(chunk);
          stderrLen += chunk.length;
          notify?.("command.stderr", { data: chunk.toString("utf-8") });
        }
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, clampedTimeout);

      function finish(exitCode) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        const executionTimeMs = Math.round(performance.now() - startTime);

        res({
          success: exitCode === 0 && !timedOut,
          stdout: stdoutLen > MAX_OUTPUT_BYTES ? stdout + "\n... [output truncated]" : stdout,
          stderr: stderrLen > MAX_OUTPUT_BYTES ? stderr + "\n... [output truncated]" : stderr,
          exitCode: timedOut ? null : exitCode,
          executionTimeMs,
          timedOut,
          ...(timedOut && { error: `Command timed out after ${clampedTimeout}ms` }),
        });
      }

      child.on("close", (code) => finish(code));
      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          res({
            success: false, stdout: "", stderr: "", exitCode: null,
            executionTimeMs: Math.round(performance.now() - startTime),
            error: `Process error: ${err.message}`,
          });
        }
      });
    });
  }
}
