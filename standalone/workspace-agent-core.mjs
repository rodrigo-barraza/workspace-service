#!/usr/bin/env node

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Workspace Agent Core — Importable module
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
//  Zero dependencies. Runs on Node.js 22+ (uses built-in WebSocket).
//
//  This module exports the WorkspaceAgent class and all handler
//  functions. It is imported by both the terminal CLI wrapper
//  and the Electron tray application.
//
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { readFile, writeFile, stat, readdir, mkdir, rename, unlink } from "node:fs/promises";
import { resolve, relative, extname, dirname, basename } from "node:path";
import { existsSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";


// ────────────────────────────────────────────────────────────
// Default Logger (can be overridden via setLogger)
// ────────────────────────────────────────────────────────────

const COLORS = { reset: "\x1b[0m", dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m", cyan: "\x1b[36m", magenta: "\x1b[35m" };

function timestamp() { return new Date().toISOString().slice(11, 23); }

let activeLogger = {
  info:    (message) => console.log(`${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.blue}INFO${COLORS.reset}  ${message}`),
  success: (message) => console.log(`${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.green}  OK${COLORS.reset}  ${message}`),
  warn:    (message) => console.log(`${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.yellow}WARN${COLORS.reset}  ${message}`),
  error:   (message) => console.log(`${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.red} ERR${COLORS.reset}  ${message}`),
  rpc:     (direction, method, id) => console.log(`${COLORS.dim}${timestamp()}${COLORS.reset} ${COLORS.magenta} RPC${COLORS.reset}  ${direction === "in" ? "←" : "→"} ${method} ${COLORS.dim}(${id})${COLORS.reset}`),
};

export function setLogger(customLogger) {
  activeLogger = { ...activeLogger, ...customLogger };
}

function getLogger() {
  return activeLogger;
}

// ────────────────────────────────────────────────────────────
// Utility
// ────────────────────────────────────────────────────────────

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(glob) {
  const regex = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<<GLOBSTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<GLOBSTAR>>>/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`(^|/)${regex}$`, "i");
}

// ────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────

const MAX_READ_BYTES = 1_048_576;
const MAX_WRITE_BYTES = 5_242_880;
const MAX_LINES_PER_READ = 800;
const MAX_GREP_RESULTS = 50;
const MAX_GLOB_RESULTS = 200;
const MAX_DIR_ENTRIES = 500;
const MAX_TREE_ENTRIES = 1000;
const MAX_TREE_DEPTH = 6;
const GIT_TIMEOUT_MS = 10_000;
const COMMAND_DEFAULT_TIMEOUT_MS = 60_000;
const COMMAND_MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 512 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico",
  ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".avi", ".mov",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".exe", ".dll", ".so", ".dylib",
  ".wasm", ".pyc", ".class",
]);

const PREVIEW_IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif", ".tiff", ".tif",
]);
const MAX_PREVIEW_BYTES = 2_097_152;

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".nuxt", "__pycache__",
  "dist", "build", ".cache", ".turbo", "coverage",
  ".venv", "venv", "env",
]);

// ────────────────────────────────────────────────────────────
// Path Validation
// ────────────────────────────────────────────────────────────

function validatePath(inputPath, roots) {
  if (!inputPath || typeof inputPath !== "string") {
    return { safe: false, resolved: "", error: "Path is required (string)" };
  }
  const resolved = inputPath.startsWith("/") || /^[A-Za-z]:/.test(inputPath)
    ? resolve(inputPath)
    : resolve(roots[0], inputPath);
  return { safe: true, resolved };
}

// ────────────────────────────────────────────────────────────
// File Handlers
// ────────────────────────────────────────────────────────────

