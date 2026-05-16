// ─── Container-Jailed Command Execution ─────────────────────
// The Docker container IS the isolation boundary (like WSL).
// Users have full root access inside — any command, any path.
// The container filesystem is the jail; nothing escapes it.

import { spawn } from "node:child_process";

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

// ────────────────────────────────────────────────────────────
// Command Handler
// ────────────────────────────────────────────────────────────

export class CommandHandler {
  constructor(roots) {
    this.roots = roots;
  }

  /**
   * Execute a command inside the container.
   * No restrictions — the container boundary is the jail.
   */
  async run({ command, cwd, timeout = DEFAULT_TIMEOUT_MS }) {
    const clampedTimeout = Math.min(Math.max(timeout, 1000), MAX_TIMEOUT_MS);

    if (!command || typeof command !== "string") {
      return { success: false, stdout: "", stderr: "", exitCode: null, executionTimeMs: 0, error: "Command is required (string)" };
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
        cwd: cwd || this.roots[0],
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
      child.on("error", (processError) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          res({
            success: false, stdout: "", stderr: "", exitCode: null,
            executionTimeMs: Math.round(performance.now() - startTime),
            error: `Process error: ${processError.message}`,
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

    const startTime = performance.now();

    return new Promise((res) => {
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutLen = 0;
      let stderrLen = 0;
      let timedOut = false;
      let settled = false;

      const child = spawn("bash", ["-l", "-c", command], {
        cwd: cwd || this.roots[0],
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
      child.on("error", (processError) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          res({
            success: false, stdout: "", stderr: "", exitCode: null,
            executionTimeMs: Math.round(performance.now() - startTime),
            error: `Process error: ${processError.message}`,
          });
        }
      });
    });
  }
}
