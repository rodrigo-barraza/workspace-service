// ─── Repository Hooks + Claude-Shaped Transcripts ───────────
//
// SHARED MODULE, byte-identical in two repositories (beside TaskEngine.ts):
//   workspace-service  src/handlers/WorkspaceHooks.ts
//   tools-service      src/services/tasks/WorkspaceHooks.ts
// A test in each repository fails when the copies differ: change one, then
// copy it over the other. Node built-ins only.
//
// A Prism agent working in a repository runs that repository's hooks — the
// guards Claude Code and Codex run there:
//   - runHookCommand    one hook command: the event JSON on stdin, the verdict
//                       back as exit code + stdout; at its deadline the whole
//                       process group is killed.
//   - readHooksConfig   the hooks files that apply to a directory: the nearest
//                       `.prism/hooks.json` at or above it (never above the
//                       registered root holding it), and the user's own
//                       `~/.prism/hooks.json`.
//   - appendTranscript  Claude Code-shaped JSONL lines, for hooks that read
//                       `transcript_path`.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  clampNumber,
  ensurePrivateDirectory,
  prismTempRoot,
  resolveShell,
  signalProcessGroup,
} from "./TaskEngine.ts";

export const HOOK_DEFAULT_TIMEOUT_MS = 60_000;
export const HOOK_MIN_TIMEOUT_MS = 500;
export const HOOK_MAX_TIMEOUT_MS = 600_000;
/** Each of stdout and stderr; a hook's answer is small. */
export const HOOK_MAX_OUTPUT_BYTES = 65_536;
/** The variables a caller may add to a hook's environment. */
export const HOOK_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
export const HOOKS_FILE_MAX_BYTES = 262_144;
export const HOOKS_FILE = join(".prism", "hooks.json");
export const TRANSCRIPT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export interface HookRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  error?: string;
}

export interface HooksFile {
  path: string;
  dir: string;
  exists: true;
  content: string;
  sha256: string;
  /** Set when the file is larger than HOOKS_FILE_MAX_BYTES (`content` is its start). */
  truncated?: true;
}

export interface HooksConfig {
  project: HooksFile | null;
  user: HooksFile | null;
}

// ────────────────────────────────────────────────────────────
// hook.run
// ────────────────────────────────────────────────────────────

/** A hook's deadline: default 60 s, within [0.5 s, 600 s]. */
export function clampHookRunTimeout(raw: unknown): number {
  return clampNumber(raw, HOOK_DEFAULT_TIMEOUT_MS, HOOK_MIN_TIMEOUT_MS, HOOK_MAX_TIMEOUT_MS);
}

/** The caller's additions: string values under conventional upper-case names only. */
export function filterHookEnvironment(extra: unknown): Record<string, string> {
  const filtered: Record<string, string> = {};
  if (typeof extra !== "object" || extra === null || Array.isArray(extra)) return filtered;
  for (const [name, value] of Object.entries(extra)) {
    if (HOOK_ENV_NAME_PATTERN.test(name) && typeof value === "string") filtered[name] = value;
  }
  return filtered;
}

/** A hook's environment: the host's own (credentials already stripped) plus the caller's additions. */
export function hookEnvironment(base: NodeJS.ProcessEnv, extra: unknown): NodeJS.ProcessEnv {
  return { ...base, ...filterHookEnvironment(extra) };
}