async function handleReadFile(roots, { path: filePath, startLine, endLine, raw: rawMode = false }) {
  const validation = validatePath(filePath, roots);
  if (!validation.safe) return { error: validation.error };
  const resolved = validation.resolved;
  try {
    const fileStats = await stat(resolved);
    if (fileStats.isDirectory()) return { error: `'${resolved}' is a directory, not a file.` };
    if (fileStats.size > MAX_READ_BYTES) return { error: `File is ${(fileStats.size / 1024).toFixed(1)} KB — exceeds max read size.` };
    const fileExtension = extname(resolved).toLowerCase();
    if (BINARY_EXTENSIONS.has(fileExtension)) {
      const includeBase64 = rawMode || (PREVIEW_IMAGE_EXTENSIONS.has(fileExtension) && fileStats.size <= MAX_PREVIEW_BYTES);
      if (includeBase64) {
        const buffer = await readFile(resolved);
        return { filePath: resolved, isBinary: true, extension: fileExtension, sizeBytes: fileStats.size, contentBase64: buffer.toString("base64") };
      }
      return { filePath: resolved, isBinary: true, extension: fileExtension, sizeBytes: fileStats.size, message: `Binary file detected (${fileExtension}).` };
    }
    const rawContent = await readFile(resolved, "utf-8");
    if (rawMode) {
      return { filePath: resolved, totalLines: rawContent.split("\n").length, totalBytes: fileStats.size, content: rawContent, lastModified: fileStats.mtime.toISOString() };
    }
    const allLines = rawContent.split("\n");
    const totalLines = allLines.length;
    const start = startLine ? Math.max(1, startLine) : 1;
    let end = endLine ? Math.min(totalLines, endLine) : totalLines;
    if (end - start + 1 > MAX_LINES_PER_READ) end = start + MAX_LINES_PER_READ - 1;
    const selectedLines = allLines.slice(start - 1, end);
    const numberedContent = selectedLines.map((line, index) => `${start + index}: ${line}`).join("\n");
    return { filePath: resolved, totalLines, totalBytes: fileStats.size, startLine: start, endLine: Math.min(end, totalLines), linesReturned: selectedLines.length, truncated: end < totalLines, content: numberedContent };
  } catch (error) {
    if (error.code === "ENOENT") return { error: `File not found: ${resolved}` };
    return { error: `Read failed: ${error.message}` };
  }
}

async function handleWriteFile(roots, { path: filePath, content, createDirs = true }) {
  const validation = validatePath(filePath, roots);
  if (!validation.safe) return { error: validation.error };
  if (typeof content !== "string") return { error: "'content' must be a string" };
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MAX_WRITE_BYTES) return { error: `Content exceeds max write size.` };
  const resolved = validation.resolved;
  try {
    if (createDirs) await mkdir(dirname(resolved), { recursive: true });
    const existed = existsSync(resolved);
    await writeFile(resolved, content, "utf-8");
    return { filePath: resolved, created: !existed, overwritten: existed, bytesWritten: bytes, linesWritten: content.split("\n").length };
  } catch (error) {
    return { error: `Write failed: ${error.message}` };
  }
}

async function handleStrReplace(roots, { path: filePath, oldStr, newStr, allowMultiple = false }) {
  const validation = validatePath(filePath, roots);
  if (!validation.safe) return { error: validation.error };
  if (!oldStr || typeof oldStr !== "string") return { error: "'oldStr' is required" };
  if (typeof newStr !== "string") return { error: "'newStr' must be a string" };
  const resolved = validation.resolved;
  try {
    const content = await readFile(resolved, "utf-8");
    let count = 0;
    let index = -1;
    while ((index = content.indexOf(oldStr, index + 1)) !== -1) count++;
    if (count === 0) return { error: "No match found for 'oldStr'.", filePath: resolved, matchCount: 0 };
    if (count > 1 && !allowMultiple) return { error: `Found ${count} occurrences but allowMultiple is false.`, filePath: resolved, matchCount: count };
    const updated = allowMultiple ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
    await writeFile(resolved, updated, "utf-8");
    return { filePath: resolved, matchCount: count, replacementsApplied: allowMultiple ? count : 1, oldLines: oldStr.split("\n").length, newLines: newStr.split("\n").length, lineDelta: newStr.split("\n").length - oldStr.split("\n").length };
  } catch (error) {
    if (error.code === "ENOENT") return { error: `File not found: ${resolved}` };
    return { error: `str_replace failed: ${error.message}` };
  }
}

