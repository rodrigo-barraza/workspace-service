// ─── Local File System Operations ───────────────────────────

import { readFile, writeFile, stat, readdir, mkdir, rename, unlink } from "node:fs/promises";
import { resolve, relative, extname, dirname } from "node:path";
import { existsSync } from "node:fs";
import { escapeRegex, errorMessage } from "@rodrigo-barraza/utilities-library";
import { translatePath } from "../utils.ts";
import type {
  ReadFileParams, WriteFileParams, StringReplaceParameters, PatchFileParams,
  FileInfoParams, FileDiffParams, MoveFileParams, DeleteFileParams,
  MultiFileReadParams, ListDirectoryParams, CreateDirectoryParams,
  GrepSearchParams, GlobFilesParams,
  PathValidation, FileInfoEntry, DirectoryEntry, GrepMatch, GlobMatch,
} from "../types.ts";


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
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico",
  ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".avi", ".mov",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".exe", ".dll", ".so", ".dylib",
  ".wasm", ".pyc", ".class",
]);

// Image extensions eligible for inline base64 preview (avoids /file/raw round-trip)
const PREVIEW_IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif", ".tiff", ".tif",
]);
const MAX_PREVIEW_BYTES = 2_097_152; // 2 MB

// ────────────────────────────────────────────────────────────
// Path Validation
// ────────────────────────────────────────────────────────────


function globToRegex(glob: string) {
  const regex = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<<GLOBSTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<GLOBSTAR>>>/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`(^|/)${regex}$`, "i");
}

export class FileHandler {
  roots: string[];
  constructor(roots: string[]) {
    this.roots = roots.map((rootPath: string) => resolve(rootPath));
  }

  /**
   * Validate and resolve a path.
   * No containment check — the Docker container is the jail.
   */
  validatePath(inputPath: string): PathValidation {
    if (!inputPath || typeof inputPath !== "string") {
      return { safe: false, resolved: "", error: "Path is required (string)" };
    }
    const translated = translatePath(inputPath, this.roots);
    const resolved = translated.startsWith("/")
      ? resolve(translated)
      : resolve(this.roots[0], translated);
    return { safe: true, resolved };
  }

  // ──────────────────────────────────────────────────────────
  // File Operations
  // ──────────────────────────────────────────────────────────

