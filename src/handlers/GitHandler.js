// ============================================================
// Git Handler — Local Git Operations
// ============================================================
// Mirrors AgenticGitService — status, diff, log via subprocess.
// ============================================================

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import logger from "../logger.js";

const GIT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

// ────────────────────────────────────────────────────────────
// Internal Git Runner
// ────────────────────────────────────────────────────────────

async function runGit(args, cwd) {
  return new Promise((res) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutLen = 0;
    let stderrLen = 0;
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
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        res({ error: `Git command timed out after ${GIT_TIMEOUT_MS}ms` });
      }
    }, GIT_TIMEOUT_MS);

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");

      if (code !== 0) {
        res({ error: stderr.trim() || `Git exited with code ${code}`, exitCode: code });
        return;
      }

      res({ stdout, stderr: stderr.trim() });
    });

    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        res({ error: `Git process error: ${err.message}` });
      }
    });
  });
}

// ────────────────────────────────────────────────────────────
// Git Handler
// ────────────────────────────────────────────────────────────

export class GitHandler {
  constructor(roots) {
    this.roots = roots.map((r) => resolve(r));
  }

  validatePath(inputPath) {
    if (!inputPath || typeof inputPath !== "string") {
      return { safe: false, resolved: "", error: "Path is required" };
    }
    const resolved = resolve(inputPath);
    const inRoot = this.roots.some(
      (root) => resolved.startsWith(root + "/") || resolved === root,
    );
    if (!inRoot) {
      return { safe: false, resolved, error: `Path '${resolved}' is outside allowed roots` };
    }
    return { safe: true, resolved };
  }

  async status({ path: repoPath }) {
    const validation = this.validatePath(repoPath);
    if (!validation.safe) return { error: validation.error };

    const cwd = validation.resolved;

    const branchResult = await runGit(["branch", "--show-current"], cwd);
    if (branchResult.error) return { error: branchResult.error, path: cwd };

    const branch = branchResult.stdout.trim();

    const statusResult = await runGit(
      ["status", "--short", "--branch", "--untracked-files=all"],
      cwd,
    );
    if (statusResult.error) return { error: statusResult.error, path: cwd };

    const lines = statusResult.stdout.trim().split("\n").filter(Boolean);
    const branchLine = lines[0] || "";
    const fileLines = lines.slice(1);

    const aheadMatch = branchLine.match(/ahead (\d+)/);
    const behindMatch = branchLine.match(/behind (\d+)/);

    const staged = [];
    const unstaged = [];
    const untracked = [];

    for (const line of fileLines) {
      const x = line[0];
      const y = line[1];
      const file = line.slice(3);

      if (x === "?" && y === "?") {
        untracked.push(file);
      } else {
        if (x !== " " && x !== "?") staged.push({ status: x, file });
        if (y !== " " && y !== "?") unstaged.push({ status: y, file });
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

  async diff({ path: repoPath, staged = false, filePath, ref }) {
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

    const diff = result.stdout;
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
      diff: hasChanges ? diff : "(no changes)",
    };
  }

  async log({ path: repoPath, limit = 20, author, since, filePath }) {
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

    const commits = result.stdout
      .split(separator)
      .filter((s) => s.trim())
      .map((entry) => {
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