async function handleFileInfo(roots, { paths }) {
  const pathList = Array.isArray(paths) ? paths : [paths];
  if (pathList.length === 0) return { error: "'paths' must be non-empty" };
  if (pathList.length > 20) return { error: `Maximum 20 paths. Received ${pathList.length}.` };
  const results = await Promise.all(pathList.map(async (pathString) => {
    const validation = validatePath(pathString, roots);
    if (!validation.safe) return { path: pathString, exists: false, error: validation.error };
    const resolved = validation.resolved;
    try {
      const fileStats = await stat(resolved);
      const fileExtension = extname(resolved).toLowerCase();
      const info = { path: resolved, exists: true, isFile: fileStats.isFile(), isDirectory: fileStats.isDirectory(), sizeBytes: fileStats.size, lastModified: fileStats.mtime.toISOString(), extension: fileExtension || null, isBinary: BINARY_EXTENSIONS.has(fileExtension) };
      if (fileStats.isFile() && !BINARY_EXTENSIONS.has(fileExtension) && fileStats.size <= MAX_READ_BYTES) {
        try { const content = await readFile(resolved, "utf-8"); info.lines = content.split("\n").length; } catch {}
      }
      return info;
    } catch (error) {
      if (error.code === "ENOENT") return { path: resolved, exists: false };
      return { path: resolved, exists: false, error: error.message };
    }
  }));
  if (pathList.length === 1) return results[0];
  return { totalRequested: pathList.length, results };
}

async function handleMoveFile(roots, { source, destination, createDirs = true }) {
  const validSrc = validatePath(source, roots);
  if (!validSrc.safe) return { error: validSrc.error };
  const validDst = validatePath(destination, roots);
  if (!validDst.safe) return { error: validDst.error };
  try {
    if (!existsSync(validSrc.resolved)) return { error: `Source not found: ${validSrc.resolved}` };
    if (existsSync(validDst.resolved)) return { error: `Destination already exists: ${validDst.resolved}` };
    if (createDirs) await mkdir(dirname(validDst.resolved), { recursive: true });
    await rename(validSrc.resolved, validDst.resolved);
    return { source: validSrc.resolved, destination: validDst.resolved, success: true };
  } catch (error) {
    return { error: `move_file failed: ${error.message}` };
  }
}

async function handleDeleteFile(roots, { path: filePath }) {
  const validation = validatePath(filePath, roots);
  if (!validation.safe) return { error: validation.error };
  try {
    const fileStats = await stat(validation.resolved);
    if (fileStats.isDirectory()) return { error: `'${validation.resolved}' is a directory.` };
    const sizeBytes = fileStats.size;
    await unlink(validation.resolved);
    return { filePath: validation.resolved, deleted: true, sizeBytes };
  } catch (error) {
    if (error.code === "ENOENT") return { error: `File not found: ${validation.resolved}` };
    return { error: `delete_file failed: ${error.message}` };
  }
}

async function handleMultiFileRead(roots, { files }) {
  if (!Array.isArray(files) || files.length === 0) return { error: "'files' must be a non-empty array" };
  if (files.length > 20) return { error: `Maximum 20 files. Received ${files.length}.` };
  const results = await Promise.all(files.map(async (fileItem) => {
    const result = await handleReadFile(roots, { path: fileItem.path, startLine: fileItem.startLine, endLine: fileItem.endLine });
    return { path: fileItem.path, ...result };
  }));
  const succeeded = results.filter((result) => !result.error).length;
  return { totalRequested: files.length, succeeded, failed: files.length - succeeded, results };
}

// ────────────────────────────────────────────────────────────
// Directory Handlers
// ────────────────────────────────────────────────────────────

async function handleListDirectory(roots, { path: dirPath, recursive = false, maxDepth = 3 }) {
  const validation = validatePath(dirPath, roots);
  if (!validation.safe) return { error: validation.error };
  const resolved = validation.resolved;
  try {
    const dirStats = await stat(resolved);
    if (!dirStats.isDirectory()) return { error: `'${resolved}' is a file, not a directory.` };
    const entries = [];
    const walk = async (dir, depth) => {
      if (entries.length >= MAX_DIR_ENTRIES || depth > maxDepth) return;
      const dirEntries = await readdir(dir, { withFileTypes: true });
      for (const entry of dirEntries) {
        if (entries.length >= MAX_DIR_ENTRIES) break;
        const fullPath = resolve(dir, entry.name);
        const relPath = relative(resolved, fullPath);
        if (entry.isDirectory()) {
          entries.push({ name: entry.name, path: relPath, isDir: true });
          if (recursive && depth < maxDepth) await walk(fullPath, depth + 1);
        } else {
          try {
            const fileStat = await stat(fullPath);
            entries.push({ name: entry.name, path: relPath, isDir: false, sizeBytes: fileStat.size });
          } catch { entries.push({ name: entry.name, path: relPath, isDir: false }); }
        }
      }
    };
    await walk(resolved, 1);
    return { directory: resolved, totalEntries: entries.length, truncated: entries.length >= MAX_DIR_ENTRIES, entries };
  } catch (error) {
    if (error.code === "ENOENT") return { error: `Directory not found: ${resolved}` };
    return { error: `list_directory failed: ${error.message}` };
  }
}

