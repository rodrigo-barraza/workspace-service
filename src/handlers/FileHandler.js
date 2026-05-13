// ─── Local File System Operations ───────────────────────────

import { readFile, writeFile, stat, readdir, mkdir, rename, unlink } from "node:fs/promises";
import { resolve, relative, extname, dirname } from "node:path";
import { existsSync } from "node:fs";
import { PathJail } from "../PathJail.js";


// ────────────────────────────────────────────────────────────
// Constants (mirrored from AgenticFileService)
// ────────────────────────────────────────────────────────────

const MAX_READ_BYTES = 1_048_576;      // 1 MB
const MAX_WRITE_BYTES = 5_242_880;     // 5 MB
const MAX_LINES_PER_READ = 800;
const MAX_GREP_RESULTS = 50;
const MAX_GLOB_RESULTS = 200;
const MAX_DIR_ENTRIES = 500;



const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg",
  ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".avi", ".mov",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".exe", ".dll", ".so", ".dylib",
  ".wasm", ".pyc", ".class",
]);

// ────────────────────────────────────────────────────────────
// Path Validation
// ────────────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

export class FileHandler {
  /**
   * @param {string[]} roots - Allowed workspace root paths
   */
  constructor(roots) {
    this.jail = new PathJail(roots);
  }

  /**
   * Validate a path against registered roots.
   * Uses PathJail for realpath-based containment (follows symlinks).
   * @param {string} inputPath
   * @returns {{ safe: boolean, resolved: string, error?: string }}
   */
  validatePath(inputPath) {
    return this.jail.contains(inputPath);
  }

  // ──────────────────────────────────────────────────────────
  // File Operations
  // ──────────────────────────────────────────────────────────

