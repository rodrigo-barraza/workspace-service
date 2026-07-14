// ─── Local Git Operations ───────────────────────────────────

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { validateWorkspacePath } from "../utils.ts";
import type { GitStatusParams, GitDiffParams, GitLogParams, GitFileChange } from "../types.ts";

const GIT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

// ────────────────────────────────────────────────────────────
// Internal Git Runner
// ────────────────────────────────────────────────────────────

interface GitResult {
  stdout?: string;
  stderr?: string;
  error?: string;
  exitCode?: number | null;
  truncated?: boolean;
}

async function runGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve_: (value: GitResult) => void) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let truncated = false;
    let settled = false;

    const child = spawn("git", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "echo",
        LANG: "C.UTF-8",
      },
      detached: false,
    });

    child.stdin.end();

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutLen >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      stdoutChunks.push(chunk);
      stdoutLen += chunk.length;
      if (stdoutLen > MAX_OUTPUT_BYTES) truncated = true;
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrLen < MAX_OUTPUT_BYTES) {
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
      }
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        resolve_({ error: `Git command timed out after ${GIT_TIMEOUT_MS}ms` });
      }
    }, GIT_TIMEOUT_MS);

    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");

      if (code !== 0) {
        resolve_({ error: stderr.trim() || `Git exited with code ${code}`, exitCode: code });
        return;
      }

      // A >512KB diff used to be silently cut — the caller (an LLM) would read
      // partial output as complete. Mark it.
      resolve_({
        stdout: truncated ? stdout + "\n... [output truncated]" : stdout,
        stderr: stderr.trim(),
        ...(truncated && { truncated }),
      });
    });

    child.on("error", (processError: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve_({ error: `Git process error: ${processError.message}` });
      }
    });
  });
}

// ────────────────────────────────────────────────────────────
// Git Handler
// ────────────────────────────────────────────────────────────

export class GitHandler {
  roots: string[];
  constructor(roots: string[]) {
    this.roots = roots.map((r: string) => resolve(r));
  }

  validatePath(inputPath: string) {
    return validateWorkspacePath(inputPath, this.roots);
  }

  async status({ path: repoPath }: GitStatusParams) {
    const validation = this.validatePath(repoPath);
    if (!validation.safe) return { error: validation.error };

    const cwd = validation.resolved;

    const branchResult = await runGit(["branch", "--show-current"], cwd);
    if (branchResult.error) return { error: branchResult.error, path: cwd };

    const branch = (branchResult.stdout || "").trim();

    const statusResult = await runGit(
      ["status", "--short", "--branch", "--untracked-files=all"],
      cwd,
    );
    if (statusResult.error) return { error: statusResult.error, path: cwd };

    const lines = (statusResult.stdout || "").trim().split("\n").filter(Boolean);
    const branchLine = lines[0] || "";
    const fileLines = lines.slice(1);

    const aheadMatch = branchLine.match(/ahead (\d+)/);
    const behindMatch = branchLine.match(/behind (\d+)/);

    const staged: GitFileChange[] = [];
    const unstaged: GitFileChange[] = [];
    const untracked: string[] = [];

    for (const line of fileLines) {
      const indexStatus = line[0];
      const workTreeStatus = line[1];
      const file = line.slice(3);

      if (indexStatus === "?" && workTreeStatus === "?") {
        untracked.push(file);
      } else {
        if (indexStatus !== " " && indexStatus !== "?") staged.push({ status: indexStatus, file });
        if (workTreeStatus !== " " && workTreeStatus !== "?") unstaged.push({ status: workTreeStatus, file });
      }
    }

    return {
      path: cwd,
      branch,
      ahead: aheadMatch ? parseInt(aheadMatch[1]) : 0,
      behind: behindMatch ? parseInt(behindMatch[1]) : 0,
      staged,
      unstaged,
      untracked,
      totalChanges: staged.length + unstaged.length + untracked.length,
      clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
    };
  }

  async diff({ path: repoPath, staged = false, filePath, ref }: GitDiffParams) {
    const validation = this.validatePath(repoPath);
    if (!validation.safe) return { error: validation.error };

    const cwd = validation.resolved;
    const args = ["diff", "--stat", "--patch"];

    if (staged) args.push("--cached");
    if (ref) args.push(ref);
    args.push("--");

    if (filePath) {
      const fileValidation = this.validatePath(filePath);
      if (!fileValidation.safe) return { error: fileValidation.error };
      args.push(fileValidation.resolved);
    }

    const result = await runGit(args, cwd);
    if (result.error) return { error: result.error, path: cwd };

    const diff = result.stdout || "";
    const hasChanges = diff.trim().length > 0;
    const additions = (diff.match(/^\+[^+]/gm) || []).length;
    const deletions = (diff.match(/^-[^-]/gm) || []).length;

    return {
      path: cwd,
      staged,
      ...(filePath && { file: filePath }),
      ...(ref && { ref }),
      hasChanges,
      additions,
      deletions,
      ...(result.truncated && { truncated: true }),
      diff: hasChanges ? diff : "(no changes)",
    };
  }

  async log({ path: repoPath, limit = 20, author, since, filePath }: GitLogParams) {
    const validation = this.validatePath(repoPath);
    if (!validation.safe) return { error: validation.error };

    const cwd = validation.resolved;
    const clampedLimit = Math.min(Math.max(limit, 1), 100);

    const separator = "<<<COMMIT>>>";
    const formatStr = `${separator}%H|%h|%an|%ae|%ai|%s`;
    const args = ["log", `--format=${formatStr}`, `-n`, String(clampedLimit)];

    if (author) args.push(`--author=${author}`);
    if (since) args.push(`--since=${since}`);

    if (filePath) {
      const fileValidation = this.validatePath(filePath);
      if (!fileValidation.safe) return { error: fileValidation.error };
      args.push("--", fileValidation.resolved);
    }

    const result = await runGit(args, cwd);
    if (result.error) return { error: result.error, path: cwd };

    const commits = (result.stdout || "")
      .split(separator)
      .filter((s: string) => s.trim())
      .map((entry: string) => {
        const parts = entry.trim().split("|");
        return {
          hash: parts[0] || "",
          shortHash: parts[1] || "",
          author: parts[2] || "",
          email: parts[3] || "",
          date: parts[4] || "",
          message: parts.slice(5).join("|") || "",
        };
      });

    return {
      path: cwd,
      totalCommits: commits.length,
      commits,
    };
  }
}