async function handleCreateDirectory(roots, { path: dirPath }) {
  const validation = validatePath(dirPath, roots);
  if (!validation.safe) return { error: validation.error };
  const resolved = validation.resolved;
  try {
    if (existsSync(resolved)) {
      const dirStats = await stat(resolved);
      if (dirStats.isDirectory()) return { path: resolved, created: false, message: "Directory already exists" };
      return { error: `'${resolved}' exists and is not a directory` };
    }
    await mkdir(resolved, { recursive: true });
    return { path: resolved, created: true };
  } catch (error) {
    return { error: `create_directory failed: ${error.message}` };
  }
}

// ────────────────────────────────────────────────────────────
// Search Handlers
// ────────────────────────────────────────────────────────────

async function handleGrepSearch(roots, { pattern, searchPath, isRegex = false, includes = [], caseInsensitive = false, matchPerLine = true }) {
  const validation = validatePath(searchPath, roots);
  if (!validation.safe) return { error: validation.error };
  if (!pattern || typeof pattern !== "string") return { error: "'pattern' is required" };
  const resolved = validation.resolved;
  try {
    let regex;
    try {
      regex = isRegex ? new RegExp(pattern, caseInsensitive ? "gi" : "g") : new RegExp(escapeRegex(pattern), caseInsensitive ? "gi" : "g");
    } catch (error) { return { error: `Invalid regex: ${error.message}` }; }
    const results = [];
    const fileMatches = new Set();
    const searchFile = async (filePath) => {
      if (results.length >= MAX_GREP_RESULTS) return;
      if (BINARY_EXTENSIONS.has(extname(filePath).toLowerCase())) return;
      try {
        const fileStat = await stat(filePath);
        if (fileStat.size > MAX_READ_BYTES) return;
        const content = await readFile(filePath, "utf-8");
        const lines = content.split("\n");
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
          if (results.length >= MAX_GREP_RESULTS) break;
          regex.lastIndex = 0;
          if (regex.test(lines[lineIndex])) {
            fileMatches.add(filePath);
            if (matchPerLine) {
              results.push({ file: filePath, line: lineIndex + 1, content: lines[lineIndex].length > 500 ? lines[lineIndex].slice(0, 500) + "..." : lines[lineIndex] });
            }
          }
        }
      } catch {}
    };
    const walkDir = async (dir) => {
      if (results.length >= MAX_GREP_RESULTS) return;
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= MAX_GREP_RESULTS) break;
          const fullPath = resolve(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name === ".git") continue;
            await walkDir(fullPath);
          } else {
            if (includes.length > 0) {
              const matched = includes.some((glob) => { if (glob.startsWith("*.")) return entry.name.endsWith(glob.slice(1)); return entry.name === glob; });
              if (!matched) continue;
            }
            await searchFile(fullPath);
          }
        }
      } catch {}
    };
    const searchStats = await stat(resolved);
    if (searchStats.isFile()) await searchFile(resolved);
    else await walkDir(resolved);
    if (!matchPerLine) return { pattern, searchPath: resolved, matchingFiles: [...fileMatches], totalFiles: fileMatches.size, truncated: fileMatches.size >= MAX_GREP_RESULTS };
    return { pattern, searchPath: resolved, totalMatches: results.length, truncated: results.length >= MAX_GREP_RESULTS, results };
  } catch (error) { return { error: `grep_search failed: ${error.message}` }; }
}

