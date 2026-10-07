// ─── Container-Jailed Command Execution ─────────────────────
// The Docker container IS the isolation boundary (like WSL).
// Users have full root access inside — any command, any path.
// The container filesystem is the jail; nothing escapes it.

import { spawn } from "node:child_process";
import path from "node:path";
import type { CommandRunParams, NotifyFn } from "../types.ts";
import {
  KILL_GRACE_MS,
  backgroundCommandResult,
  clampCommandTimeout,
  resolveShell,
  terminateProcessGroup,
} from "./TaskEngine.ts";
import type { BackgroundCommandResult, TaskEngine } from "./TaskEngine.ts";

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

const MAX_OUTPUT_BYTES = 512 * 1024;

// Env vars that must never leak into LLM-run commands (`env` would dump them).
// Exact names plus a suffix pattern for credential-shaped vars.
const BLOCKED_ENV_NAMES = new Set(["MONGO_URI", "WORKSPACE_SERVICE_SECRET", "AGENT_SECRET"]);
const BLOCKED_ENV_PATTERN = /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY|API_KEY)$/i;

/** This process's environment minus credentials — what commands, tasks and hooks run with. */
export function sanitizedChildEnv(): NodeJS.ProcessEnv {
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
  taskEngine: TaskEngine | null;
  constructor(roots: string[], taskEngine: TaskEngine | null = null) {
    this.roots = roots;
    this.taskEngine = taskEngine;
  }

  /**
   * Execute a command inside the container.
   * No restrictions — the container boundary is the jail.
   */
  async run(params: CommandRunParams): Promise<CommandResult | BackgroundCommandResult> {
    return this._execute(params, undefined);
  }

  /**
   * Streaming variant — sends chunked notifications during execution.
   */
  async runStreaming(params: CommandRunParams, notify: NotifyFn): Promise<CommandResult | BackgroundCommandResult> {
    return this._execute(params, notify);
  }

  private async _execute(
    { command, cwd, timeout, runInBackground = false, description, owner }: CommandRunParams,
    notify: NotifyFn | undefined,
  ): Promise<CommandResult | BackgroundCommandResult> {
    // Claude Code's Bash: default 120 s, at most 600 s, then the group is killed
    const clampedTimeout = clampCommandTimeout(timeout);

    if (!command || typeof command !== "string") {
      return { success: false, stdout: "", stderr: "", exitCode: null, executionTimeMs: 0, error: "Command is required (string)" };
    }

    const workingDirectory = cwd ? path.resolve(this.roots[0] ?? "/", cwd) : this.roots[0];

    // run_in_background: a shell task — detached, no time limit, its output
    // in a file, and a task.exit notification when it ends
    if (runInBackground) {
      if (!this.taskEngine) {
        return { success: false, stdout: "", stderr: "", exitCode: null, executionTimeMs: 0, error: "Background tasks are not available on this workspace agent" };
      }
      try {
        return backgroundCommandResult(
          this.taskEngine.start({ kind: "shell", command, cwd: workingDirectory, description, owner }),
        );
      } catch (error: unknown) {
        return {
          success: false, stdout: "", stderr: "", exitCode: null, executionTimeMs: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }
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
      let forceCloseTimer: ReturnType<typeof setTimeout> | null = null;

      const child = spawn(shell.executable, shell.args, {
        cwd: workingDirectory,
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

      // At the deadline: SIGTERM the group, SIGKILL it 2 s later. Never backgrounded.
      const timer = setTimeout(() => {
        timedOut = true;
        terminateProcessGroup(child);
        // Unblock `close` even if some descendant outside the group inherited our pipes
        forceCloseTimer = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, KILL_GRACE_MS + 500);
      }, clampedTimeout);

      function finish(exitCode: number | null) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceCloseTimer) clearTimeout(forceCloseTimer);

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
          if (forceCloseTimer) clearTimeout(forceCloseTimer);
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