  async readFile({ path: filePath, startLine, endLine }) {
    const validation = this.validatePath(filePath);
    if (!validation.safe) return { error: validation.error };

    const resolved = validation.resolved;

    try {
      const stats = await stat(resolved);
      if (stats.isDirectory()) {
        return { error: `'${resolved}' is a directory, not a file. Use list_directory instead.` };
      }
      if (stats.size > MAX_READ_BYTES) {
        return {
          error: `File is ${(stats.size / 1024).toFixed(1)} KB — exceeds max read size of ${(MAX_READ_BYTES / 1024).toFixed(0)} KB. Use startLine/endLine to read a portion.`,
        };
      }

      const ext = extname(resolved).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) {
        return {
          filePath: resolved,
          isBinary: true,
          extension: ext,
          sizeBytes: stats.size,
          message: `Binary file detected (${ext}). Content not returned.`,
        };
      }

      const raw = await readFile(resolved, "utf-8");
      const allLines = raw.split("\n");
      const totalLines = allLines.length;

      const start = startLine ? Math.max(1, startLine) : 1;
      let end = endLine ? Math.min(totalLines, endLine) : totalLines;
      if (end - start + 1 > MAX_LINES_PER_READ) {
        end = start + MAX_LINES_PER_READ - 1;
      }

      const selectedLines = allLines.slice(start - 1, end);
      const numberedContent = selectedLines
        .map((line, i) => `${start + i}: ${line}`)
        .join("\n");

      return {
        filePath: resolved,
        totalLines,
        totalBytes: stats.size,
        startLine: start,
        endLine: Math.min(end, totalLines),
        linesReturned: selectedLines.length,
        truncated: end < totalLines,
        content: numberedContent,
      };
    } catch (err) {
      if (err.code === "ENOENT") return { error: `File not found: ${resolved}` };
      return { error: `Read failed: ${err.message}` };
    }
  }

  async writeFile({ path: filePath, content, createDirs = true }) {
    const validation = this.validatePath(filePath);
    if (!validation.safe) return { error: validation.error };

    if (typeof content !== "string") {
      return { error: "'content' must be a string" };
    }

    const bytes = Buffer.byteLength(content, "utf-8");
    if (bytes > MAX_WRITE_BYTES) {
      return {
        error: `Content is ${(bytes / 1024).toFixed(1)} KB — exceeds max write size of ${(MAX_WRITE_BYTES / 1024).toFixed(0)} KB.`,
      };
    }

    const resolved = validation.resolved;

    try {
      if (createDirs) {
        await mkdir(dirname(resolved), { recursive: true });
      }

      const existed = existsSync(resolved);
      await writeFile(resolved, content, "utf-8");
      const lines = content.split("\n").length;

      return {
        filePath: resolved,
        created: !existed,
        overwritten: existed,
        bytesWritten: bytes,
        linesWritten: lines,
      };
    } catch (err) {
      return { error: `Write failed: ${err.message}` };
    }
  }

  async strReplace({ path: filePath, oldStr, newStr, allowMultiple = false }) {
    const validation = this.validatePath(filePath);
    if (!validation.safe) return { error: validation.error };

    if (!oldStr || typeof oldStr !== "string") {
      return { error: "'oldStr' is required and must be a non-empty string" };
    }
    if (typeof newStr !== "string") {
      return { error: "'newStr' must be a string" };
    }

    const resolved = validation.resolved;

    try {
      const content = await readFile(resolved, "utf-8");

      let count = 0;
      let idx = -1;
      while ((idx = content.indexOf(oldStr, idx + 1)) !== -1) {
        count++;
      }

      if (count === 0) {
        return {
          error: "No match found for 'oldStr'. The exact string was not found in the file.",
          filePath: resolved,
          matchCount: 0,
        };
      }

      if (count > 1 && !allowMultiple) {
        return {
          error: `Found ${count} occurrences of 'oldStr' but allowMultiple is false.`,
          filePath: resolved,
          matchCount: count,
        };
      }

      let updated;
      if (allowMultiple) {
        updated = content.split(oldStr).join(newStr);
      } else {
        updated = content.replace(oldStr, newStr);
      }

      await writeFile(resolved, updated, "utf-8");

      const oldLines = oldStr.split("\n").length;
      const newLines = newStr.split("\n").length;

      return {
        filePath: resolved,
        matchCount: count,
        replacementsApplied: allowMultiple ? count : 1,
        oldLines,
        newLines,
        lineDelta: newLines - oldLines,
      };
    } catch (err) {
      if (err.code === "ENOENT") return { error: `File not found: ${resolved}` };
      return { error: `str_replace failed: ${err.message}` };
    }
  }

  async patchFile({ path: filePath, patch }) {
    const validation = this.validatePath(filePath);
    if (!validation.safe) return { error: validation.error };

    if (!patch || typeof patch !== "string") {
      return { error: "'patch' is required and must be a string (unified diff format)" };
    }

    const resolved = validation.resolved;

    try {
      const { applyPatch } = await import("diff");
      const content = await readFile(resolved, "utf-8");
      const patched = applyPatch(content, patch);

      if (patched === false) {
        return {
          error: "Patch could not be applied — the file content does not match the diff context.",
          filePath: resolved,
        };
      }

      await writeFile(resolved, patched, "utf-8");

      const oldLines = content.split("\n").length;
      const newLines = patched.split("\n").length;

      return {
        filePath: resolved,
        success: true,
        oldLines,
        newLines,
        lineDelta: newLines - oldLines,
      };
    } catch (err) {
      if (err.code === "ENOENT") return { error: `File not found: ${resolved}` };
      return { error: `patch_file failed: ${err.message}` };
    }
  }

  async fileInfo({ paths }) {
    const pathList = Array.isArray(paths) ? paths : [paths];
    if (pathList.length === 0) {
      return { error: "'paths' must be a non-empty string or array of strings" };
    }
    if (pathList.length > 20) {
      return { error: `Maximum 20 paths per batch. Received ${pathList.length}.` };
    }

    const results = await Promise.all(
      pathList.map(async (p) => {
        const validation = this.validatePath(p);
        if (!validation.safe) {
          return { path: p, exists: false, error: validation.error };
        }

        const resolved = validation.resolved;
        try {
          const stats = await stat(resolved);
          const ext = extname(resolved).toLowerCase();
          const info = {
            path: resolved,
            exists: true,
            isFile: stats.isFile(),
            isDirectory: stats.isDirectory(),
            sizeBytes: stats.size,
            lastModified: stats.mtime.toISOString(),
            extension: ext || null,
            isBinary: BINARY_EXTENSIONS.has(ext),
          };

          if (stats.isFile() && !BINARY_EXTENSIONS.has(ext) && stats.size <= MAX_READ_BYTES) {
            try {
              const content = await readFile(resolved, "utf-8");
              info.lines = content.split("\n").length;
            } catch { /* skip */ }
          }

          return info;
        } catch (err) {
          if (err.code === "ENOENT") return { path: resolved, exists: false };
          return { path: resolved, exists: false, error: err.message };
        }
      }),
    );

    if (pathList.length === 1) return results[0];
    return { totalRequested: pathList.length, results };
  }

  async fileDiff({ pathA, pathB, content, contextLines = 3 }) {
    if (!pathA) return { error: "'pathA' is required" };
    if (!pathB && content === undefined) return { error: "Either 'pathB' or 'content' must be provided" };

    const validA = this.validatePath(pathA);
    if (!validA.safe) return { error: validA.error };

    try {
      const contentA = await readFile(validA.resolved, "utf-8");
      let contentB;
      let labelB;

      if (pathB) {
        const validB = this.validatePath(pathB);
        if (!validB.safe) return { error: validB.error };
        contentB = await readFile(validB.resolved, "utf-8");
        labelB = validB.resolved;
      } else {
        contentB = content;
        labelB = "(provided content)";
      }

      const { createTwoFilesPatch } = await import("diff");
      const diff = createTwoFilesPatch(
        validA.resolved, labelB, contentA, contentB, "", "",
        { context: Math.min(contextLines, 10) },
      );

      const hasChanges = diff.includes("@@");
      const additions = (diff.match(/^\+[^+]/gm) || []).length;
      const deletions = (diff.match(/^-[^-]/gm) || []).length;

      return {
        pathA: validA.resolved,
        pathB: labelB,
        hasChanges,
        additions,
        deletions,
        diff: hasChanges ? diff : "(files are identical)",
      };
    } catch (err) {
      if (err.code === "ENOENT") return { error: `File not found: ${err.path || pathA}` };
      return { error: `file_diff failed: ${err.message}` };
    }
  }

  async moveFile({ source, destination, createDirs = true }) {
    const validSrc = this.validatePath(source);
    if (!validSrc.safe) return { error: validSrc.error };
    const validDst = this.validatePath(destination);
    if (!validDst.safe) return { error: validDst.error };

    try {
      if (!existsSync(validSrc.resolved)) {
        return { error: `Source not found: ${validSrc.resolved}` };
      }
      if (existsSync(validDst.resolved)) {
        return { error: `Destination already exists: ${validDst.resolved}.` };
      }

      if (createDirs) {
        await mkdir(dirname(validDst.resolved), { recursive: true });
      }

      await rename(validSrc.resolved, validDst.resolved);

      return {
        source: validSrc.resolved,
        destination: validDst.resolved,
        success: true,
      };
    } catch (err) {
      return { error: `move_file failed: ${err.message}` };
    }
  }

  async deleteFile({ path: filePath }) {
    const validation = this.validatePath(filePath);
    if (!validation.safe) return { error: validation.error };

    try {
      const stats = await stat(validation.resolved);
      if (stats.isDirectory()) {
        return { error: `'${validation.resolved}' is a directory. Only files can be deleted.` };
      }

      const sizeBytes = stats.size;
      await unlink(validation.resolved);

      return { filePath: validation.resolved, deleted: true, sizeBytes };
    } catch (err) {
      if (err.code === "ENOENT") return { error: `File not found: ${validation.resolved}` };
      return { error: `delete_file failed: ${err.message}` };
    }
  }

  async multiFileRead({ files }) {
    if (!Array.isArray(files) || files.length === 0) {
      return { error: "'files' must be a non-empty array of { path, startLine?, endLine? }" };
    }
    if (files.length > 20) {
      return { error: `Maximum 20 files per batch read. Received ${files.length}.` };
    }

    const results = await Promise.all(
      files.map(async (f) => {
        const result = await this.readFile({
          path: f.path,
          startLine: f.startLine,
          endLine: f.endLine,
        });
        return { path: f.path, ...result };
      }),
    );

    const succeeded = results.filter((r) => !r.error).length;
    const failed = results.filter((r) => r.error).length;

    return { totalRequested: files.length, succeeded, failed, results };
  }

  // ──────────────────────────────────────────────────────────
  // Directory Operations
  // ──────────────────────────────────────────────────────────

  async listDirectory({ path: dirPath, recursive = false, maxDepth = 3 }) {
    const validation = this.validatePath(dirPath);
    if (!validation.safe) return { error: validation.error };

    const resolved = validation.resolved;

    try {
      const stats = await stat(resolved);
      if (!stats.isDirectory()) {
        return { error: `'${resolved}' is a file, not a directory. Use read_file instead.` };
      }

      const entries = [];

      const walk = async (dir, depth) => {
        if (entries.length >= MAX_DIR_ENTRIES) return;
        if (depth > maxDepth) return;

        const dirEntries = await readdir(dir, { withFileTypes: true });

        for (const entry of dirEntries) {
          if (entries.length >= MAX_DIR_ENTRIES) break;

          const fullPath = resolve(dir, entry.name);
          const relPath = relative(resolved, fullPath);

          const pathValidation = this.validatePath(fullPath);
          if (!pathValidation.safe) continue;

          if (entry.isDirectory()) {
            entries.push({ name: entry.name, path: relPath, isDir: true });
            if (recursive && depth < maxDepth) {
              await walk(fullPath, depth + 1);
            }
          } else {
            try {
              const fileStat = await stat(fullPath);
              entries.push({ name: entry.name, path: relPath, isDir: false, sizeBytes: fileStat.size });
            } catch {
              entries.push({ name: entry.name, path: relPath, isDir: false });
            }
          }
        }
      };

      await walk(resolved, 1);

      return {
        directory: resolved,
        totalEntries: entries.length,
        truncated: entries.length >= MAX_DIR_ENTRIES,
        entries,
      };
    } catch (err) {
      if (err.code === "ENOENT") return { error: `Directory not found: ${resolved}` };
      return { error: `list_directory failed: ${err.message}` };
    }
  }

  // ──────────────────────────────────────────────────────────
  // Search Operations
  // ──────────────────────────────────────────────────────────

  async grepSearch({ pattern, searchPath, isRegex = false, includes = [], caseInsensitive = false, matchPerLine = true }) {
    const validation = this.validatePath(searchPath);
    if (!validation.safe) return { error: validation.error };

    if (!pattern || typeof pattern !== "string") {
      return { error: "'pattern' is required and must be a non-empty string" };
    }

    const resolved = validation.resolved;

    try {
      let regex;
      try {
        regex = isRegex
          ? new RegExp(pattern, caseInsensitive ? "gi" : "g")
          : new RegExp(escapeRegex(pattern), caseInsensitive ? "gi" : "g");
      } catch (err) {
        return { error: `Invalid regex pattern: ${err.message}` };
      }

      const results = [];
      const fileMatches = new Set();

      const searchFile = async (filePath) => {
        if (results.length >= MAX_GREP_RESULTS) return;
        const ext = extname(filePath).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) return;

        const pathCheck = this.validatePath(filePath);
        if (!pathCheck.safe) return;

        try {
          const fileStat = await stat(filePath);
          if (fileStat.size > MAX_READ_BYTES) return;

          const content = await readFile(filePath, "utf-8");
          const lines = content.split("\n");

          for (let i = 0; i < lines.length; i++) {
            if (results.length >= MAX_GREP_RESULTS) break;
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              fileMatches.add(filePath);
              if (matchPerLine) {
                results.push({
                  file: filePath,
                  line: i + 1,
                  content: lines[i].length > 500 ? lines[i].slice(0, 500) + "..." : lines[i],
                });
              }
            }
          }
        } catch { /* skip unreadable */ }
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
                const name = entry.name;
                const matched = includes.some((glob) => {
                  if (glob.startsWith("*.")) return name.endsWith(glob.slice(1));
                  return name === glob;
                });
                if (!matched) continue;
              }
              await searchFile(fullPath);
            }
          }
        } catch { /* skip unreadable */ }
      };

      const stats_ = await stat(resolved);
      if (stats_.isFile()) {
        await searchFile(resolved);
      } else {
        await walkDir(resolved);
      }

      if (!matchPerLine) {
        return {
          pattern,
          searchPath: resolved,
          matchingFiles: [...fileMatches],
          totalFiles: fileMatches.size,
          truncated: fileMatches.size >= MAX_GREP_RESULTS,
        };
      }

      return {
        pattern,
        searchPath: resolved,
        totalMatches: results.length,
        truncated: results.length >= MAX_GREP_RESULTS,
        results,
      };
    } catch (err) {
      return { error: `grep_search failed: ${err.message}` };
    }
  }

  async globFiles({ pattern, searchPath }) {
    const validation = this.validatePath(searchPath);
    if (!validation.safe) return { error: validation.error };

    if (!pattern || typeof pattern !== "string") {
      return { error: "'pattern' is required and must be a non-empty string" };
    }

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
              const pathCheck = this.validatePath(fullPath);
              if (!pathCheck.safe) continue;
              try {
                const fileStat = await stat(fullPath);
                matches.push({
                  path: fullPath,
                  relativePath: relPath,
                  name: entry.name,
                  sizeBytes: fileStat.size,
                });
              } catch {
                matches.push({ path: fullPath, relativePath: relPath, name: entry.name });
              }
            }
          }
        }
      } catch { /* skip */ }
    };

    try {
      await walk(resolved);
      return {
        pattern,
        searchPath: resolved,
        totalMatches: matches.length,
        truncated: matches.length >= MAX_GLOB_RESULTS,
        matches,
      };
    } catch (err) {
      return { error: `glob_files failed: ${err.message}` };
    }
  }
}