async function handleGlobFiles(roots, { pattern, searchPath }) {
  const validation = validatePath(searchPath, roots);
  if (!validation.safe) return { error: validation.error };
  if (!pattern || typeof pattern !== "string") return { error: "'pattern' is required" };
  const resolved = validation.resolved;
  const matches = [];
  const globRegex = globToRegex(pattern);
  const walk = async (dir) => {
    if (matches.length >= MAX_GLOB_RESULTS) return;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (matches.length >= MAX_GLOB_RESULTS) break;
        const fullPath = resolve(dir, entry.name);
        const relPath = relative(resolved, fullPath);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".git") continue;
          await walk(fullPath);
        } else {
          if (globRegex.test(relPath) || globRegex.test(entry.name)) {
            try { const fileStat = await stat(fullPath); matches.push({ path: fullPath, relativePath: relPath, name: entry.name, sizeBytes: fileStat.size }); }
            catch { matches.push({ path: fullPath, relativePath: relPath, name: entry.name }); }
          }
        }
      }
    } catch {}
  };
  try { await walk(resolved); return { pattern, searchPath: resolved, totalMatches: matches.length, truncated: matches.length >= MAX_GLOB_RESULTS, matches }; }
  catch (error) { return { error: `glob_files failed: ${error.message}` }; }
}

// ────────────────────────────────────────────────────────────
// Git Handlers
// ────────────────────────────────────────────────────────────

function runGit(args, cwd) {
  return new Promise((resolvePromise) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let settled = false;
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", LANG: "C.UTF-8" }, detached: false });
    child.stdin.end();
    child.stdout.on("data", (chunk) => { if (stdoutLen < MAX_OUTPUT_BYTES) { stdoutChunks.push(chunk); stdoutLen += chunk.length; } });
    child.stderr.on("data", (chunk) => { if (stderrLen < MAX_OUTPUT_BYTES) { stderrChunks.push(chunk); stderrLen += chunk.length; } });
    const timer = setTimeout(() => { child.kill("SIGKILL"); if (!settled) { settled = true; resolvePromise({ error: `Git timed out after ${GIT_TIMEOUT_MS}ms` }); } }, GIT_TIMEOUT_MS);
    child.on("close", (code) => { if (settled) return; settled = true; clearTimeout(timer); const stdout = Buffer.concat(stdoutChunks).toString("utf-8"); const stderr = Buffer.concat(stderrChunks).toString("utf-8"); if (code !== 0) { resolvePromise({ error: stderr.trim() || `Git exited with code ${code}`, exitCode: code }); return; } resolvePromise({ stdout, stderr: stderr.trim() }); });
    child.on("error", (processError) => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise({ error: `Git process error: ${processError.message}` }); } });
  });
}

async function handleGitStatus(roots, { path: repoPath }) {
  const validation = validatePath(repoPath, roots);
  if (!validation.safe) return { error: validation.error };
  const cwd = validation.resolved;
  const branchResult = await runGit(["branch", "--show-current"], cwd);
  if (branchResult.error) return { error: branchResult.error, path: cwd };
  const branch = (branchResult.stdout || "").trim();
  const statusResult = await runGit(["status", "--short", "--branch", "--untracked-files=all"], cwd);
  if (statusResult.error) return { error: statusResult.error, path: cwd };
  const lines = (statusResult.stdout || "").trim().split("\n").filter(Boolean);
  const branchLine = lines[0] || "";
  const fileLines = lines.slice(1);
  const aheadMatch = branchLine.match(/ahead (\d+)/);
  const behindMatch = branchLine.match(/behind (\d+)/);
  const staged = [], unstaged = [], untracked = [];
  for (const line of fileLines) {
    const indexStatus = line[0]; const workTreeStatus = line[1]; const file = line.slice(3);
    if (indexStatus === "?" && workTreeStatus === "?") { untracked.push(file); }
    else { if (indexStatus !== " " && indexStatus !== "?") staged.push({ status: indexStatus, file }); if (workTreeStatus !== " " && workTreeStatus !== "?") unstaged.push({ status: workTreeStatus, file }); }
  }
  return { path: cwd, branch, ahead: aheadMatch ? parseInt(aheadMatch[1]) : 0, behind: behindMatch ? parseInt(behindMatch[1]) : 0, staged, unstaged, untracked, totalChanges: staged.length + unstaged.length + untracked.length, clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0 };
}

