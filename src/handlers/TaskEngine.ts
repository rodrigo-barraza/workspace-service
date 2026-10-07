// ─── Background Tasks — Claude Code's background Bash and Monitor ───
//
// SHARED MODULE, byte-identical in two repositories:
//   workspace-service  src/handlers/TaskEngine.ts        (the bridge, on the user's machine)
//   tools-service      src/services/tasks/TaskEngine.ts  (local mode, inside the service)
// A test in each repository fails when the copies differ: change one, then
// copy it over the other. Node built-ins and `ws` only.
//
// A task outlives the call that started it:
//   - shell    `bash -l -c <command>` in its own process group; stdout and
//              stderr go straight into the task's output file; no time limit.
//   - monitor  a command whose stdout lines are events (stderr only reaches
//              the output file), or a WebSocket whose frames are events.
//              Lines that arrive within 200 ms of the first one become ONE
//              `task.event`. It ends at exit/close, at its deadline, on a
//              stop, or when it produces too many events.
// Every task ends with ONE `task.exit`. Events and the exit share a per-task
// `seq` (1, 2, …), and the last 500 notifications are kept so a listener
// that missed some can replay them (`events`).

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import WebSocket from "ws";

// ────────────────────────────────────────────────────────────
// Limits — one place, both repositories
// ────────────────────────────────────────────────────────────

/** A foreground command (Claude Code's Bash): default and bounds, in ms. */
export const COMMAND_DEFAULT_TIMEOUT_MS = 120_000;
export const COMMAND_MIN_TIMEOUT_MS = 1_000;
export const COMMAND_MAX_TIMEOUT_MS = 600_000;
/** Killing a process group: SIGTERM, then SIGKILL this much later. */
export const KILL_GRACE_MS = 2_000;

/** A monitor's deadline (Claude Code's Monitor `timeout_ms`). */
export const MONITOR_DEFAULT_TIMEOUT_MS = 300_000;
export const MONITOR_MIN_TIMEOUT_MS = 1_000;
export const MONITOR_MAX_TIMEOUT_MS = 1_800_000;
/** Lines within this window of the first one form one event. */
export const EVENT_BATCH_WINDOW_MS = 200;
/** Past either rate a monitor is stopped with `too_many_events`. */
export const EVENT_RATE_LIMITS: ReadonlyArray<EventRateLimit> = [
  { batches: 30, windowMs: 10_000 },
  { batches: 300, windowMs: 600_000 },
];
/** What one event carries at most; the rest is in the output file. */
export const EVENT_MAX_LINES = 100;
export const EVENT_MAX_CHARS = 16_000;
export const EVENT_LINE_MAX_CHARS = 4_000;

/** Notifications (events + the exit) kept per task for replay. */
export const NOTIFICATION_BUFFER_SIZE = 500;
/** A finished task, and its output file, is kept this long. */
export const FINISHED_TASK_TTL_MS = 3_600_000;
/** `outputTail` on the exit: the end of the output file. */
export const OUTPUT_TAIL_BYTES = 4_096;

export const TASK_ID_PATTERN = /^(shell|monitor)-[0-9a-z]{8}$/;

/** After a monitor's process exits, how long its stdout may still drain. */
const STDOUT_DRAIN_MS = 1_000;
const WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 30_000;
const SWEEP_INTERVAL_MS = 60_000;
const DESCRIPTION_MAX_CHARS = 500;
const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const BASH_CANDIDATES = ["/usr/bin/bash", "/bin/bash", "/usr/local/bin/bash"];

// ────────────────────────────────────────────────────────────
// Wire shapes (JSON-RPC params and results)
// ────────────────────────────────────────────────────────────

export type TaskKind = "shell" | "monitor";
export type TaskExitStatus =
  | "completed"
  | "failed"
  | "killed"
  | "timeout"
  | "too_many_events"
  | "closed"
  | "exited";
export type TaskStatus = "running" | TaskExitStatus;
/** Who a task belongs to (conversationId, agentConversationId, project, username, …). */
export type TaskOwner = Record<string, string>;

export interface EventRateLimit {
  batches: number;
  windowMs: number;
}

