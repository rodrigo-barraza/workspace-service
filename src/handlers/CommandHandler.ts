// ─── Container-Jailed Command Execution ─────────────────────
// The Docker container IS the isolation boundary (like WSL).
// Users have full root access inside — any command, any path.
// The container filesystem is the jail; nothing escapes it.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { CommandRunParams, NotifyFn } from "../types.ts";

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

// Env vars that must never leak into LLM-run commands (`env` would dump them).
// Exact names plus a suffix pattern for credential-shaped vars.
const BLOCKED_ENV_NAMES = new Set(["MONGO_URI", "WORKSPACE_SERVICE_SECRET", "AGENT_SECRET"]);
const BLOCKED_ENV_PATTERN = /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY|API_KEY)$/i;

function sanitizedChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (BLOCKED_ENV_NAMES.has(name) || BLOCKED_ENV_PATTERN.test(name)) continue;
    env[name] = value;
  }
  env.CI = "true";
  env.FORCE_COLOR = "0";
  env.NO_COLOR = "1";
  return env;
}

// Shell resolution: prefer the Docker image's bash, fall back for host
// installs (standalone/tray agents on macOS, Windows, non-Debian Linux).
function resolveShell(command: string): { executable: string; args: string[] } {
  if (process.platform === "win32") {
    const comSpec = process.env.ComSpec || "cmd.exe";
    return { executable: comSpec, args: ["/d", "/s", "/c", command] };
  }
  const bashPath = existsSync("/usr/bin/bash") ? "/usr/bin/bash" : "bash";
  return { executable: bashPath, args: ["-l", "-c", command] };
}

/**
 * Kill a spawned command and all of its descendants. The child is spawned
 * `detached` so it leads its own process group — signalling the negative pid
 * reaches grandchildren (`npm run dev` etc.), which a bare child.kill() never
 * does, leaving orphans running against the container memory cap.
 */
function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // No process group (Windows / already-dead group) — best-effort direct kill
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone
    }
  }
}

// ────────────────────────────────────────────────────────────
// Command Result
// ────────────────────────────────────────────────────────────

interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  executionTimeMs: number;
  timedOut?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  error?: string;
}

// ────────────────────────────────────────────────────────────
// Command Handler
// ────────────────────────────────────────────────────────────

export class CommandHandler {
  roots: string[];
  constructor(roots: string[]) {
    this.roots = roots;
  }

  /**
   * Execute a command inside the container.
   * No restrictions — the container boundary is the jail.
   */
  async run(params: CommandRunParams): Promise<CommandResult> {
    return this._execute(params, undefined);
  }

  /**
   * Streaming variant — sends chunked notifications during execution.
   */
  async runStreaming(params: CommandRunParams, notify: NotifyFn): Promise<CommandResult> {
    return this._execute(params, notify);
  }

  private async _execute({ command, cwd, timeout = DEFAULT_TIMEOUT_MS, runInBackground = false }: CommandRunParams, notify: NotifyFn | undefined): Promise<CommandResult> {
    const clampedTimeout = Math.min(Math.max(timeout, 1000), MAX_TIMEOUT_MS);

    if (!command || typeof command !== "string") {
      return { success: false, stdout: "", stderr: "", exitCode: null, executionTimeMs: 0, error: "Command is required (string)" };
    }

    // The local tools-service supports run_in_background via a process registry.
    // This remote agent has none: a "backgrounded" command would just run to the
    // timeout and then be SIGKILLed, silently losing the process. Refuse honestly
    // instead of pretending to background it.
    if (runInBackground) {
      return {
        success: false,
        stdout: "",
        stderr: "",
        exitCode: null,
        executionTimeMs: 0,
        error: "Background execution is not supported on this remote workspace agent; the command would be killed at the timeout. Run without run_in_background, or run it on the local workspace.",
      };
    }

    const startTime = performance.now();
    const shell = resolveShell(command);

    return new Promise((resolve: (value: CommandResult) => void) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutLen = 0;
      let stderrLen = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let settled = false;

      const child = spawn(shell.executable, shell.args, {
        cwd: cwd ? path.resolve(cwd) : this.roots[0],
        stdio: ["pipe", "pipe", "pipe"],
        env: sanitizedChildEnv(),
        // Own process group so a timeout can kill the whole tree
        detached: process.platform !== "win32",
      });

      child.stdin?.end();

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdoutLen >= MAX_OUTPUT_BYTES) {
          // A chunk landing exactly on the cap used to drop the marker —
          // track truncation explicitly instead of inferring from length
          stdoutTruncated = true;
          return;
        }
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
        if (stdoutLen > MAX_OUTPUT_BYTES) stdoutTruncated = true;
        notify?.("command.stdout", { data: chunk.toString("utf-8") });
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrLen >= MAX_OUTPUT_BYTES) {
          stderrTruncated = true;
          return;
        }
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
        if (stderrLen > MAX_OUTPUT_BYTES) stderrTruncated = true;
        notify?.("command.stderr", { data: chunk.toString("utf-8") });
      });

      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
        // Unblock `close` even if some descendant inherited our stdio pipes
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, clampedTimeout);

      function finish(exitCode: number | null) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        const executionTimeMs = Math.round(performance.now() - startTime);

        resolve({
          success: exitCode === 0 && !timedOut,
          stdout: stdoutTruncated ? stdout + "\n... [output truncated]" : stdout,
          stderr: stderrTruncated ? stderr + "\n... [output truncated]" : stderr,
          exitCode: timedOut ? null : exitCode,
          executionTimeMs,
          timedOut,
          stdoutTruncated,
          stderrTruncated,
          ...(timedOut && { error: `Command timed out after ${clampedTimeout}ms` }),
        });
      }

      child.on("close", (code: number | null) => finish(code));
      child.on("error", (processError: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({
            success: false, stdout: "", stderr: "", exitCode: null,
            executionTimeMs: Math.round(performance.now() - startTime),
            error: `Process error: ${processError.message}`,
          });
        }
      });
    });
  }
}
