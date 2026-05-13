// ─── Jailed Local Command Execution ─────────────────────────
// Commands run inside a bubblewrap (bwrap) mount namespace
// when available, providing VM-like filesystem isolation.
// The process can only see workspace roots + system binaries.

import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { PathJail } from "../PathJail.js";
import logger from "../logger.js";

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

// ────────────────────────────────────────────────────────────
// Isolation Mode Detection
// ────────────────────────────────────────────────────────────

/**
 * Detect the best available process isolation strategy.
 *
 * - "bwrap"       — bubblewrap mount namespace (true VM-like isolation)
 * - "application" — CWD containment + restricted env (best-effort fallback)
 */
function detectIsolationMode() {
  try {
    execSync("which bwrap", { stdio: "pipe", timeout: 3000 });
    // Verify it actually works (some systems have it but unprivileged user can't use it)
    execSync("bwrap --ro-bind /usr /usr -- /usr/bin/echo ok", { stdio: "pipe", timeout: 5000 });
    return "bwrap";
  } catch {
    return "application";
  }
}

/**
 * Build the bwrap argument array for jailing a command.
 *
 * Bind-mounts system binaries read-only and workspace roots read-write.
 * The spawned process literally cannot see anything outside these mounts.
 *
 * @param {string[]} roots - Workspace root paths (read-write)
 * @param {string} cwd - Working directory inside the jail
 * @param {boolean} allowNetwork - Whether to allow network access
 * @returns {string[]}
 */
function buildBwrapArgs(roots, cwd, allowNetwork = true) {
  const args = [];

  // System binaries — read-only
  const systemBinds = [
    "/usr", "/lib", "/bin", "/sbin",
  ];

  // Optional system paths that may or may not exist
  const optionalBinds = [
    "/lib64", "/lib32",
    "/etc/resolv.conf", "/etc/ssl", "/etc/ca-certificates",
    "/etc/passwd", "/etc/group", "/etc/nsswitch.conf",
    "/etc/ld.so.cache", "/etc/ld.so.conf",
    "/etc/localtime", "/etc/timezone",
    "/etc/alternatives",
  ];

  for (const p of systemBinds) {
    if (existsSync(p)) {
      args.push("--ro-bind", p, p);
    }
  }

  for (const p of optionalBinds) {
    if (existsSync(p)) {
      args.push("--ro-bind", p, p);
    }
  }

  // Kernel interfaces
  args.push("--proc", "/proc");
  args.push("--dev", "/dev");
  args.push("--tmpfs", "/tmp");

  // Workspace roots — read-write (the whole point)
  for (const root of roots) {
    args.push("--bind", root, root);
  }

  // Working directory
  args.push("--chdir", cwd);

  // Die when parent dies (prevent orphaned jailed processes)
  args.push("--die-with-parent");

  // Network isolation (optional)
  if (!allowNetwork) {
    args.push("--unshare-net");
  }

  return args;
}

// ────────────────────────────────────────────────────────────
// Command Handler
// ────────────────────────────────────────────────────────────

export class CommandHandler {
  constructor(roots) {
    this.jail = new PathJail(roots);
    this.roots = this.jail.roots; // Resolved/realpath'd roots for bwrap
    this.isolationMode = detectIsolationMode();
    this.allowNetwork = (process.env.WORKSPACE_ALLOW_NETWORK || "true") === "true";

    if (this.isolationMode === "bwrap") {
      logger.success(`Command isolation: bwrap (mount namespace — VM-like)`);
    } else {
      logger.warn(`Command isolation: application-level (bwrap not available — reduced security)`);
      logger.warn(`User-created scripts CAN escape workspace roots without bwrap.`);
      logger.warn(`Install bubblewrap for true isolation: apt install bubblewrap`);
    }
  }

  /**
   * Validate CWD against workspace roots.
   */
  validateCwd(inputPath) {
    return this.jail.contains(inputPath);
  }

  /**
   * Execute a command inside the filesystem jail.
   */
  async run({ command, cwd, timeout = DEFAULT_TIMEOUT_MS }) {
    const clampedTimeout = Math.min(Math.max(timeout, 1000), MAX_TIMEOUT_MS);

    // Validate command is a non-empty string
    if (!command || typeof command !== "string") {
      return { success: false, stdout: "", stderr: "", exitCode: null, executionTimeMs: 0, error: "Command is required (string)" };
    }

    // Validate CWD is within roots
    const cwdValidation = this.validateCwd(cwd || this.roots[0]);
    if (!cwdValidation.safe) {
      return { success: false, stdout: "", stderr: "", exitCode: null, executionTimeMs: 0, error: `Invalid working directory: ${cwdValidation.error}` };
    }

    const startTime = performance.now();

    // Build spawn args based on isolation mode
    let spawnBin, spawnArgs, spawnCwd;

    if (this.isolationMode === "bwrap") {
      // Kernel-level isolation — command runs in a mount namespace
      const bwrapArgs = buildBwrapArgs(this.roots, cwdValidation.resolved, this.allowNetwork);
      spawnBin = "bwrap";
      spawnArgs = [...bwrapArgs, "--", "bash", "-l", "-c", command];
      spawnCwd = undefined; // bwrap handles --chdir
    } else {
      // Application-level fallback — CWD is validated but command can traverse
      spawnBin = "bash";
      spawnArgs = ["-l", "-c", command];
      spawnCwd = cwdValidation.resolved;
    }

    return new Promise((res) => {
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutLen = 0;
      let stderrLen = 0;
      let timedOut = false;
      let settled = false;

      const child = spawn(spawnBin, spawnArgs, {
        cwd: spawnCwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CI: "true",
          FORCE_COLOR: "0",
          NO_COLOR: "1",
          // Restrict HOME to first root in application mode
          ...(this.isolationMode === "application" && { HOME: this.roots[0] }),
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

    if (!command || typeof command !== "string") {
      return { success: false, stdout: "", stderr: "", exitCode: null, executionTimeMs: 0, error: "Command is required (string)" };
    }

    const cwdValidation = this.validateCwd(cwd || this.roots[0]);
    if (!cwdValidation.safe) {
      return { success: false, stdout: "", stderr: "", exitCode: null, executionTimeMs: 0, error: `Invalid working directory: ${cwdValidation.error}` };
    }

    const startTime = performance.now();

    // Build spawn args based on isolation mode
    let spawnBin, spawnArgs, spawnCwd;

    if (this.isolationMode === "bwrap") {
      const bwrapArgs = buildBwrapArgs(this.roots, cwdValidation.resolved, this.allowNetwork);
      spawnBin = "bwrap";
      spawnArgs = [...bwrapArgs, "--", "bash", "-l", "-c", command];
      spawnCwd = undefined;
    } else {
      spawnBin = "bash";
      spawnArgs = ["-l", "-c", command];
      spawnCwd = cwdValidation.resolved;
    }

    return new Promise((res) => {
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutLen = 0;
      let stderrLen = 0;
      let timedOut = false;
      let settled = false;

      const child = spawn(spawnBin, spawnArgs, {
        cwd: spawnCwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CI: "true",
          FORCE_COLOR: "0",
          NO_COLOR: "1",
          ...(this.isolationMode === "application" && { HOME: this.roots[0] }),
        },
        detached: false,
      });

      child.stdin.end();

      child.stdout.on("data", (chunk) => {
        if (stdoutLen < MAX_OUTPUT_BYTES) {
          stdoutChunks.push(chunk);
          stdoutLen += chunk.length;
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

      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, clampedTimeout);

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