export interface TaskStartParams {
  kind: TaskKind;
  command?: string;
  ws?: { url: string; protocols?: string | string[] };
  cwd?: string;
  description?: string;
  timeoutMs?: number;
  owner?: Record<string, unknown>;
}

export interface TaskStartResult {
  taskId: string;
  kind: TaskKind;
  pid: number | null;
  outputFile: string;
  startedAt: string;
  timeoutMs: number | null;
}

export interface TaskEventParams {
  taskId: string;
  seq: number;
  lines: string[];
  at: string;
}

export interface TaskExitParams {
  taskId: string;
  seq: number;
  kind: TaskKind;
  status: TaskExitStatus;
  exitCode: number | null;
  signal: string | null;
  closeCode?: number;
  closeReason?: string;
  eventCount: number;
  durationMs: number;
  outputFile: string;
  outputTail: string;
  at: string;
}

export type TaskNotification =
  | { method: "task.event"; params: TaskEventParams }
  | { method: "task.exit"; params: TaskExitParams };

export interface TaskListEntry {
  taskId: string;
  kind: TaskKind;
  status: TaskStatus;
  command?: string;
  wsUrl?: string;
  cwd: string;
  description: string;
  owner: TaskOwner;
  pid: number | null;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  eventCount: number;
  outputFile: string;
  lastSeq: number;
}

export type TaskStopResult =
  | { stopped: true; status: "killed" }
  | { stopped: false; status: TaskExitStatus }
  | { stopped: false; error: string };

export type TaskEventsResult =
  | { status: TaskStatus; notifications: TaskNotification[] }
  | { notifications: TaskNotification[]; error: string };

/** What `command.run` with runInBackground answers, as Claude Code's Bash does. */
export interface BackgroundCommandResult {
  success: true;
  backgrounded: true;
  taskId: string;
  outputFile: string;
  pid: number | null;
  stdout: "";
  stderr: "";
  exitCode: null;
  executionTimeMs: 0;
  message: string;
}

export function backgroundCommandResult(started: TaskStartResult): BackgroundCommandResult {
  return {
    success: true,
    backgrounded: true,
    taskId: started.taskId,
    outputFile: started.outputFile,
    pid: started.pid,
    stdout: "",
    stderr: "",
    exitCode: null,
    executionTimeMs: 0,
    message: `Command running in background with ID: ${started.taskId}. Output is being written to: ${started.outputFile}`,
  };
}

// ────────────────────────────────────────────────────────────
// Processes, shells and private directories
// ────────────────────────────────────────────────────────────

/** A foreground command's timeout: default 120 s, within [1 s, 600 s]. */
export function clampCommandTimeout(raw: unknown): number {
  return clampNumber(raw, COMMAND_DEFAULT_TIMEOUT_MS, COMMAND_MIN_TIMEOUT_MS, COMMAND_MAX_TIMEOUT_MS);
}

export function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}

let resolvedBash: string | null = null;

/**
 * The shell a command runs in: `bash -l -c` (a login shell, so PATH holds
 * nvm, conda, cargo, …), or `bash -c` for a hook; ComSpec on Windows.
 */
export function resolveShell(command: string, { login = true }: { login?: boolean } = {}): { executable: string; args: string[] } {
  if (process.platform === "win32") {
    return { executable: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  resolvedBash ??= BASH_CANDIDATES.find((candidate) => existsSync(candidate)) ?? "bash";
  return { executable: resolvedBash, args: login ? ["-l", "-c", command] : ["-c", command] };
}

/**
 * Signal a child and everything it started. Children are spawned detached,
 * so each leads its own process group and the negative pid reaches the
 * grandchildren (`npm run dev` → node) a bare child.kill() would orphan.
 */
export function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // No process group (Windows, or the group is gone) — the child alone
    try {
      child.kill(signal);
    } catch {
      // Already gone
    }
  }
}

/** SIGTERM the group now, SIGKILL it `graceMs` later (whatever ignored the first). */
export function terminateProcessGroup(child: ChildProcess, graceMs: number = KILL_GRACE_MS): void {
  signalProcessGroup(child, "SIGTERM");
  setTimeout(() => signalProcessGroup(child, "SIGKILL"), graceMs).unref();
}

