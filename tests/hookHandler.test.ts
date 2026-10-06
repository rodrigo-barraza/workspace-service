import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HookHandler — repository hooks on the machine that holds the repo
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// hook.run (stdin in, verdict out, a deadline that kills the group, the
// environment it gets), hooks.config (which files apply: the nearest
// project file, never above the registered root, and the user's) and
// transcript.append (id rules, JSONL, private files).

import { HookHandler } from "../src/handlers/HookHandler.ts";
import { appendTranscript, transcriptsDirectory } from "../src/handlers/WorkspaceHooks.ts";

let scratch: string;
let registeredRoot: string;
let fakeHome: string;
let handler: HookHandler;
const previousHome = process.env.HOME;

function writeHooksFile(directory: string, content: string): string {
  mkdirSync(join(directory, ".prism"), { recursive: true });
  const path = join(directory, ".prism", "hooks.json");
  writeFileSync(path, content);
  return path;
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "hook-handler-test-"));
  // A hooks file ABOVE the registered root: never used
  writeHooksFile(scratch, '{"description":"above the root"}');
  registeredRoot = join(scratch, "development");
  mkdirSync(join(registeredRoot, "repo", "src", "deep"), { recursive: true });
  mkdirSync(join(registeredRoot, "bare", "nested"), { recursive: true });
  fakeHome = join(scratch, "home");
  mkdirSync(fakeHome);
  process.env.HOME = fakeHome;
  handler = new HookHandler([registeredRoot]);
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(scratch, { recursive: true, force: true });
});

describe("hook.run", () => {
  it("runs in cwd with the payload on stdin, and answers exit code + stdout + stderr", async () => {
    const result = await handler.run({
      command: 'payload=$(cat); printf "%s|%s" "$payload" "$(pwd)"; echo warn >&2; exit 2',
      cwd: join(registeredRoot, "repo"),
      stdin: '{"tool_name":"execute_command"}',
    });
    expect(result).toMatchObject({
      exitCode: 2,
      stdout: `{"tool_name":"execute_command"}|${join(registeredRoot, "repo")}`,
      stderr: "warn\n",
      timedOut: false,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("gets this process's environment without credentials, plus the caller's conventional string variables", async () => {
    process.env.HOOK_TEST_FAKE_API_KEY = "leak-me";
    process.env.HOOK_TEST_PLAIN = "kept";
    try {
      const result = await handler.run({
        command: 'printf "%s|%s|%s|%s|%s" "${HOOK_TEST_FAKE_API_KEY:-unset}" "$HOOK_TEST_PLAIN" "$PRISM_HOOK_EVENT" "${lower:-unset}" "${NUMERIC:-unset}"',
        cwd: registeredRoot,
        env: { PRISM_HOOK_EVENT: "PreToolUse", lower: "x", NUMERIC: 5 },
      });
      expect(result.stdout).toBe("unset|kept|PreToolUse|unset|unset");
    } finally {
      delete process.env.HOOK_TEST_FAKE_API_KEY;
      delete process.env.HOOK_TEST_PLAIN;
    }
  });

  it("kills the whole group at the deadline and says timedOut", async () => {
    const marker = join(scratch, "survived");
    const started = Date.now();
    const result = await handler.run({
      command: `(sleep 2; touch ${marker}) & sleep 10`,
      cwd: registeredRoot,
      timeoutMs: 600,
    });
    expect(result).toMatchObject({ timedOut: true, exitCode: null });
    expect(Date.now() - started).toBeLessThan(2_000);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(existsSync(marker), "the backgrounded child must die with the group").toBe(false);
  }, 10_000);

  it.each([
    [{ command: "true", cwd: "/etc" }, "outside the workspace root"],
    [{ command: "true", cwd: "relative" }, "absolute path"],
    [{ command: "true", cwd: "/nonexistent-root-dir" }, "outside the workspace root"],
    [{ command: "", cwd: "/" }, "'command'"],
  ])("refuses %j", async (params, message) => {
    await expect(handler.run(params as never)).rejects.toThrow(message);
  });
});

describe("hooks.config", () => {
  it("finds the nearest project file walking up, and the user's own file", () => {
    const repoFile = writeHooksFile(join(registeredRoot, "repo"), '{"hooks":{"PreToolUse":[]}}');
    const userContent = '{"description":"mine"}';
    const userFile = writeHooksFile(fakeHome, userContent);

    const config = handler.config({ root: join(registeredRoot, "repo", "src", "deep") });
    expect(config.project).toMatchObject({
      path: repoFile,
      dir: join(registeredRoot, "repo"),
      exists: true,
      content: '{"hooks":{"PreToolUse":[]}}',
      sha256: createHash("sha256").update('{"hooks":{"PreToolUse":[]}}').digest("hex"),
    });
    expect(config.user).toMatchObject({ path: userFile, dir: fakeHome, content: userContent });
  });

  it("stops at the registered root — a file above it is never used", () => {
    const config = handler.config({ root: join(registeredRoot, "bare", "nested") });
    expect(config.project).toBeNull();
  });

  it("uses the registered root's own file when nothing nearer exists", () => {
    const rootFile = writeHooksFile(registeredRoot, '{"description":"development folder"}');
    try {
      const config = handler.config({ root: join(registeredRoot, "bare", "nested") });
      expect(config.project?.path).toBe(rootFile);
    } finally {
      rmSync(join(registeredRoot, ".prism"), { recursive: true, force: true });
    }
  });

  it("refuses a root outside the registered roots", () => {
    expect(() => handler.config({ root: scratch })).toThrow("outside the workspace root");
  });
});

describe("transcript.append", () => {
  it("appends each object as one JSON line to a private file; no lines just names the path", () => {
    const conversationId = `test-${process.pid}-${Date.now()}`;
    const { path } = handler.appendTranscript({ conversationId, lines: [] });
    expect(path).toBe(join(transcriptsDirectory(), `${conversationId}.jsonl`));
    expect(existsSync(path)).toBe(false);

    try {
      handler.appendTranscript({
        conversationId,
        lines: [{ type: "user", message: { role: "user", content: "hi" } }, { type: "assistant" }],
      });
      handler.appendTranscript({ conversationId, lines: [{ type: "user", n: 3 }] });
      expect(readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual([
        { type: "user", message: { role: "user", content: "hi" } },
        { type: "assistant" },
        { type: "user", n: 3 },
      ]);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(transcriptsDirectory()).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it.each([["../escape"], ["a/b"], [""], ["x".repeat(129)], [42]])("refuses the conversation id %j", (conversationId) => {
    expect(() => appendTranscript(conversationId, [], scratch)).toThrow("'conversationId' must match");
  });

  it("refuses lines that are not objects", () => {
    expect(() => appendTranscript("ok-id", ["text"], scratch)).toThrow("'lines' must be an array of objects");
    expect(() => appendTranscript("ok-id", "text", scratch)).toThrow("'lines' must be an array of objects");
  });
});
