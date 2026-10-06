import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { WebSocket as ServerSocket } from "ws";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TaskEngine — background shells and monitors, for real
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Real processes, a real output directory and a real WebSocket server:
// the semantics under test (exit statuses, 200 ms batching, the deadline,
// the rate limits, group kills) live in timing and signals, which mocks
// would only restate.

import {
  TaskEngine,
  EVENT_RATE_LIMITS,
  FINISHED_TASK_TTL_MS,
  MONITOR_MAX_TIMEOUT_MS,
  MONITOR_MIN_TIMEOUT_MS,
  TASK_ID_PATTERN,
  clampCommandTimeout,
} from "../src/handlers/TaskEngine.ts";
import type {
  EventRateLimit,
  TaskEventParams,
  TaskExitParams,
  TaskNotification,
} from "../src/handlers/TaskEngine.ts";

let scratch: string;
let tasksDirectory: string;
const engines: TaskEngine[] = [];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "task-engine-test-"));
  tasksDirectory = join(scratch, "tasks");
});

afterAll(() => {
  for (const engine of engines) engine.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

function harness(eventRateLimits?: ReadonlyArray<EventRateLimit>) {
  const notifications: TaskNotification[] = [];
  const exitWaiters = new Map<string, (exit: TaskExitParams) => void>();
  const engine = new TaskEngine({
    tasksDirectory,
    env: () => ({ ...process.env }),
    notify: (notification) => {
      notifications.push(notification);
      if (notification.method === "task.exit") exitWaiters.get(notification.params.taskId)?.(notification.params);
    },
    ...(eventRateLimits && { eventRateLimits }),
  });
  engines.push(engine);

  const exitOf = (taskId: string) =>
    new Promise<TaskExitParams>((resolve) => {
      const done = notifications.find(
        (notification) => notification.method === "task.exit" && notification.params.taskId === taskId,
      );
      if (done) resolve(done.params as TaskExitParams);
      else exitWaiters.set(taskId, resolve);
    });
  const eventsOf = (taskId: string) =>
    notifications
      .filter((notification) => notification.method === "task.event" && notification.params.taskId === taskId)
      .map((notification) => notification.params as TaskEventParams);
  return { engine, notifications, exitOf, eventsOf };
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFileText(file: string, pattern: RegExp, timeoutMs = 5_000): Promise<RegExpMatchArray> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = existsSync(file) ? readFileSync(file, "utf8").match(pattern) : null;
    if (match) return match;
    if (Date.now() > deadline) throw new Error(`${file} never matched ${pattern}`);
    await sleep(50);
  }
}

// ── Shell tasks ─────────────────────────────────────────────

describe("TaskEngine — shell tasks", () => {
  it("runs detached: answers at once with an id and an output file that gets stdout AND stderr; exit 0 is completed", async () => {
    const { engine, exitOf, eventsOf } = harness();
    const started = engine.start({ kind: "shell", command: "echo out-line; echo err-line >&2", cwd: scratch });

    expect(started.taskId).toMatch(/^shell-[0-9a-z]{8}$/);
    expect(started.taskId).toMatch(TASK_ID_PATTERN);
    expect(started.outputFile).toBe(join(tasksDirectory, `${started.taskId}.output`));
    expect(typeof started.pid).toBe("number");
    expect(started.timeoutMs).toBeNull();
    expect(Date.parse(started.startedAt)).not.toBeNaN();

    const exit = await exitOf(started.taskId);
    expect(exit).toMatchObject({ status: "completed", exitCode: 0, signal: null, kind: "shell", seq: 1, eventCount: 0 });
    expect(eventsOf(started.taskId)).toEqual([]);
    expect(exit.outputTail).toContain("out-line");
    expect(exit.outputTail).toContain("err-line");

    const output = readFileSync(started.outputFile, "utf8");
    expect(output).toContain("out-line\n");
    expect(output).toContain("err-line\n");
    expect(statSync(started.outputFile).mode & 0o777).toBe(0o600);
    expect(statSync(tasksDirectory).mode & 0o777).toBe(0o700);
  });

  it("a non-zero exit is failed, with the exit code", async () => {
    const { engine, exitOf } = harness();
    const started = engine.start({ kind: "shell", command: "exit 3", cwd: scratch });
    expect(await exitOf(started.taskId)).toMatchObject({ status: "failed", exitCode: 3, signal: null });
  });

  it("death by a signal it did not get from task.stop is failed, with the signal", async () => {
    const { engine, exitOf } = harness();
    const started = engine.start({ kind: "shell", command: "kill -TERM $$", cwd: scratch });
    expect(await exitOf(started.taskId)).toMatchObject({ status: "failed", exitCode: null, signal: "SIGTERM" });
  });

  it("task.stop kills the whole process group: killed, and the grandchild dies too", async () => {
    const { engine, exitOf } = harness();
    const started = engine.start({ kind: "shell", command: 'sleep 300 & echo "CHILD:$!"; wait', cwd: scratch });
    const childPid = Number((await waitForFileText(started.outputFile, /CHILD:(\d+)/))[1]);
    expect(isAlive(childPid)).toBe(true);

    expect(engine.stop(started.taskId)).toEqual({ stopped: true, status: "killed" });
    const exit = await exitOf(started.taskId);
    expect(exit.status).toBe("killed");
    await sleep(200);
    expect(isAlive(childPid)).toBe(false);

    // Stopping it again reports what it ended as
    expect(engine.stop(started.taskId)).toEqual({ stopped: false, status: "killed" });
  });

  it("takes no deadline: a shell's timeoutMs is ignored", () => {
    const { engine } = harness();
    const started = engine.start({ kind: "shell", command: "sleep 30", cwd: scratch, timeoutMs: 1_000 });
    expect(started.timeoutMs).toBeNull();
    engine.stop(started.taskId);
  });
});

// ── Command monitors ────────────────────────────────────────

describe("TaskEngine — command monitors", () => {
  it("batches stdout lines within 200 ms into ONE event; exit is `exited` with the code and the event count", async () => {
    const { engine, exitOf, eventsOf } = harness();
    const started = engine.start({
      kind: "monitor",
      command: "echo alpha; echo beta; sleep 0.6; echo gamma; exit 4",
      cwd: scratch,
      description: "test lines",
    });
    expect(started.taskId).toMatch(/^monitor-[0-9a-z]{8}$/);
    expect(started.timeoutMs).toBe(300_000);

    const exit = await exitOf(started.taskId);
    const events = eventsOf(started.taskId);
    expect(events.map((event) => event.lines)).toEqual([["alpha", "beta"], ["gamma"]]);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(exit).toMatchObject({ status: "exited", exitCode: 4, seq: 3, eventCount: 3, kind: "monitor" });
  });

  it("flushes a partial last line (no trailing newline) at exit", async () => {
    const { engine, exitOf, eventsOf } = harness();
    const started = engine.start({ kind: "monitor", command: "printf 'one\\ntwo'", cwd: scratch });
    await exitOf(started.taskId);
    expect(eventsOf(started.taskId).flatMap((event) => event.lines)).toEqual(["one", "two"]);
  });

  it("stderr is not an event — it only reaches the output file", async () => {
    const { engine, exitOf, eventsOf } = harness();
    const started = engine.start({ kind: "monitor", command: "echo to-stdout; echo to-stderr >&2", cwd: scratch });
    const exit = await exitOf(started.taskId);
    expect(eventsOf(started.taskId).flatMap((event) => event.lines)).toEqual(["to-stdout"]);
    expect(exit.eventCount).toBe(1);
    const output = readFileSync(started.outputFile, "utf8");
    expect(output).toContain("to-stdout");
    expect(output).toContain("to-stderr");
  });

  it("at timeoutMs it is killed and ends with ONE notice: status timeout, with the event count", async () => {
    const { engine, exitOf, eventsOf } = harness();
    const startedAt = Date.now();
    const started = engine.start({ kind: "monitor", command: "echo first; sleep 30", cwd: scratch, timeoutMs: 1_000 });
    expect(started.timeoutMs).toBe(1_000);

    const exit = await exitOf(started.taskId);
    expect(exit).toMatchObject({ status: "timeout", eventCount: 1, exitCode: null });
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(eventsOf(started.taskId)).toHaveLength(1);
  });

  it("clamps timeoutMs to [1000, 1800000]", () => {
    const { engine } = harness();
    const short = engine.start({ kind: "monitor", command: "sleep 30", cwd: scratch, timeoutMs: 5 });
    const long = engine.start({ kind: "monitor", command: "sleep 30", cwd: scratch, timeoutMs: 99_999_999 });
    expect(short.timeoutMs).toBe(MONITOR_MIN_TIMEOUT_MS);
    expect(long.timeoutMs).toBe(MONITOR_MAX_TIMEOUT_MS);
    engine.stop(short.taskId);
    engine.stop(long.taskId);
  });

  it("stops a monitor that produces too many events (and does not deliver the batch that tripped it)", async () => {
    const { engine, exitOf, eventsOf } = harness([{ batches: 3, windowMs: 10_000 }]);
    const started = engine.start({
      kind: "monitor",
      command: "for i in 1 2 3 4 5 6 7 8; do echo line-$i; sleep 0.3; done; sleep 30",
      cwd: scratch,
    });
    const exit = await exitOf(started.taskId);
    expect(exit.status).toBe("too_many_events");
    expect(eventsOf(started.taskId)).toHaveLength(3);
    expect(exit.eventCount).toBe(3);
    expect(exit.seq).toBe(4);
  });

  it("the real limits: more than 30 batches within 10 s stops it", { timeout: 20_000 }, async () => {
    expect(EVENT_RATE_LIMITS).toEqual([
      { batches: 30, windowMs: 10_000 },
      { batches: 300, windowMs: 600_000 },
    ]);
    const { engine, exitOf, eventsOf } = harness();
    const started = engine.start({
      kind: "monitor",
      command: "for i in $(seq 1 60); do echo tick-$i; sleep 0.25; done",
      cwd: scratch,
    });
    const exit = await exitOf(started.taskId);
    expect(exit.status).toBe("too_many_events");
    expect(eventsOf(started.taskId)).toHaveLength(30);
  });

  it("caps one event's size; the rest is named and stays in the output file", async () => {
    const { engine, exitOf, eventsOf } = harness();
    const started = engine.start({ kind: "monitor", command: "seq 1 500", cwd: scratch });
    const exit = await exitOf(started.taskId);
    const [first] = eventsOf(started.taskId);
    expect(first.lines).toHaveLength(101);
    expect(first.lines[0]).toBe("1");
    expect(first.lines[100]).toBe(`… [400 more lines in ${started.outputFile}]`);
    expect(exit.eventCount).toBe(100);
    expect(readFileSync(started.outputFile, "utf8").trim().split("\n")).toHaveLength(500);
  });

  it("task.stop ends a monitor as killed", async () => {
    const { engine, exitOf } = harness();
    const started = engine.start({ kind: "monitor", command: "sleep 30", cwd: scratch });
    expect(engine.stop(started.taskId)).toEqual({ stopped: true, status: "killed" });
    expect((await exitOf(started.taskId)).status).toBe("killed");
  });
});

// ── WebSocket monitors ──────────────────────────────────────

describe("TaskEngine — ws monitors", () => {
  let server: WebSocketServer;
  let port: number;
  let onConnection: (socket: ServerSocket) => void = () => {};
  const protocolsSeen: string[][] = [];

  beforeAll(async () => {
    server = new WebSocketServer({
      port: 0,
      handleProtocols: (protocols) => {
        protocolsSeen.push([...protocols]);
        return protocols.values().next().value ?? false;
      },
    });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    port = (server.address() as AddressInfo).port;
    server.on("connection", (socket) => onConnection(socket));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("each text frame is one event (newlines kept), a binary frame a placeholder; close ends it with the code", async () => {
    onConnection = (socket) => {
      socket.send("hello");
      socket.send("multi\nline frame");
      socket.send(Buffer.alloc(5), { binary: true });
      setTimeout(() => socket.close(4000, "bye"), 500);
    };
    const { engine, exitOf, eventsOf } = harness();
    const started = engine.start({
      kind: "monitor",
      ws: { url: `ws://127.0.0.1:${port}/stream`, protocols: ["v1"] },
      description: "test socket",
    });
    expect(started.pid).toBeNull();

    const exit = await exitOf(started.taskId);
    expect(eventsOf(started.taskId).flatMap((event) => event.lines)).toEqual([
      "hello",
      "multi\nline frame",
      "[binary frame, 5 bytes]",
    ]);
    expect(exit).toMatchObject({ status: "closed", closeCode: 4000, closeReason: "bye", eventCount: 3, exitCode: null });
    expect(protocolsSeen.at(-1)).toEqual(["v1"]);
    expect(readFileSync(started.outputFile, "utf8")).toContain("multi\nline frame");
  });

  it("surfaces an error as an event before the close", async () => {
    const { engine, exitOf, eventsOf } = harness();
    // Nothing listens on the closed server's old port
    const idle = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => idle.once("listening", () => resolve()));
    const deadPort = (idle.address() as AddressInfo).port;
    await new Promise<void>((resolve) => idle.close(() => resolve()));

    const started = engine.start({ kind: "monitor", ws: { url: `ws://127.0.0.1:${deadPort}` } });
    const exit = await exitOf(started.taskId);
    const lines = eventsOf(started.taskId).flatMap((event) => event.lines);
    // ECONNREFUSED, or ECONNRESET where WSL's localhost relay answers first
    expect(lines[0]).toMatch(/^WebSocket error: .*ECONN(REFUSED|RESET)/);
    expect(exit).toMatchObject({ status: "closed", closeCode: 1006 });
  });

  it("task.stop closes the socket: killed", async () => {
    const closedOnServer = new Promise<void>((resolve) => {
      onConnection = (socket) => socket.on("close", () => resolve());
    });
    const { engine, exitOf } = harness();
    const started = engine.start({ kind: "monitor", ws: { url: `ws://127.0.0.1:${port}` } });
    await sleep(300);
    expect(engine.stop(started.taskId)).toEqual({ stopped: true, status: "killed" });
    expect((await exitOf(started.taskId)).status).toBe("killed");
    await closedOnServer;
  });

  it("at its deadline the socket is closed: timeout", async () => {
    onConnection = (socket) => socket.send("only one");
    const { engine, exitOf } = harness();
    const started = engine.start({ kind: "monitor", ws: { url: `ws://127.0.0.1:${port}` }, timeoutMs: 1_000 });
    expect(await exitOf(started.taskId)).toMatchObject({ status: "timeout", eventCount: 1 });
  });
});

// ── Bookkeeping ─────────────────────────────────────────────

describe("TaskEngine — replay, list, stop and validation", () => {
  it("events() replays what came after a seq; list() describes every task", async () => {
    const { engine, exitOf } = harness();
    const started = engine.start({
      kind: "monitor",
      command: "echo one; sleep 0.4; echo two",
      cwd: scratch,
      description: "replay me",
      owner: { conversationId: "conversation-1", username: "rodrigo", ignored: 5 },
    });
    await exitOf(started.taskId);

    const replay = engine.events(started.taskId, 1);
    expect("status" in replay && replay.status).toBe("exited");
    expect(replay.notifications.map((notification) => [notification.method, notification.params.seq])).toEqual([
      ["task.event", 2],
      ["task.exit", 3],
    ]);
    expect(engine.events("monitor-zzzzzzzz", 0)).toEqual({ notifications: [], error: "Unknown task: monitor-zzzzzzzz" });

    const entry = engine.list().find((candidate) => candidate.taskId === started.taskId);
    expect(entry).toMatchObject({
      kind: "monitor",
      status: "exited",
      command: "echo one; sleep 0.4; echo two",
      cwd: scratch,
      description: "replay me",
      owner: { conversationId: "conversation-1", username: "rodrigo" },
      exitCode: 0,
      eventCount: 2,
      outputFile: started.outputFile,
      lastSeq: 3,
    });
    expect(entry?.endedAt).toBeDefined();
  });

  it("stop() of an unknown task says so", () => {
    const { engine } = harness();
    expect(engine.stop("shell-zzzzzzzz")).toEqual({ stopped: false, error: "Unknown task: shell-zzzzzzzz" });
  });

  it.each([
    [{ kind: "nope", command: "true" }, "'kind'"],
    [{ kind: "shell" }, "'command'"],
    [{ kind: "monitor" }, "exactly one of 'command' or 'ws'"],
    [{ kind: "monitor", command: "true", ws: { url: "ws://localhost:1" } }, "exactly one of 'command' or 'ws'"],
    [{ kind: "monitor", ws: { url: "http://localhost:1" } }, "ws:// or wss://"],
    [{ kind: "monitor", ws: { url: "ws://localhost:1", protocols: [5] } }, "'ws.protocols'"],
    [{ kind: "shell", command: "true", cwd: "relative/dir" }, "absolute path"],
    [{ kind: "shell", command: "true", cwd: "/no/such/directory/anywhere" }, "does not exist"],
  ])("refuses %j", (params, message) => {
    const { engine } = harness();
    expect(() => engine.start(params as never)).toThrow(message);
  });

  it("forgets a task an hour after it finished, with its output file; a running one stays", async () => {
    const { engine, exitOf } = harness();
    const finished = engine.start({ kind: "shell", command: "true", cwd: scratch });
    await exitOf(finished.taskId);
    const running = engine.start({ kind: "shell", command: "sleep 30", cwd: scratch });

    engine.sweep(Date.now() + FINISHED_TASK_TTL_MS + 1_000);
    const listed = engine.list().map((entry) => entry.taskId);
    expect(listed).not.toContain(finished.taskId);
    expect(existsSync(finished.outputFile)).toBe(false);
    expect(listed).toContain(running.taskId);
    engine.stop(running.taskId);
  });

  it("clampCommandTimeout: Claude Code's Bash default and bounds", () => {
    expect(clampCommandTimeout(undefined)).toBe(120_000);
    expect(clampCommandTimeout(5)).toBe(1_000);
    expect(clampCommandTimeout(30_000)).toBe(30_000);
    expect(clampCommandTimeout(10_000_000)).toBe(600_000);
  });
});