/** `<tmp>/prism-<uid>` — task output files and transcripts live under it. */
export function prismTempRoot(): string {
  const user = typeof process.getuid === "function" ? String(process.getuid()) : userInfo().username;
  return join(tmpdir(), `prism-${user}`);
}

/**
 * `mkdir -p` with mode 0700, and a refusal to use a directory another user
 * owns: on a shared /tmp anyone could have created it first to read along.
 */
export function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  const stats = lstatSync(directory);
  if (!stats.isDirectory()) {
    throw new Error(`${directory} is not a directory`);
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error(`${directory} belongs to another user; refusing to use it`);
  }
  if ((stats.mode & 0o077) !== 0) chmodSync(directory, 0o700);
}

/** The last `maxBytes` of a file, never starting inside a UTF-8 character. */
export function readOutputTail(file: string, maxBytes: number = OUTPUT_TAIL_BYTES): string {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const { size } = fstatSync(fd);
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    let start = 0;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
    return buffer.subarray(start).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// ────────────────────────────────────────────────────────────
// Task Engine
// ────────────────────────────────────────────────────────────

export interface TaskEngineOptions {
  /** Every task.event and task.exit, in order (the bridge sends them over its socket). */
  notify: (notification: TaskNotification) => void;
  /** The environment a command runs with: the caller's own, credentials stripped. */
  env: () => NodeJS.ProcessEnv;
  /** Where output files go. Default `<tmp>/prism-<uid>/tasks`. */
  tasksDirectory?: string;
  log?: (level: "info" | "warn", message: string) => void;
  /** Tighter limits than EVENT_RATE_LIMITS (tests). */
  eventRateLimits?: ReadonlyArray<EventRateLimit>;
}

interface EventBatch {
  lines: string[];
  chars: number;
  dropped: number;
}

interface ParsedStart {
  kind: TaskKind;
  command: string | null;
  ws: { url: string; protocols: string[] } | null;
  cwd: string;
  description: string;
  timeoutMs: number | null;
  owner: TaskOwner;
}

interface Task extends ParsedStart {
  taskId: string;
  outputFile: string;
  startedAt: number;
  pid: number | null;
  status: TaskStatus;
  endedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  eventCount: number;
  batchCount: number;
  seq: number;
  notifications: TaskNotification[];
  // ── while it runs ──
  fd: number | null;
  child: ChildProcess | null;
  socket: WebSocket | null;
  /** Why it is being stopped, once that is decided. */
  halt: "killed" | "timeout" | "too_many_events" | null;
  batch: EventBatch | null;
  batchTimer: ReturnType<typeof setTimeout> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  drainTimer: ReturnType<typeof setTimeout> | null;
  batchTimes: number[];
  partialLine: string;
  decoder: StringDecoder | null;
}

interface Ending {
  status: TaskExitStatus;
  exitCode: number | null;
  signal: string | null;
  closeCode?: number;
  closeReason?: string;
}

export class TaskEngine {
  readonly tasksDirectory: string;
  private readonly options: TaskEngineOptions;
  private readonly usesDefaultDirectory: boolean;
  private readonly tasks = new Map<string, Task>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: TaskEngineOptions) {
    this.options = options;
    this.usesDefaultDirectory = !options.tasksDirectory;
    this.tasksDirectory = options.tasksDirectory ?? join(prismTempRoot(), "tasks");
  }

  /** Start a task. Throws on invalid params (the RPC answers with the message). */
  start(params: TaskStartParams): TaskStartResult {
    const input = parseStartParams(params);
    if (this.usesDefaultDirectory) ensurePrivateDirectory(prismTempRoot());
    ensurePrivateDirectory(this.tasksDirectory);

    const taskId = this.newTaskId(input.kind);
    const outputFile = join(this.tasksDirectory, `${taskId}.output`);
    const task: Task = {
      ...input,
      taskId,
      outputFile,
      startedAt: Date.now(),
      pid: null,
      status: "running",
      endedAt: null,
      exitCode: null,
      signal: null,
      eventCount: 0,
      batchCount: 0,
      seq: 0,
      notifications: [],
      fd: openSync(outputFile, "a", 0o600),
      child: null,
      socket: null,
      halt: null,
      batch: null,
      batchTimer: null,
      deadlineTimer: null,
      drainTimer: null,
      batchTimes: [],
      partialLine: "",
      decoder: null,
    };

    this.tasks.set(taskId, task);
    try {
      if (task.ws) this.openSocket(task, task.ws);
      else this.spawnCommand(task, task.command ?? "");
    } catch (error) {
      this.tasks.delete(taskId);
      this.closeOutput(task);
      rmSync(outputFile, { force: true });
      throw error;
    }

    if (task.timeoutMs !== null) {
      task.deadlineTimer = setTimeout(() => this.halt(task, "timeout"), task.timeoutMs);
    }
    this.startSweeping();
    this.log("info", `Task ${taskId} started: ${(task.command ?? task.ws?.url ?? "").slice(0, 200)}`);
    return {
      taskId,
      kind: task.kind,
      pid: task.pid,
      outputFile,
      startedAt: new Date(task.startedAt).toISOString(),
      timeoutMs: task.timeoutMs,
    };
  }

  /** Stop a running task: kill its process group / close its socket. Its exit says `killed`. */
  stop(taskId: string): TaskStopResult {
    const task = this.tasks.get(taskId);
    if (!task) return { stopped: false, error: `Unknown task: ${taskId}` };
    if (task.status !== "running") return { stopped: false, status: task.status };
    if (task.halt) return { stopped: false, status: task.halt };
    this.halt(task, "killed");
    return { stopped: true, status: "killed" };
  }

  list(): TaskListEntry[] {
    return [...this.tasks.values()].map((task) => ({
      taskId: task.taskId,
      kind: task.kind,
      status: task.status,
      ...(task.command !== null && { command: task.command }),
      ...(task.ws !== null && { wsUrl: task.ws.url }),
      cwd: task.cwd,
      description: task.description,
      owner: task.owner,
      pid: task.pid,
      startedAt: new Date(task.startedAt).toISOString(),
      ...(task.endedAt !== null && {
        endedAt: new Date(task.endedAt).toISOString(),
        exitCode: task.exitCode,
      }),
      eventCount: task.eventCount,
      outputFile: task.outputFile,
      lastSeq: task.seq,
    }));
  }

  /** The kept notifications after `afterSeq` — a listener catching up. */
  events(taskId: string, afterSeq: number = 0): TaskEventsResult {
    const task = this.tasks.get(taskId);
    if (!task) return { notifications: [], error: `Unknown task: ${taskId}` };
    const after = Number.isFinite(afterSeq) ? afterSeq : 0;
    return {
      status: task.status,
      notifications: task.notifications.filter((notification) => notification.params.seq > after),
    };
  }

  runningCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) if (task.status === "running") count++;
    return count;
  }

  /** Forget tasks that finished more than an hour ago, and their output files. */
  sweep(now: number = Date.now()): void {
    for (const [taskId, task] of this.tasks) {
      if (task.endedAt === null || now - task.endedAt <= FINISHED_TASK_TTL_MS) continue;
      this.tasks.delete(taskId);
      rmSync(task.outputFile, { force: true });
    }
  }

  /** Stop every running task (shutdown). */
  dispose(): void {
    for (const task of this.tasks.values()) {
      if (task.status === "running") this.halt(task, "killed");
    }
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  // ── Sources ───────────────────────────────────────────────

  private spawnCommand(task: Task, command: string): void {
    const shell = resolveShell(command);
    const isShell = task.kind === "shell";
    const output = task.fd ?? "ignore";
    const child = spawn(shell.executable, shell.args, {
      cwd: task.cwd,
      env: this.options.env(),
      // Its own process group, so a stop reaches everything it started
      detached: process.platform !== "win32",
      windowsHide: true,
      // A shell writes straight into its file; a monitor's stdout is read
      // here (each line an event) while its stderr goes to the file
      stdio: ["ignore", isShell ? output : "pipe", output],
    });
    task.child = child;
    task.pid = child.pid ?? null;

    if (isShell) {
      // The child holds its own copy of the file
      this.closeOutput(task);
    } else {
      task.decoder = new StringDecoder("utf8");
      child.stdout?.on("data", (chunk: Buffer) => this.takeStdout(task, chunk));
      child.on("exit", () => {
        // A background process still holding stdout must not keep the watch alive
        task.drainTimer = setTimeout(() => child.stdout?.destroy(), STDOUT_DRAIN_MS);
      });
    }

    child.on("error", (error: Error) => {
      this.writeOutput(task, `${error.message}\n`);
      this.finish(task, { status: "failed", exitCode: null, signal: null });
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => this.processEnded(task, code, signal));
  }

  private openSocket(task: Task, target: { url: string; protocols: string[] }): void {
    const socket = new WebSocket(target.url, target.protocols, {
      handshakeTimeout: WEBSOCKET_HANDSHAKE_TIMEOUT_MS,
    });
    task.socket = socket;

    socket.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      // One frame is one event, newlines and all
      const line = isBinary ? `[binary frame, ${rawDataBytes(data)} bytes]` : rawDataText(data);
      this.writeOutput(task, `${line}\n`);
      this.addEventLine(task, line);
    });
    socket.on("error", (error: Error) => {
      const line = `WebSocket error: ${error.message}`;
      this.writeOutput(task, `${line}\n`);
      this.addEventLine(task, line);
    });
    socket.on("close", (code: number, reason: Buffer) => {
      if (task.status !== "running") return;
      // Errors are surfaced before the close
      this.flushBatch(task);
      const closeReason = reason.toString("utf8");
      this.writeOutput(task, `[closed ${code}${closeReason ? ` ${closeReason}` : ""}]\n`);
      this.finish(task, { status: task.halt ?? "closed", exitCode: null, signal: null, closeCode: code, closeReason });
    });
  }

  private takeStdout(task: Task, chunk: Buffer): void {
    this.writeOutput(task, chunk);
    const lines = (task.partialLine + (task.decoder?.write(chunk) ?? "")).split("\n");
    // The last piece has no newline yet: hold it (capped — the file has all of it)
    task.partialLine = (lines.pop() ?? "").slice(0, EVENT_LINE_MAX_CHARS + 1);
    for (const line of lines) this.addEventLine(task, line.endsWith("\r") ? line.slice(0, -1) : line);
  }

  private processEnded(task: Task, code: number | null, signal: NodeJS.Signals | null): void {
    if (task.status !== "running") return;
    if (task.kind === "monitor" && !task.halt) {
      // A partial last line is still a line
      const rest = task.partialLine + (task.decoder?.end() ?? "");
      task.partialLine = "";
      this.addEventLine(task, rest.endsWith("\r") ? rest.slice(0, -1) : rest);
      this.flushBatch(task);
    }
    const natural: TaskExitStatus = task.kind === "shell" ? (code === 0 ? "completed" : "failed") : "exited";
    this.finish(task, { status: task.halt ?? natural, exitCode: code, signal });
  }

  // ── Events ────────────────────────────────────────────────

  private addEventLine(task: Task, line: string): void {
    if (task.status !== "running" || task.halt || !line.trim()) return;
    const text =
      line.length > EVENT_LINE_MAX_CHARS
        ? `${line.slice(0, EVENT_LINE_MAX_CHARS)} … [line cut; all of it is in ${task.outputFile}]`
        : line;
    if (!task.batch) {
      // The first line opens the window; whatever arrives within it rides along
      task.batch = { lines: [], chars: 0, dropped: 0 };
      task.batchTimer = setTimeout(() => this.flushBatch(task), EVENT_BATCH_WINDOW_MS);
    }
    const batch = task.batch;
    if (batch.lines.length < EVENT_MAX_LINES && batch.chars + text.length <= EVENT_MAX_CHARS) {
      batch.lines.push(text);
      batch.chars += text.length;
    } else {
      batch.dropped += 1;
    }
  }

  private flushBatch(task: Task): void {
    if (task.batchTimer) clearTimeout(task.batchTimer);
    task.batchTimer = null;
    const batch = task.batch;
    task.batch = null;
    if (!batch || batch.lines.length === 0 || task.status !== "running") return;

    if (this.exceedsEventRate(task)) {
      this.halt(task, "too_many_events");
      return;
    }
    task.batchTimes.push(Date.now());
    task.batchCount += 1;
    task.eventCount += batch.lines.length;
    const lines =
      batch.dropped > 0
        ? [...batch.lines, `… [${batch.dropped} more line${batch.dropped === 1 ? "" : "s"} in ${task.outputFile}]`]
        : batch.lines;
    this.emit(task, {
      method: "task.event",
      params: { taskId: task.taskId, seq: ++task.seq, lines, at: new Date().toISOString() },
    });
  }

  /** Would one more batch break a rate limit (more than N batches in any window)? */
  private exceedsEventRate(task: Task): boolean {
    const now = Date.now();
    const limits = this.options.eventRateLimits ?? EVENT_RATE_LIMITS;
    const longest = Math.max(...limits.map((limit) => limit.windowMs));
    task.batchTimes = task.batchTimes.filter((time) => now - time < longest);
    return limits.some(
      (limit) => task.batchTimes.filter((time) => now - time < limit.windowMs).length >= limit.batches,
    );
  }

  // ── Ending ────────────────────────────────────────────────

  /** Decide to stop a task. A process ends when it dies; a socket ends now. */
  private halt(task: Task, reason: "killed" | "timeout" | "too_many_events"): void {
    if (task.status !== "running" || task.halt) return;
    if (reason === "too_many_events") {
      // The batch that tripped the limit is not delivered
      if (task.batchTimer) clearTimeout(task.batchTimer);
      task.batchTimer = null;
      task.batch = null;
    } else {
      // What arrived before the decision still counts
      this.flushBatch(task);
      if (task.status !== "running" || task.halt) return;
    }
    task.halt = reason;
    if (task.deadlineTimer) clearTimeout(task.deadlineTimer);
    task.deadlineTimer = null;

    if (task.socket) {
      const socket = task.socket;
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.terminate();
      this.finish(task, { status: reason, exitCode: null, signal: null });
    } else if (task.child) {
      terminateProcessGroup(task.child);
    }
  }

  private finish(task: Task, ending: Ending): void {
    if (task.status !== "running") return;
    for (const timer of [task.batchTimer, task.deadlineTimer, task.drainTimer]) {
      if (timer) clearTimeout(timer);
    }
    task.batchTimer = null;
    task.deadlineTimer = null;
    task.drainTimer = null;
    task.batch = null;
    task.status = ending.status;
    task.endedAt = Date.now();
    task.exitCode = ending.exitCode;
    task.signal = ending.signal;
    task.child = null;
    task.socket = null;
    this.closeOutput(task);

    this.emit(task, {
      method: "task.exit",
      params: {
        taskId: task.taskId,
        seq: ++task.seq,
        kind: task.kind,
        status: ending.status,
        exitCode: ending.exitCode,
        signal: ending.signal,
        ...(ending.closeCode !== undefined && {
          closeCode: ending.closeCode,
          closeReason: ending.closeReason ?? "",
        }),
        eventCount: task.eventCount,
        durationMs: task.endedAt - task.startedAt,
        outputFile: task.outputFile,
        outputTail: readOutputTail(task.outputFile),
        at: new Date(task.endedAt).toISOString(),
      },
    });
    this.log(
      "info",
      `Task ${task.taskId} ${ending.status}${ending.exitCode !== null ? ` (exit ${ending.exitCode})` : ""}${ending.signal ? ` (${ending.signal})` : ""}`,
    );
  }

  private emit(task: Task, notification: TaskNotification): void {
    task.notifications.push(notification);
    if (task.notifications.length > NOTIFICATION_BUFFER_SIZE) task.notifications.shift();
    try {
      this.options.notify(notification);
    } catch (error) {
      this.log("warn", `Task ${task.taskId}: delivering ${notification.method} failed: ${messageOf(error)}`);
    }
  }

  // ── Plumbing ──────────────────────────────────────────────

  private writeOutput(task: Task, data: Buffer | string): void {
    if (task.fd === null) return;
    try {
      if (typeof data === "string") writeSync(task.fd, data);
      else writeSync(task.fd, data);
    } catch (error) {
      this.log("warn", `Task ${task.taskId}: writing its output file failed: ${messageOf(error)}`);
    }
  }

  private closeOutput(task: Task): void {
    if (task.fd === null) return;
    try {
      closeSync(task.fd);
    } catch {
      // Already closed
    }
    task.fd = null;
  }

  private newTaskId(kind: TaskKind): string {
    for (;;) {
      let suffix = "";
      for (const byte of randomBytes(8)) suffix += ID_ALPHABET[byte % ID_ALPHABET.length];
      const taskId = `${kind}-${suffix}`;
      if (!this.tasks.has(taskId)) return taskId;
    }
  }

  private startSweeping(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  private log(level: "info" | "warn", message: string): void {
    this.options.log?.(level, message);
  }
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function parseStartParams(params: TaskStartParams): ParsedStart {
  const raw = (params ?? {}) as unknown as Record<string, unknown>;
  const kind = raw.kind;
  if (kind !== "shell" && kind !== "monitor") {
    throw new Error(`'kind' must be "shell" or "monitor"`);
  }
  const command = typeof raw.command === "string" && raw.command.trim() ? raw.command : null;
  const ws = raw.ws === undefined || raw.ws === null ? null : parseSocketTarget(raw.ws);
  if (kind === "shell" && (ws || !command)) {
    throw new Error("A shell task takes 'command' (a non-empty string)");
  }
  if (kind === "monitor" && (command === null) === (ws === null)) {
    throw new Error("A monitor takes exactly one of 'command' or 'ws'");
  }

  const cwd = typeof raw.cwd === "string" ? raw.cwd.trim() : "";
  if (command !== null) {
    if (!cwd || !isAbsolute(cwd)) {
      throw new Error("'cwd' must be an absolute path for a command task");
    }
    let isDirectory = false;
    try {
      isDirectory = statSync(cwd).isDirectory();
    } catch {
      // Missing
    }
    if (!isDirectory) throw new Error(`Working directory does not exist: ${cwd}`);
  }

  return {
    kind,
    command,
    ws,
    cwd,
    description: typeof raw.description === "string" ? raw.description.trim().slice(0, DESCRIPTION_MAX_CHARS) : "",
    timeoutMs:
      kind === "monitor"
        ? clampNumber(raw.timeoutMs, MONITOR_DEFAULT_TIMEOUT_MS, MONITOR_MIN_TIMEOUT_MS, MONITOR_MAX_TIMEOUT_MS)
        : null,
    owner: parseOwner(raw.owner),
  };
}

function parseSocketTarget(value: unknown): { url: string; protocols: string[] } {
  const target = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const url = typeof target.url === "string" ? target.url.trim() : "";
  let protocol = "";
  try {
    protocol = new URL(url).protocol;
  } catch {
    // Not a URL
  }
  if (protocol !== "ws:" && protocol !== "wss:") {
    throw new Error("'ws.url' must be a ws:// or wss:// URL");
  }
  const protocols: unknown[] =
    target.protocols === undefined || target.protocols === null
      ? []
      : Array.isArray(target.protocols)
        ? target.protocols
        : [target.protocols];
  if (!protocols.every((entry) => typeof entry === "string" && entry.length > 0)) {
    throw new Error("'ws.protocols' must be a string or an array of strings");
  }
  return { url, protocols: protocols as string[] };
}

function parseOwner(value: unknown): TaskOwner {
  const owner: TaskOwner = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return owner;
  for (const [key, entry] of Object.entries(value).slice(0, 16)) {
    if (typeof entry === "string") owner[key] = entry.slice(0, 512);
  }
  return owner;
}

function rawDataBytes(data: WebSocket.RawData | string): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Array.isArray(data)) return data.reduce((total, part) => total + part.length, 0);
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data.length;
}

function rawDataText(data: WebSocket.RawData | string): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
