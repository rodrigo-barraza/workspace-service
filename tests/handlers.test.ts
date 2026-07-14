import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Handler Tests (real filesystem / real processes)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// FileHandler, CommandHandler and GitHandler previously had zero tests —
// these cover the recently fixed defects so they can't regress.

import { FileHandler } from "../src/handlers/FileHandler.ts";
import { CommandHandler } from "../src/handlers/CommandHandler.ts";

let workspaceRoot: string;
let fileHandler: FileHandler;
let commandHandler: CommandHandler;

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "workspace-handler-test-"));
  fileHandler = new FileHandler([workspaceRoot]);
  commandHandler = new CommandHandler([workspaceRoot]);
});

afterAll(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

// ── stringReplace ───────────────────────────────────────────

describe("FileHandler.stringReplace", () => {
  it("counts non-overlapping occurrences (overlap counting caused spurious ambiguity rejections)", async () => {
    const filePath = join(workspaceRoot, "overlap.txt");
    await writeFile(filePath, "aaa", "utf-8");

    // "aaa" contains "aa" once non-overlapping — must be a clean single replace
    const result = await fileHandler.stringReplace({
      path: filePath,
      oldString: "aa",
      newString: "bb",
    });

    expect(result).not.toHaveProperty("error");
    expect((result as { matchCount: number }).matchCount).toBe(1);
    expect(await readFile(filePath, "utf-8")).toBe("bba");
  });

  it("still rejects genuinely ambiguous matches when allowMultiple is false", async () => {
    const filePath = join(workspaceRoot, "ambiguous.txt");
    await writeFile(filePath, "aa aa", "utf-8");

    const result = await fileHandler.stringReplace({
      path: filePath,
      oldString: "aa",
      newString: "bb",
    });

    expect((result as { error: string }).error).toContain("2 occurrences");
  });
});

// ── writeFile: binary + containment ─────────────────────────

describe("FileHandler.writeFile", () => {
  it("round-trips binary data via contentBase64 (UTF-8 coercion corrupted these)", async () => {
    const filePath = join(workspaceRoot, "binary.bin");
    const originalBytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47]);

    const result = await fileHandler.writeFile({
      path: filePath,
      contentBase64: originalBytes.toString("base64"),
    });

    expect(result).not.toHaveProperty("error");
    expect((result as { isBinary: boolean }).isBinary).toBe(true);
    expect(Buffer.compare(await readFile(filePath), originalBytes)).toBe(0);
  });

  it("rejects writes outside the workspace roots (containment)", async () => {
    const result = await fileHandler.writeFile({
      path: "/etc/workspace-test-escape.txt",
      content: "nope",
    });
    expect((result as { error: string }).error).toContain("outside the workspace");
  });
});

// ── grep includes: real glob semantics ──────────────────────

describe("FileHandler.grepSearch includes filter", () => {
  beforeAll(async () => {
    await mkdir(join(workspaceRoot, "src", "deep"), { recursive: true });
    await writeFile(join(workspaceRoot, "src", "top.ts"), "const NEEDLE = 1;", "utf-8");
    await writeFile(join(workspaceRoot, "src", "deep", "nested.ts"), "const NEEDLE = 2;", "utf-8");
    await writeFile(join(workspaceRoot, "src", "skip.js"), "const NEEDLE = 3;", "utf-8");
  });

  it("matches nested files with *.ts (the old filter only handled flat suffixes)", async () => {
    const result = await fileHandler.grepSearch({
      pattern: "NEEDLE",
      searchPath: join(workspaceRoot, "src"),
      includes: ["*.ts"],
    });

    const files = (result as { results: Array<{ file: string }> }).results.map((match) => match.file);
    expect(files).toContain(join(workspaceRoot, "src", "top.ts"));
    expect(files).toContain(join(workspaceRoot, "src", "deep", "nested.ts"));
    expect(files.some((file) => file.endsWith(".js"))).toBe(false);
  });
});

// ── directoryTree cap ───────────────────────────────────────

describe("FileHandler.directoryTree", () => {
  it("caps entries and reports truncated (was unbounded)", async () => {
    const wideDirectory = join(workspaceRoot, "wide");
    await mkdir(wideDirectory, { recursive: true });
    await Promise.all(
      Array.from({ length: 1100 }, (_unused, index) =>
        writeFile(join(wideDirectory, `file-${String(index).padStart(4, "0")}.txt`), "", "utf-8"),
      ),
    );

    const result = (await fileHandler.directoryTree({ path: wideDirectory })) as {
      entries: unknown[];
      totalEntries: number;
      truncated: boolean;
    };

    expect(result.truncated).toBe(true);
    expect(result.totalEntries).toBeLessThanOrEqual(1000);
  });
});

// ── CommandHandler ──────────────────────────────────────────

describe("CommandHandler", () => {
  it("marks truncated output with an explicit flag AND marker", async () => {
    const result = await commandHandler.run({
      command: "head -c 600000 /dev/zero | tr '\\0' 'a'",
      cwd: workspaceRoot,
      timeout: 30_000,
    });

    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.endsWith("... [output truncated]")).toBe(true);
  });

  it("does not flag small output as truncated", async () => {
    const result = await commandHandler.run({ command: "echo hello", cwd: workspaceRoot });
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("kills the WHOLE process tree on timeout (orphaned grandchildren leaked before)", async () => {
    const result = await commandHandler.run({
      command: 'sleep 300 & echo "GRANDCHILD_PID:$!"; wait',
      cwd: workspaceRoot,
      timeout: 1500,
    });

    expect(result.timedOut).toBe(true);

    const pidMatch = result.stdout.match(/GRANDCHILD_PID:(\d+)/);
    expect(pidMatch).not.toBeNull();
    const grandchildPid = parseInt(pidMatch![1], 10);

    // Give the SIGKILL a moment to land, then verify the grandchild is gone
    await new Promise((resolve) => setTimeout(resolve, 300));
    let grandchildAlive = true;
    try {
      process.kill(grandchildPid, 0);
    } catch {
      grandchildAlive = false;
    }
    expect(grandchildAlive).toBe(false);
  }, 15_000);

  it("strips credential-shaped env vars from spawned commands", async () => {
    process.env.WORKSPACE_TEST_FAKE_SECRET = "leak-me";
    process.env.MONGO_URI = "mongodb://user:pass@host/db";
    try {
      const result = await commandHandler.run({ command: "env", cwd: workspaceRoot });
      expect(result.stdout).not.toContain("leak-me");
      expect(result.stdout).not.toContain("mongodb://user:pass");
      expect(result.stdout).toContain("CI=true");
    } finally {
      delete process.env.WORKSPACE_TEST_FAKE_SECRET;
      delete process.env.MONGO_URI;
    }
  });
});