export function runHookCommand(
  {
    command,
    cwd,
    stdin = "",
    env,
    timeoutMs,
  }: { command: string; cwd: string; stdin?: string; env: NodeJS.ProcessEnv; timeoutMs: number },
  signal?: AbortSignal,
): Promise<HookRunResult> {
  const startedAt = Date.now();
  return new Promise<HookRunResult>((settle) => {
    const shell = resolveShell(command, { login: false });
    const child = spawn(shell.executable, shell.args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const stdout = cappedCollector(HOOK_MAX_OUTPUT_BYTES);
    const stderr = cappedCollector(HOOK_MAX_OUTPUT_BYTES);
    let timedOut = false;
    let settled = false;

    // A gate the agent loop waits on: no grace period, and pipes a straggler
    // inherited must not hold the answer back
    const kill = () => {
      signalProcessGroup(child, "SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    if (signal?.aborted) kill();

    const finish = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      settle({
        exitCode: timedOut ? null : exitCode,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        durationMs: Date.now() - startedAt,
        ...(error && { error }),
      });
    };

    child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
    // A hook that never reads its stdin closes the pipe under us; not an error
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
    child.on("error", (error: Error) => finish(null, error.message));
    child.on("close", (code: number | null) => finish(code));
  });
}

function cappedCollector(maxBytes: number) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  return {
    append(chunk: Buffer) {
      const room = maxBytes - bytes;
      if (room <= 0) return;
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks.push(kept);
      bytes += kept.length;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

// ────────────────────────────────────────────────────────────
// hooks.config
// ────────────────────────────────────────────────────────────

/** The most specific of `roots` holding `target` (absolute paths), or null. */
export function containingRoot(target: string, roots: readonly string[]): string | null {
  const resolvedTarget = resolve(target);
  let best: string | null = null;
  for (const root of roots) {
    const resolvedRoot = resolve(root);
    const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
    const holds = resolvedTarget === resolvedRoot || resolvedTarget.startsWith(prefix);
    if (holds && (best === null || resolvedRoot.length > best.length)) best = resolvedRoot;
  }
  return best;
}

/**
 * The hooks files for `root`: the nearest `.prism/hooks.json` at or above it,
 * walking up to `boundary` (the registered root holding it) and no further,
 * and `home`'s own. A missing file is null.
 */
export function readHooksConfig(root: string, boundary: string, home: string): HooksConfig {
  const user = readHooksFile(resolve(home));
  const stop = resolve(boundary);
  let project: HooksFile | null = null;
  for (let directory = resolve(root); ; ) {
    project = readHooksFile(directory);
    if (project || directory === stop) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  // The home directory's file is the user's, not a project's
  if (project && user && project.path === user.path) project = null;
  return { project, user };
}

function readHooksFile(directory: string): HooksFile | null {
  const path = join(directory, HOOKS_FILE);
  let bytes: Buffer;
  try {
    if (!statSync(path).isFile()) return null;
    bytes = readFileSync(path);
  } catch {
    return null;
  }
  return {
    path,
    dir: directory,
    exists: true,
    content: bytes.subarray(0, HOOKS_FILE_MAX_BYTES).toString("utf8"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...(bytes.length > HOOKS_FILE_MAX_BYTES && { truncated: true as const }),
  };
}

// ────────────────────────────────────────────────────────────
// transcript.append
// ────────────────────────────────────────────────────────────

/** `<tmp>/prism-<uid>/transcripts` */
export function transcriptsDirectory(): string {
  return join(prismTempRoot(), "transcripts");
}

/**
 * Append each line (an object) as one JSON line to the conversation's
 * transcript, created 0600. No lines: just the path.
 */
export function appendTranscript(
  conversationId: unknown,
  lines: unknown,
  directory: string = transcriptsDirectory(),
): { path: string } {
  if (typeof conversationId !== "string" || !TRANSCRIPT_ID_PATTERN.test(conversationId)) {
    throw new Error("'conversationId' must match ^[A-Za-z0-9._-]{1,128}$");
  }
  if (
    !Array.isArray(lines) ||
    !lines.every((line) => typeof line === "object" && line !== null && !Array.isArray(line))
  ) {
    throw new Error("'lines' must be an array of objects");
  }
  const path = join(directory, `${conversationId}.jsonl`);
  if (lines.length === 0) return { path };
  if (directory === transcriptsDirectory()) ensurePrivateDirectory(prismTempRoot());
  ensurePrivateDirectory(directory);
  appendFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(""), { mode: 0o600 });
  return { path };
}