  async readFile({ path: filePath, startLine, endLine, raw: rawMode = false }: ReadFileParams) {
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

      const fileExtension = extname(resolved).toLowerCase();

      // Binary file handling — return base64 for raw mode or previewable images
      if (BINARY_EXTENSIONS.has(fileExtension)) {
        const includeBase64 = rawMode || (PREVIEW_IMAGE_EXTENSIONS.has(fileExtension) && stats.size <= MAX_PREVIEW_BYTES);

        if (includeBase64) {
          const buffer = await readFile(resolved);
          return {
            filePath: resolved,
            isBinary: true,
            extension: fileExtension,
            sizeBytes: stats.size,
            contentBase64: buffer.toString("base64"),
          };
        }
        return {
          filePath: resolved,
          isBinary: true,
          extension: fileExtension,
          sizeBytes: stats.size,
          message: `Binary file detected (${fileExtension}). Content not returned.`,
        };
      }

      const rawContent = await readFile(resolved, "utf-8");

      // Raw mode: return plain content without line numbers (for VS Code FileSystemProvider)
      if (rawMode) {
        return {
          filePath: resolved,
          totalLines: rawContent.split("\n").length,
          totalBytes: stats.size,
          content: rawContent,
          lastModified: stats.mtime.toISOString(),
        };
      }

      // Standard mode: line-numbered content with range support
      const allLines = rawContent.split("\n");
      const totalLines = allLines.length;

      const start = startLine ? Math.max(1, startLine) : 1;
      let end = endLine ? Math.min(totalLines, endLine) : totalLines;
      if (end - start + 1 > MAX_LINES_PER_READ) {
        end = start + MAX_LINES_PER_READ - 1;
      }

      const selectedLines = allLines.slice(start - 1, end);
      const numberedContent = selectedLines
        .map((line: string, lineIndex: number) => `${start + lineIndex}: ${line}`)
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
    } catch (error: unknown) {
      const errorObject = error as NodeJS.ErrnoException;
      if (errorObject.code === "ENOENT") return { error: `File not found: ${resolved}` };
      return { error: `Read failed: ${errorObject.message}` };
    }
  }

  async writeFile({ path: filePath, content, createDirs = true }: WriteFileParams) {
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
    } catch (error: unknown) {
      return { error: `Write failed: ${errorMessage(error)}` };
    }
  }

  async stringReplace({ path: filePath, oldString, newString, allowMultiple = false }: StringReplaceParameters) {
    const validation = this.validatePath(filePath);
    if (!validation.safe) return { error: validation.error };

    if (!oldString || typeof oldString !== "string") {
      return { error: "'oldString' is required and must be a non-empty string" };
    }
    if (typeof newString !== "string") {
      return { error: "'newString' must be a string" };
    }

    const resolved = validation.resolved;

    try {
      const content = await readFile(resolved, "utf-8");

      let count = 0;
      let index = -1;
      while ((index = content.indexOf(oldString, index + 1)) !== -1) {
        count++;
      }

      if (count === 0) {
        return {
          error: "No match found for 'oldString'. The exact string was not found in the file.",
          filePath: resolved,
          matchCount: 0,
        };
      }

      if (count > 1 && !allowMultiple) {
        return {
          error: `Found ${count} occurrences of 'oldString' but allowMultiple is false.`,
          filePath: resolved,
          matchCount: count,
        };
      }

      let updated: string;
      if (allowMultiple) {
        updated = content.split(oldString).join(newString);
      } else {
        updated = content.replace(oldString, newString);
      }

      await writeFile(resolved, updated, "utf-8");

      const oldLines = oldString.split("\n").length;
      const newLines = newString.split("\n").length;

      return {
        filePath: resolved,
        matchCount: count,
        replacementsApplied: allowMultiple ? count : 1,
        oldLines,
        newLines,
        lineDelta: newLines - oldLines,
      };
    } catch (error: unknown) {
      const errorObject = error as NodeJS.ErrnoException;
      if (errorObject.code === "ENOENT") return { error: `File not found: ${resolved}` };
      return { error: `stringReplace failed: ${errorObject.message}` };
    }
  }

  async patchFile({ path: filePath, patch }: PatchFileParams) {
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
    } catch (error: unknown) {
      const errorObject = error as NodeJS.ErrnoException;
      if (errorObject.code === "ENOENT") return { error: `File not found: ${resolved}` };
      return { error: `patch_file failed: ${errorObject.message}` };
    }
  }

  async fileInfo({ paths }: FileInfoParams) {
    const pathList = Array.isArray(paths) ? paths : [paths];
    if (pathList.length === 0) {
      return { error: "'paths' must be a non-empty string or array of strings" };
    }
    if (pathList.length > 20) {
      return { error: `Maximum 20 paths per batch. Received ${pathList.length}.` };
    }

    const results = await Promise.all(
      pathList.map(async (pathString: string): Promise<FileInfoEntry> => {
        const validation = this.validatePath(pathString);
        if (!validation.safe) {
          return { path: pathString, exists: false, error: validation.error };
        }

        const resolved = validation.resolved;
        try {
          const stats = await stat(resolved);
          const fileExtension = extname(resolved).toLowerCase();
          const info: FileInfoEntry = {
            path: resolved,
            exists: true,
            isFile: stats.isFile(),
            isDirectory: stats.isDirectory(),
            sizeBytes: stats.size,
            lastModified: stats.mtime.toISOString(),
            extension: fileExtension || null,
            isBinary: BINARY_EXTENSIONS.has(fileExtension),
          };

          if (stats.isFile() && !BINARY_EXTENSIONS.has(fileExtension) && stats.size <= MAX_READ_BYTES) {
            try {
              const content = await readFile(resolved, "utf-8");
              info.lines = content.split("\n").length;
            } catch { /* skip */ }
          }

          return info;
        } catch (error: unknown) {
          const errorObject = error as NodeJS.ErrnoException;
          if (errorObject.code === "ENOENT") return { path: resolved, exists: false };
          return { path: resolved, exists: false, error: errorObject.message };
        }
      }),
    );

    if (pathList.length === 1) return results[0];
    return { totalRequested: pathList.length, results };
  }

  async fileDiff({ pathA, pathB, content, contextLines = 3 }: FileDiffParams) {
    if (!pathA) return { error: "'pathA' is required" };
    if (!pathB && content === undefined) return { error: "Either 'pathB' or 'content' must be provided" };

    const validA = this.validatePath(pathA);
    if (!validA.safe) return { error: validA.error };

    try {
      const contentA = await readFile(validA.resolved, "utf-8");
      let contentB: string;
      let labelB: string;

      if (pathB) {
        const validB = this.validatePath(pathB);
        if (!validB.safe) return { error: validB.error };
        contentB = await readFile(validB.resolved, "utf-8");
        labelB = validB.resolved;
      } else {
        contentB = content!;
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
    } catch (error: unknown) {
      const errorObject = error as NodeJS.ErrnoException;
      if (errorObject.code === "ENOENT") return { error: `File not found: ${errorObject.path || pathA}` };
      return { error: `file_diff failed: ${errorObject.message}` };
    }
  }

  async moveFile({ source, destination, createDirs = true }: MoveFileParams) {
    const validSource = this.validatePath(source);
    if (!validSource.safe) return { error: validSource.error };
    const validDestination = this.validatePath(destination);
    if (!validDestination.safe) return { error: validDestination.error };

    try {
      if (!existsSync(validSource.resolved)) {
        return { error: `Source not found: ${validSource.resolved}` };
      }
      if (existsSync(validDestination.resolved)) {
        return { error: `Destination already exists: ${validDestination.resolved}.` };
      }

      if (createDirs) {
        await mkdir(dirname(validDestination.resolved), { recursive: true });
      }

      await rename(validSource.resolved, validDestination.resolved);

      return {
        source: validSource.resolved,
        destination: validDestination.resolved,
        success: true,
      };
    } catch (error: unknown) {
      return { error: `move_file failed: ${errorMessage(error)}` };
    }
  }

  async deleteFile({ path: filePath }: DeleteFileParams) {
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
    } catch (error: unknown) {
      const errorObject = error as NodeJS.ErrnoException;
      if (errorObject.code === "ENOENT") return { error: `File not found: ${validation.resolved}` };
      return { error: `delete_file failed: ${errorObject.message}` };
    }
  }

  async multiFileRead({ files }: MultiFileReadParams) {
    if (!Array.isArray(files) || files.length === 0) {
      return { error: "'files' must be a non-empty array of { path, startLine?, endLine? }" };
    }
    if (files.length > 20) {
      return { error: `Maximum 20 files per batch read. Received ${files.length}.` };
    }

    const results = await Promise.all(
      files.map(async (fileItem: { path: string; startLine?: number; endLine?: number }) => {
        const result = await this.readFile({
          path: fileItem.path,
          startLine: fileItem.startLine,
          endLine: fileItem.endLine,
        });
        return { path: fileItem.path, ...result };
      }),
    );

    const succeeded = results.filter((result) => !("error" in result && result.error)).length;
    const failed = results.filter((result) => "error" in result && result.error).length;

    return { totalRequested: files.length, succeeded, failed, results };
  }

  // ──────────────────────────────────────────────────────────
  // Directory Operations
  // ──────────────────────────────────────────────────────────

  async createDirectory({ path: dirPath }: CreateDirectoryParams) {
    const validation = this.validatePath(dirPath);
    if (!validation.safe) return { error: validation.error };

    const resolved = validation.resolved;

    try {
      if (existsSync(resolved)) {
        const stats = await stat(resolved);
        if (stats.isDirectory()) {
          return { path: resolved, created: false, message: "Directory already exists" };
        }
        return { error: `'${resolved}' exists and is not a directory` };
      }

      await mkdir(resolved, { recursive: true });
      return { path: resolved, created: true };
    } catch (error: unknown) {
      return { error: `create_directory failed: ${errorMessage(error)}` };
    }
  }

  async listDirectory({ path: dirPath, recursive = false, maxDepth = 3 }: ListDirectoryParams) {
    const validation = this.validatePath(dirPath);
    if (!validation.safe) return { error: validation.error };

    const resolved = validation.resolved;

    try {
      const stats = await stat(resolved);
      if (!stats.isDirectory()) {
        return { error: `'${resolved}' is a file, not a directory. Use read_file instead.` };
      }

      const entries: DirectoryEntry[] = [];

      const walk = async (dir: string, depth: number) => {
        if (entries.length >= MAX_DIR_ENTRIES) return;
        if (depth > maxDepth) return;

        const dirEntries = await readdir(dir, { withFileTypes: true });

        for (const entry of dirEntries) {
          if (entries.length >= MAX_DIR_ENTRIES) break;

          const fullPath = resolve(dir, entry.name);
          const relativePath = relative(resolved, fullPath);

          const pathValidation = this.validatePath(fullPath);
          if (!pathValidation.safe) continue;

          if (entry.isDirectory()) {
            entries.push({ name: entry.name, path: relativePath, isDir: true });
            if (recursive && depth < maxDepth) {
              await walk(fullPath, depth + 1);
            }
          } else {
            try {
              const fileStat = await stat(fullPath);
              entries.push({ name: entry.name, path: relativePath, isDir: false, sizeBytes: fileStat.size });
            } catch {
              entries.push({ name: entry.name, path: relativePath, isDir: false });
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
    } catch (error: unknown) {
      const errorObject = error as NodeJS.ErrnoException;
      if (errorObject.code === "ENOENT") return { error: `Directory not found: ${resolved}` };
      return { error: `list_directory failed: ${errorObject.message}` };
    }
  }

  // ──────────────────────────────────────────────────────────
  // Search Operations
  // ──────────────────────────────────────────────────────────

  async grepSearch({ pattern, searchPath, isRegex = false, includes = [], caseInsensitive = false, matchPerLine = true }: GrepSearchParams) {
    const validation = this.validatePath(searchPath);
    if (!validation.safe) return { error: validation.error };

    if (!pattern || typeof pattern !== "string") {
      return { error: "'pattern' is required and must be a non-empty string" };
    }

    const resolved = validation.resolved;

    try {
      let regex: RegExp;
      try {
        regex = isRegex
          ? new RegExp(pattern, caseInsensitive ? "gi" : "g")
          : new RegExp(escapeRegex(pattern), caseInsensitive ? "gi" : "g");
      } catch (error: unknown) {
        return { error: `Invalid regex pattern: ${errorMessage(error)}` };
      }

      const results: GrepMatch[] = [];
      const fileMatches = new Set<string>();

      const searchFile = async (filePath: string) => {
        if (results.length >= MAX_GREP_RESULTS) return;
        const fileExtension = extname(filePath).toLowerCase();
        if (BINARY_EXTENSIONS.has(fileExtension)) return;

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

      const walkDir = async (dir: string) => {
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
                const matched = includes.some((glob: string) => {
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
    } catch (error: unknown) {
      return { error: `grep_search failed: ${errorMessage(error)}` };
    }
  }

  async globFiles({ pattern, searchPath }: GlobFilesParams) {
    const validation = this.validatePath(searchPath);
    if (!validation.safe) return { error: validation.error };

    if (!pattern || typeof pattern !== "string") {
      return { error: "'pattern' is required and must be a non-empty string" };
    }

    const resolved = validation.resolved;
    const matches: GlobMatch[] = [];
    const globRegex = globToRegex(pattern);

    const walk = async (dir: string) => {
      if (matches.length >= MAX_GLOB_RESULTS) return;
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (matches.length >= MAX_GLOB_RESULTS) break;
          const fullPath = resolve(dir, entry.name);
          const relativePath = relative(resolved, fullPath);

          if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name === ".git") continue;
            await walk(fullPath);
          } else {
            if (globRegex.test(relativePath) || globRegex.test(entry.name)) {
              const pathCheck = this.validatePath(fullPath);
              if (!pathCheck.safe) continue;
              try {
                const fileStat = await stat(fullPath);
                matches.push({
                  path: fullPath,
                  relativePath,
                  name: entry.name,
                  sizeBytes: fileStat.size,
                });
              } catch {
                matches.push({ path: fullPath, relativePath, name: entry.name });
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
    } catch (error: unknown) {
      return { error: `glob_files failed: ${errorMessage(error)}` };
    }
  }
}