async function handleGitDiff(roots, { path: repoPath, staged = false, filePath, ref }) {
  const validation = validatePath(repoPath, roots);
  if (!validation.safe) return { error: validation.error };
  const cwd = validation.resolved;
  const args = ["diff", "--stat", "--patch"];
  if (staged) args.push("--cached");
  if (ref) args.push(ref);
  args.push("--");
  if (filePath) { const fileValidation = validatePath(filePath, roots); if (!fileValidation.safe) return { error: fileValidation.error }; args.push(fileValidation.resolved); }
  const result = await runGit(args, cwd);
  if (result.error) return { error: result.error, path: cwd };
  const diff = result.stdout || "";
  const hasChanges = diff.trim().length > 0;
  return { path: cwd, staged, ...(filePath && { file: filePath }), ...(ref && { ref }), hasChanges, additions: (diff.match(/^\+[^+]/gm) || []).length, deletions: (diff.match(/^-[^-]/gm) || []).length, diff: hasChanges ? diff : "(no changes)" };
}

async function handleGitLog(roots, { path: repoPath, limit = 20, author, since, filePath }) {
  const validation = validatePath(repoPath, roots);
  if (!validation.safe) return { error: validation.error };
  const cwd = validation.resolved;
  const clampedLimit = Math.min(Math.max(limit, 1), 100);
  const separator = "<<<COMMIT>>>";
  const args = ["log", `--format=${separator}%H|%h|%an|%ae|%ai|%s`, "-n", String(clampedLimit)];
  if (author) args.push(`--author=${author}`);
  if (since) args.push(`--since=${since}`);
  if (filePath) { const fileValidation = validatePath(filePath, roots); if (!fileValidation.safe) return { error: fileValidation.error }; args.push("--", fileValidation.resolved); }
  const result = await runGit(args, cwd);
  if (result.error) return { error: result.error, path: cwd };
  const commits = (result.stdout || "").split(separator).filter((text) => text.trim()).map((entry) => { const parts = entry.trim().split("|"); return { hash: parts[0] || "", shortHash: parts[1] || "", author: parts[2] || "", email: parts[3] || "", date: parts[4] || "", message: parts.slice(5).join("|") || "" }; });
  return { path: cwd, totalCommits: commits.length, commits };
}

// ────────────────────────────────────────────────────────────
// Command Handler
// ────────────────────────────────────────────────────────────

async function handleCommandRun(roots, { command, cwd, timeout = COMMAND_DEFAULT_TIMEOUT_MS }) {
  const clampedTimeout = Math.min(Math.max(timeout, 1000), COMMAND_MAX_TIMEOUT_MS);
  if (!command || typeof command !== "string") return { success: false, stdout: "", stderr: "", exitCode: null, executionTimeMs: 0, error: "Command is required" };
  const startTime = performance.now();
  return new Promise((resolvePromise) => {
    const stdoutChunks = []; const stderrChunks = [];
    let stdoutLen = 0, stderrLen = 0, timedOut = false, settled = false;
    const shell = process.platform === "win32" ? "cmd" : "bash";
    const shellArgs = process.platform === "win32" ? ["/c", command] : ["-l", "-c", command];
    const child = spawn(shell, shellArgs, { cwd: cwd || roots[0], stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CI: "true", FORCE_COLOR: "0", NO_COLOR: "1" }, detached: false });
    child.stdin.end();
    child.stdout.on("data", (chunk) => { if (stdoutLen < MAX_OUTPUT_BYTES) { stdoutChunks.push(chunk); stdoutLen += chunk.length; } });
    child.stderr.on("data", (chunk) => { if (stderrLen < MAX_OUTPUT_BYTES) { stderrChunks.push(chunk); stderrLen += chunk.length; } });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, clampedTimeout);
    function finish(exitCode) {
      if (settled) return; settled = true; clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      resolvePromise({ success: exitCode === 0 && !timedOut, stdout: stdoutLen > MAX_OUTPUT_BYTES ? stdout + "\n... [truncated]" : stdout, stderr: stderrLen > MAX_OUTPUT_BYTES ? stderr + "\n... [truncated]" : stderr, exitCode: timedOut ? null : exitCode, executionTimeMs: Math.round(performance.now() - startTime), timedOut, ...(timedOut && { error: `Command timed out after ${clampedTimeout}ms` }) });
    }
    child.on("close", (code) => finish(code));
    child.on("error", (processError) => { if (!settled) { settled = true; clearTimeout(timer); resolvePromise({ success: false, stdout: "", stderr: "", exitCode: null, executionTimeMs: Math.round(performance.now() - startTime), error: `Process error: ${processError.message}` }); } });
  });
}

