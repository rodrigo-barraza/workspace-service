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

// ── blockReplace ────────────────────────────────────────────

describe("FileHandler.blockReplace", () => {
  it("replaces the targeted range when targetContent matches (happy path)", async () => {
    const filePath = join(workspaceRoot, "block-happy.txt");
    await writeFile(filePath, "line1\nline2\nline3\nline4\n", "utf-8");

    const result = await fileHandler.blockReplace({
      path: filePath,
      startLine: 2,
      endLine: 3,
      targetContent: "line2\nline3",
      replacementContent: "REPLACED",
    });

    expect(result).not.toHaveProperty("error");
    expect((result as { success: boolean }).success).toBe(true);
    expect((result as { lineDelta: number }).lineDelta).toBe(-1);
    expect(await readFile(filePath, "utf-8")).toBe("line1\nREPLACED\nline4\n");
  });

  it("rejects with numbered actual content when targetContent does not match", async () => {
    const filePath = join(workspaceRoot, "block-mismatch.txt");
    await writeFile(filePath, "alpha\nbravo\ncharlie\n", "utf-8");

    const result = await fileHandler.blockReplace({
      path: filePath,
      startLine: 1,
      endLine: 2,
      targetContent: "alpha\nWRONG",
      replacementContent: "x",
    });

    expect((result as { error: string }).error).toContain("does not match targetContent");
    expect((result as { actualContentInRange: string }).actualContentInRange).toBe("1: alpha\n2: bravo");
    // File left untouched
    expect(await readFile(filePath, "utf-8")).toBe("alpha\nbravo\ncharlie\n");
  });
});

// ── multiReplace ────────────────────────────────────────────

describe("FileHandler.multiReplace", () => {
  it("applies multiple chunks bottom-up so earlier offsets don't shift (happy path)", async () => {
    const filePath = join(workspaceRoot, "multi-happy.txt");
    await writeFile(filePath, "a\nb\nc\nd\ne\n", "utf-8");

    // Chunk order intentionally not sorted; the top chunk grows the file, which
    // would corrupt the bottom chunk's indices if applied top-down.
    const result = await fileHandler.multiReplace({
      path: filePath,
      chunks: [
        { startLine: 1, endLine: 1, targetContent: "a", replacementContent: "A1\nA2" },
        { startLine: 4, endLine: 5, targetContent: "d\ne", replacementContent: "DE" },
      ],
    });

    expect(result).not.toHaveProperty("error");
    expect((result as { success: boolean }).success).toBe(true);
    expect((result as { chunksProcessed: number }).chunksProcessed).toBe(2);
    expect(await readFile(filePath, "utf-8")).toBe("A1\nA2\nb\nc\nDE\n");
  });

  it("applies nothing when any chunk fails to match (all-or-nothing)", async () => {
    const filePath = join(workspaceRoot, "multi-badchunk.txt");
    const original = "one\ntwo\nthree\nfour\n";
    await writeFile(filePath, original, "utf-8");

    const result = await fileHandler.multiReplace({
      path: filePath,
      chunks: [
        { startLine: 1, endLine: 1, targetContent: "one", replacementContent: "ONE" },
        { startLine: 3, endLine: 3, targetContent: "WRONG", replacementContent: "THREE" },
      ],
    });

    expect((result as { error: string }).error).toContain("No changes were applied to the file");
    expect((result as { error: string }).error).toContain("[3, 3]");
    expect((result as { actualContentInRange: string }).actualContentInRange).toBe("3: three");
    // Even the valid first chunk must NOT have been applied
    expect(await readFile(filePath, "utf-8")).toBe(original);
  });
});

// ── recursive delete ────────────────────────────────────────

describe("FileHandler.deleteFile recursive", () => {
  it("refuses to delete a directory without recursive, mentioning the flag", async () => {
    const dirPath = join(workspaceRoot, "del-dir-refuse");
    await mkdir(join(dirPath, "sub"), { recursive: true });
    await writeFile(join(dirPath, "sub", "f.txt"), "hi", "utf-8");

    const result = await fileHandler.deleteFile({ path: dirPath });
    expect((result as { error: string }).error).toContain("recursive");
  });

  it("removes a directory tree when recursive is true", async () => {
    const dirPath = join(workspaceRoot, "del-dir-recursive");
    await mkdir(join(dirPath, "sub"), { recursive: true });
    await writeFile(join(dirPath, "sub", "f.txt"), "hi", "utf-8");

    const result = await fileHandler.deleteFile({ path: dirPath, recursive: true });
    expect(result).not.toHaveProperty("error");
    expect((result as { deleted: boolean }).deleted).toBe(true);
    expect((result as { isDirectory: boolean }).isDirectory).toBe(true);
    const { existsSync } = await import("node:fs");
    expect(existsSync(dirPath)).toBe(false);
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

  it("refuses runInBackground honestly instead of blocking then killing", async () => {
    const start = Date.now();
    const result = await commandHandler.run({
      command: "sleep 300",
      cwd: workspaceRoot,
      runInBackground: true,
    });
    // Must return immediately, not run to any timeout
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Background execution is not supported");
  });

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