// ────────────────────────────────────────────────────────────
// Project Handler
// ────────────────────────────────────────────────────────────

async function handleProjectSummary(roots, { path: projectPath, maxDepth = MAX_TREE_DEPTH }) {
  const validation = validatePath(projectPath, roots);
  if (!validation.safe) return { error: validation.error };
  const resolved = validation.resolved;
  const clampedDepth = Math.min(Math.max(maxDepth, 1), MAX_TREE_DEPTH);
  let entryCount = 0;
  const buildTree = async (dir, depth) => {
    if (entryCount >= MAX_TREE_ENTRIES || depth > clampedDepth) return [];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const sorted = entries.sort((a, b) => { if (a.isDirectory() && !b.isDirectory()) return -1; if (!a.isDirectory() && b.isDirectory()) return 1; return a.name.localeCompare(b.name); });
      const results = [];
      const directoriesToRecurse = [];
      for (const entry of sorted) {
        if (entryCount >= MAX_TREE_ENTRIES) break;
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
        const fullPath = resolve(dir, entry.name);
        entryCount++;
        if (entry.isDirectory()) {
          const resultIndex = results.length;
          results.push({ name: entry.name, type: "directory", children: [] });
          if (depth < clampedDepth) directoriesToRecurse.push({ index: resultIndex, fullPath });
        }
        else { try { const fileStat = await stat(fullPath); results.push({ name: entry.name, type: "file", sizeBytes: fileStat.size }); } catch { results.push({ name: entry.name, type: "file" }); } }
      }
      for (const { index, fullPath } of directoriesToRecurse) {
        if (entryCount >= MAX_TREE_ENTRIES) break;
        results[index].children = await buildTree(fullPath, depth + 1);
      }
      return results;
    } catch { return []; }
  };
  const tree = await buildTree(resolved, 1);
  return { projectPath: resolved, projectName: basename(resolved), totalEntries: entryCount, truncated: entryCount >= MAX_TREE_ENTRIES, maxDepth: clampedDepth, tree };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WebSocket Agent Client (uses Node.js 22+ built-in WebSocket)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class WorkspaceAgent extends EventEmitter {
  constructor({ backendUrl, roots, name, secret, reconnectInterval = 5000 }) {
    super();
    this.backendUrl = backendUrl;
    this.roots = roots;
    this.name = name;
    this.secret = secret;
    this.reconnectInterval = reconnectInterval;
    this.agentId = crypto.randomUUID();
    this.webSocket = null;
    this.isConnected = false;
    this.isIntentionalClose = false;
    this.reconnectAttempts = 0;
    this.heartbeatTimer = null;

    this.methodMap = new Map([
      ["file.read", (parameters) => handleReadFile(roots, parameters)],
      ["file.write", (parameters) => handleWriteFile(roots, parameters)],
      ["file.strReplace", (parameters) => handleStrReplace(roots, parameters)],
      ["file.info", (parameters) => handleFileInfo(roots, parameters)],
      ["file.move", (parameters) => handleMoveFile(roots, parameters)],
      ["file.delete", (parameters) => handleDeleteFile(roots, parameters)],
      ["file.readMulti", (parameters) => handleMultiFileRead(roots, parameters)],
      ["directory.list", (parameters) => handleListDirectory(roots, parameters)],
      ["directory.create", (parameters) => handleCreateDirectory(roots, parameters)],
      ["search.grep", (parameters) => handleGrepSearch(roots, parameters)],
      ["search.glob", (parameters) => handleGlobFiles(roots, parameters)],
      ["git.status", (parameters) => handleGitStatus(roots, parameters)],
      ["git.diff", (parameters) => handleGitDiff(roots, parameters)],
      ["git.log", (parameters) => handleGitLog(roots, parameters)],
      ["command.run", (parameters) => handleCommandRun(roots, parameters)],
      ["project.summary", (parameters) => handleProjectSummary(roots, parameters)],
    ]);
  }

  connect() {
    this.isIntentionalClose = false;
    const logger = getLogger();
    try {
      const connectionUrl = this.secret
        ? `${this.backendUrl}${this.backendUrl.includes("?") ? "&" : "?"}secret=${encodeURIComponent(this.secret)}`
        : this.backendUrl;

      this.webSocket = new WebSocket(connectionUrl);

      this.webSocket.addEventListener("open", () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        logger.success(`Connected to ${this.backendUrl}`);
        this._register();
        this._startHeartbeat();
        this.emit("connected");
      });

      this.webSocket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
          this._handleMessage(message);
        } catch (error) {
          logger.error(`Failed to parse message: ${error.message}`);
        }
      });

      this.webSocket.addEventListener("close", (event) => {
        this.isConnected = false;
        this._stopHeartbeat();
        logger.warn(`Disconnected (code=${event.code}${event.reason ? `, reason=${event.reason}` : ""})`);
        this.emit("disconnected", { code: event.code, reason: event.reason });
        if (!this.isIntentionalClose) this._scheduleReconnect();
      });

      this.webSocket.addEventListener("error", (event) => {
        if (this.reconnectAttempts <= 1) {
          logger.error(`WebSocket error: ${event.message || "connection failed"}`);
        }
        this.emit("error", { message: event.message || "connection failed" });
      });
    } catch (error) {
      logger.error(`Failed to connect: ${error.message}`);
      this._scheduleReconnect();
    }
  }

  disconnect() {
    this.isIntentionalClose = true;
    this._stopHeartbeat();
    if (this.webSocket && this.isConnected) {
      this._send({ jsonrpc: "2.0", method: "agent.deregister", params: { agentId: this.agentId } });
      this.webSocket.close(1000, "Agent shutting down");
    }
    this.webSocket = null;
    this.isConnected = false;
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts,
      agentId: this.agentId,
      backendUrl: this.backendUrl,
      roots: this.roots,
      name: this.name,
    };
  }

  _register() {
    const logger = getLogger();
    this._send({
      jsonrpc: "2.0",
      method: "agent.register",
      params: { agentId: this.agentId, name: this.name, roots: this.roots, capabilities: ["file", "git", "command", "project"], version: "0.1.0" },
    });
    logger.info(`Registered agent "${this.name}" with ${this.roots.length} root(s)`);
  }

  async _handleMessage(message) {
    const logger = getLogger();
    if (!message.id && message.method) {
      if (message.method === "agent.registered") logger.success("Server confirmed registration");
      else if (message.method === "agent.ping") this._send({ jsonrpc: "2.0", method: "agent.pong", params: { agentId: this.agentId } });
      return;
    }
    if (message.id && message.method) {
      logger.rpc("in", message.method, message.id);
      const handler = this.methodMap.get(message.method);
      if (!handler) { this._sendResponse(message.id, null, { code: -32601, message: `Method not found: ${message.method}` }); return; }
      try {
        const result = await handler(message.params || {});
        this._sendResponse(message.id, result, undefined);
      } catch (error) {
        logger.error(`Handler error (${message.method}): ${error.message}`);
        this._sendResponse(message.id, null, { code: -32000, message: error.message });
      }
      return;
    }
    if (message.id && (message.result !== undefined || message.error)) {
      return;
    }
  }

  _send(message) {
    if (this.webSocket?.readyState === WebSocket.OPEN) {
      this.webSocket.send(JSON.stringify(message));
    }
  }

  _sendResponse(id, result, error) {
    const logger = getLogger();
    logger.rpc("out", error ? "error" : "result", id);
    const message = { jsonrpc: "2.0", id };
    if (error) message.error = error;
    else message.result = result;
    this._send(message);
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.webSocket?.readyState === WebSocket.OPEN) {
        this._send({ jsonrpc: "2.0", method: "agent.pong", params: { agentId: this.agentId } });
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  _scheduleReconnect() {
    const logger = getLogger();
    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectInterval * Math.pow(2, this.reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS);
    if (this.reconnectAttempts <= 3 || this.reconnectAttempts % 10 === 0) {
      logger.info(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})…`);
    }
    this.emit("reconnecting", { attempt: this.reconnectAttempts, delayMs: delay });
    setTimeout(() => { if (!this.isIntentionalClose) this.connect(); }, delay);
  }
}

// ────────────────────────────────────────────────────────────
// Utility exports for CLI wrapper
// ────────────────────────────────────────────────────────────

export { hostname };
export const AGENT_VERSION = "0.1.0";
