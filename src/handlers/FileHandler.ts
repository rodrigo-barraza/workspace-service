// ─── Local File System Operations ───────────────────────────

import { readFile, writeFile, stat, readdir, mkdir, rename, unlink, rm } from "node:fs/promises";
import { resolve, relative, extname, dirname } from "node:path";
import { existsSync } from "node:fs";
import { escapeRegex, errorMessage } from "@rodrigo-barraza/utilities-library";
import { validateWorkspacePath } from "../utils.ts";
import type {
  ReadFileParams, WriteFileParams, StringReplaceParameters, PatchFileParams,
  FileInfoParams, FileDiffParams, MoveFileParams, DeleteFileParams,
  BlockReplaceParams, MultiReplaceParams,
  MultiFileReadParams, ListDirectoryParams, CreateDirectoryParams,
  GrepSearchParams, GlobFilesParams,
  FileInfoEntry, DirectoryEntry, GrepMatch, GlobMatch, TreeEntry,
} from "../types.ts";


import {
  WORKSPACE_MAX_READ_BYTES,
  WORKSPACE_MAX_WRITE_BYTES,
  WORKSPACE_MAX_LINES_PER_READ,
  WORKSPACE_MAX_GREP_RESULTS,
  WORKSPACE_MAX_GLOB_RESULTS,
  WORKSPACE_MAX_DIRECTORY_ENTRIES,
  WORKSPACE_MAX_PREVIEW_BYTES,
  BINARY_FILE_EXTENSIONS,
  PREVIEW_IMAGE_FILE_EXTENSIONS,
  globToRegex,
  WORKSPACE_SKIP_DIRECTORIES,
} from "@rodrigo-barraza/utilities-library";

// Cap for directoryTree — its siblings (listDirectory, project.summary) have
// caps; without one, a wide directory at shallow depth yields an unbounded blob
const MAX_TREE_ENTRIES = 1000;

/**
 * Atomic write: write to a temp file in the same directory, then rename over
 * the target. A crash mid-write (container restart, SIGKILL) can no longer
 * leave a truncated file behind.
 */
async function writeFileAtomic(targetPath: string, content: string): Promise<void> {
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, content, "utf-8");
  try {
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
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
  validatePath(inputPath: string) {
    return validateWorkspacePath(inputPath, this.roots);
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
      if (stats.size > WORKSPACE_MAX_READ_BYTES) {
        return {
          error: `File is ${(stats.size / 1024).toFixed(1)} KB — exceeds max read size of ${(WORKSPACE_MAX_READ_BYTES / 1024).toFixed(0)} KB. Use startLine/endLine to read a portion.`,
        };
      }

      const fileExtension = extname(resolved).toLowerCase();

      // Binary file handling — return base64 for raw mode or previewable images
      if (BINARY_FILE_EXTENSIONS.has(fileExtension)) {
        const includeBase64 = rawMode || (PREVIEW_IMAGE_FILE_EXTENSIONS.has(fileExtension) && stats.size <= WORKSPACE_MAX_PREVIEW_BYTES);

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
      if (end - start + 1 > WORKSPACE_MAX_LINES_PER_READ) {
        end = start + WORKSPACE_MAX_LINES_PER_READ - 1;
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

  async writeFile({ path: filePath, content, contentBase64, createDirs = true }: WriteFileParams) {
    const validation = this.validatePath(filePath);
    if (!validation.safe) return { error: validation.error };

    // Binary write path (additive): the VS Code FileSystemProvider coerces
    // every write through UTF-8 without this, corrupting non-text files.
    const isBinaryWrite = typeof contentBase64 === "string";
    if (!isBinaryWrite && typeof content !== "string") {
      return { error: "'content' must be a string (or provide 'contentBase64' for binary data)" };
    }

    const buffer = isBinaryWrite ? Buffer.from(contentBase64, "base64") : Buffer.from(content!, "utf-8");
    if (buffer.length > WORKSPACE_MAX_WRITE_BYTES) {
      return {
        error: `Content is ${(buffer.length / 1024).toFixed(1)} KB — exceeds max write size of ${(WORKSPACE_MAX_WRITE_BYTES / 1024).toFixed(0)} KB.`,
      };
    }

    const resolved = validation.resolved;

    try {
      if (createDirs) {
        await mkdir(dirname(resolved), { recursive: true });
      }

      const existed = existsSync(resolved);
      // Atomic: temp + rename, so a crash mid-write can't truncate the file
      const temporaryPath = `${resolved}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporaryPath, buffer);
      try {
        await rename(temporaryPath, resolved);
      } catch (renameError) {
        await unlink(temporaryPath).catch(() => {});
        throw renameError;
      }

      return {
        filePath: resolved,
        created: !existed,
        overwritten: existed,
        bytesWritten: buffer.length,
        ...(isBinaryWrite ? { isBinary: true } : { linesWritten: content!.split("\n").length }),
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

      // Advance by the full match length: `index + 1` counted overlapping
      // occurrences ("aaa" contains "aa" twice) while split/join replaces
      // non-overlapping ones — the counts must agree or single-match edits
      // get spuriously rejected as ambiguous.
      let count = 0;
      let index = content.indexOf(oldString);
      while (index !== -1) {
        count++;
        index = content.indexOf(oldString, index + oldString.length);
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

      await writeFileAtomic(resolved, updated);

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

      await writeFileAtomic(resolved, patched);

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
            isBinary: BINARY_FILE_EXTENSIONS.has(fileExtension),
          };

          if (stats.isFile() && !BINARY_FILE_EXTENSIONS.has(fileExtension) && stats.size <= WORKSPACE_MAX_READ_BYTES) {
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

  async deleteFile({ path: filePath, recursive = false }: DeleteFileParams) {
    const validation = this.validatePath(filePath);
    if (!validation.safe) return { error: validation.error };

    try {
      const stats = await stat(validation.resolved);
      const sizeBytes = stats.isDirectory() ? 0 : stats.size;

      if (stats.isDirectory()) {
        if (!recursive) {
          return {
            error: `'${validation.resolved}' is a directory. Only files can be deleted with this tool, unless the 'recursive' parameter is set to true.`,
          };
        }
        await rm(validation.resolved, { recursive: true, force: true });
      } else {
        await unlink(validation.resolved);
      }

      return {
        filePath: validation.resolved,
        deleted: true,
        isDirectory: stats.isDirectory(),
        sizeBytes,
      };
    } catch (error: unknown) {
      const errorObject = error as NodeJS.ErrnoException;
      if (errorObject.code === "ENOENT") return { error: `File or directory not found: ${validation.resolved}` };
      return { error: `delete_file failed: ${errorObject.message}` };
    }
  }

  // ──────────────────────────────────────────────────────────
  // Surgical Block & Multi-Block Editing
  // ──────────────────────────────────────────────────────────

  /**
   * Replace a bounded block of lines (startLine..endLine, 1-based inclusive)
   * after verifying the current content in that range exactly matches
   * targetContent. Mirrors the local AgenticFileService.agenticBlockReplace.
   */
  async blockReplace({ path: filePath, startLine, endLine, targetContent, replacementContent }: BlockReplaceParams) {
    const validation = this.validatePath(filePath);
    if (!validation.safe) return { error: validation.error };

    if (typeof startLine !== "number" || startLine <= 0) {
      return { error: "'startLine' must be a positive integer" };
    }
    if (typeof endLine !== "number" || endLine < startLine) {
      return { error: "'endLine' must be an integer greater than or equal to startLine" };
    }
    if (typeof targetContent !== "string") {
      return { error: "'targetContent' must be a string" };
    }
    if (typeof replacementContent !== "string") {
      return { error: "'replacementContent' must be a string" };
    }

    const resolved = validation.resolved;

    try {
      const raw = await readFile(resolved, "utf-8");
      const lines = raw.split("\n");
      const totalLines = lines.length;

      if (startLine > totalLines || endLine > totalLines) {
        return {
          error: `Line range [${startLine}, ${endLine}] exceeds total file lines (${totalLines})`,
          filePath: resolved,
        };
      }

      const segment = lines.slice(startLine - 1, endLine).join("\n");

      // Precise match (including whitespace)
      if (segment !== targetContent) {
        const numberedActual = lines
          .slice(startLine - 1, endLine)
          .map((line: string, i: number) => `${startLine + i}: ${line}`)
          .join("\n");
        return {
          error: `Content in line range [${startLine}, ${endLine}] does not match targetContent.`,
          filePath: resolved,
          actualContentInRange: numberedActual,
        };
      }

      const before = lines.slice(0, startLine - 1);
      const after = lines.slice(endLine);
      const newSegmentLines = replacementContent.split("\n");
      const updatedContent = [...before, ...newSegmentLines, ...after].join("\n");

      await writeFileAtomic(resolved, updatedContent);

      const oldLinesCount = endLine - startLine + 1;
      const newLinesCount = newSegmentLines.length;

      return {
        filePath: resolved,
        success: true,
        oldLines: oldLinesCount,
        newLines: newLinesCount,
        lineDelta: newLinesCount - oldLinesCount,
      };
    } catch (error: unknown) {
      const errorObject = error as NodeJS.ErrnoException;
      if (errorObject.code === "ENOENT") return { error: `File not found: ${resolved}` };
      return { error: `block_replace failed: ${errorObject.message}` };
    }
  }

  /**
   * Apply multiple non-contiguous block replacements atomically. Every chunk's
   * targetContent is verified against the current file first; only if all pass
   * is a single atomic write performed. Replacements are applied bottom-up
   * (descending startLine) so earlier line offsets don't shift later chunks.
   * Mirrors the local AgenticFileService.agenticMultiReplace.
   */
  async multiReplace({ path: filePath, chunks }: MultiReplaceParams) {
    const validation = this.validatePath(filePath);
    if (!validation.safe) return { error: validation.error };

    if (!Array.isArray(chunks) || chunks.length === 0) {
      return { error: "'chunks' must be a non-empty array of replacement chunks" };
    }
    if (chunks.length > 30) {
      return { error: `Maximum 30 chunks per batch. Received ${chunks.length}.` };
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (typeof chunk.startLine !== "number" || chunk.startLine <= 0) {
        return { error: `Chunk ${i}: 'startLine' must be a positive integer` };
      }
      if (typeof chunk.endLine !== "number" || chunk.endLine < chunk.startLine) {
        return { error: `Chunk ${i}: 'endLine' must be an integer greater than or equal to startLine` };
      }
      if (typeof chunk.targetContent !== "string") {
        return { error: `Chunk ${i}: 'targetContent' must be a string` };
      }
      if (typeof chunk.replacementContent !== "string") {
        return { error: `Chunk ${i}: 'replacementContent' must be a string` };
      }
    }

    const resolved = validation.resolved;

    try {
      const raw = await readFile(resolved, "utf-8");
      let lines = raw.split("\n");

      // Reject overlapping/touching chunks up front (no changes applied).
      const sortedAsc = [...chunks].sort((a, b) => a.startLine - b.startLine);
      for (let i = 0; i < sortedAsc.length - 1; i++) {
        if (sortedAsc[i].endLine >= sortedAsc[i + 1].startLine) {
          return {
            error: `No changes were applied to the file. Chunks overlap or touch: [${sortedAsc[i].startLine}, ${sortedAsc[i].endLine}] overlaps/touches [${sortedAsc[i + 1].startLine}, ${sortedAsc[i + 1].endLine}]`,
            filePath: resolved,
          };
        }
      }

      // Verify every chunk against the ORIGINAL content before applying any.
      // Line numbers in each chunk refer to the file as it currently is, so
      // verification uses the original `lines`; application happens bottom-up.
      for (const chunk of chunks) {
        if (chunk.startLine > lines.length || chunk.endLine > lines.length) {
          return {
            error: `No changes were applied to the file. Chunk range [${chunk.startLine}, ${chunk.endLine}] exceeds total file lines (${lines.length}).`,
            filePath: resolved,
          };
        }
        const segment = lines.slice(chunk.startLine - 1, chunk.endLine).join("\n");
        if (segment !== chunk.targetContent) {
          const numberedActual = lines
            .slice(chunk.startLine - 1, chunk.endLine)
            .map((line: string, i: number) => `${chunk.startLine + i}: ${line}`)
            .join("\n");
          return {
            error: `No changes were applied to the file. Chunk in range [${chunk.startLine}, ${chunk.endLine}] does not match targetContent.`,
            filePath: resolved,
            actualContentInRange: numberedActual,
          };
        }
      }

      // All chunks verified — apply bottom-up so earlier offsets don't shift.
      const sortedDesc = [...chunks].sort((a, b) => b.startLine - a.startLine);
      const chunkResults: Array<{ startLine: number; endLine: number; oldLines: number; newLines: number; lineDelta: number }> = [];
      let overallLineDelta = 0;

      for (const chunk of sortedDesc) {
        const before = lines.slice(0, chunk.startLine - 1);
        const after = lines.slice(chunk.endLine);
        const newSegmentLines = chunk.replacementContent.split("\n");
        lines = [...before, ...newSegmentLines, ...after];

        const oldLinesCount = chunk.endLine - chunk.startLine + 1;
        const newLinesCount = newSegmentLines.length;
        const delta = newLinesCount - oldLinesCount;
        overallLineDelta += delta;

        chunkResults.push({
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          oldLines: oldLinesCount,
          newLines: newLinesCount,
          lineDelta: delta,
        });
      }

      // Single atomic write — all-or-nothing.
      await writeFileAtomic(resolved, lines.join("\n"));

      return {
        filePath: resolved,
        success: true,
        chunksProcessed: chunkResults.length,
        overallLineDelta,
        details: chunkResults.reverse(),
      };
    } catch (error: unknown) {
      const errorObject = error as NodeJS.ErrnoException;
      if (errorObject.code === "ENOENT") return { error: `File not found: ${resolved}` };
      return { error: `multi_replace failed: ${errorObject.message}` };
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
        if (entries.length >= WORKSPACE_MAX_DIRECTORY_ENTRIES) return;
        if (depth > maxDepth) return;

        const dirEntries = await readdir(dir, { withFileTypes: true });

        for (const entry of dirEntries) {
          if (entries.length >= WORKSPACE_MAX_DIRECTORY_ENTRIES) break;

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
        truncated: entries.length >= WORKSPACE_MAX_DIRECTORY_ENTRIES,
        entries,
      };
    } catch (error: unknown) {
      const errorObject = error as NodeJS.ErrnoException;
      if (errorObject.code === "ENOENT") return { error: `Directory not found: ${resolved}` };
      return { error: `list_directory failed: ${errorObject.message}` };
    }
  }

  /**
   * Build a nested directory tree structure.
   * Used by the SystemPromptAssembler to embed project structure in the system prompt.
   */
  async directoryTree({ path: dirPath, maxDepth = 2 }: { path: string; maxDepth?: number }) {
    const validation = this.validatePath(dirPath);
    if (!validation.safe) return { error: validation.error };

    const resolved = validation.resolved;

    try {
      const directoryStats = await stat(resolved);
      if (!directoryStats.isDirectory()) {
        return { error: `'${resolved}' is a file, not a directory.` };
      }

      let totalEntries = 0;
      let truncated = false;

      const buildTree = async (currentDirectory: string, currentDepth: number): Promise<TreeEntry[]> => {
        if (currentDepth > maxDepth) return [];

        const directoryEntries = await readdir(currentDirectory, { withFileTypes: true });
        const treeEntries: TreeEntry[] = [];

        for (const directoryEntry of directoryEntries) {
          if (totalEntries >= MAX_TREE_ENTRIES) {
            truncated = true;
            break;
          }
          if (WORKSPACE_SKIP_DIRECTORIES.has(directoryEntry.name)) continue;
          if (directoryEntry.name.startsWith(".") && directoryEntry.name !== ".env.example") continue;

          const fullPath = resolve(currentDirectory, directoryEntry.name);

          const pathValidation = this.validatePath(fullPath);
          if (!pathValidation.safe) continue;

          totalEntries++;
          if (directoryEntry.isDirectory()) {
            const children = currentDepth < maxDepth
              ? await buildTree(fullPath, currentDepth + 1)
              : [];
            treeEntries.push({ name: directoryEntry.name, type: "directory", children });
          } else {
            treeEntries.push({ name: directoryEntry.name, type: "file" });
          }
        }

        return treeEntries;
      };

      const entries = await buildTree(resolved, 1);
      return { entries, totalEntries, truncated };
    } catch (error: unknown) {
      return { error: `Directory tree fetch failed: ${errorMessage(error)}` };
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

      // Real glob semantics for `includes` — the old suffix-only check made
      // patterns like "src/**/*.ts" silently match nothing, which an LLM
      // reads as "no results found" rather than "bad filter".
      const includeMatchers = includes.map((glob: string) => {
        const regex = globToRegex(glob);
        return (name: string, relativePath: string) => regex.test(name) || regex.test(relativePath);
      });

      const searchFile = async (filePath: string) => {
        if (results.length >= WORKSPACE_MAX_GREP_RESULTS) return;
        const fileExtension = extname(filePath).toLowerCase();
        if (BINARY_FILE_EXTENSIONS.has(fileExtension)) return;

        const pathCheck = this.validatePath(filePath);
        if (!pathCheck.safe) return;

        try {
          const fileStat = await stat(filePath);
          if (fileStat.size > WORKSPACE_MAX_READ_BYTES) return;

          const content = await readFile(filePath, "utf-8");
          const lines = content.split("\n");

          for (let i = 0; i < lines.length; i++) {
            if (results.length >= WORKSPACE_MAX_GREP_RESULTS) break;
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
        if (results.length >= WORKSPACE_MAX_GREP_RESULTS) return;
        try {
          const entries = await readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (results.length >= WORKSPACE_MAX_GREP_RESULTS) break;
            const fullPath = resolve(dir, entry.name);

            if (entry.isDirectory()) {
              if (entry.name === "node_modules" || entry.name === ".git") continue;
              await walkDir(fullPath);
            } else {
              if (includeMatchers.length > 0) {
                const relativePath = relative(resolved, fullPath);
                const matched = includeMatchers.some((matches) => matches(entry.name, relativePath));
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
          truncated: fileMatches.size >= WORKSPACE_MAX_GREP_RESULTS,
        };
      }

      return {
        pattern,
        searchPath: resolved,
        totalMatches: results.length,
        truncated: results.length >= WORKSPACE_MAX_GREP_RESULTS,
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
      if (matches.length >= WORKSPACE_MAX_GLOB_RESULTS) return;
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (matches.length >= WORKSPACE_MAX_GLOB_RESULTS) break;
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
        truncated: matches.length >= WORKSPACE_MAX_GLOB_RESULTS,
        matches,
      };
    } catch (error: unknown) {
      return { error: `glob_files failed: ${errorMessage(error)}` };
    }
  }
}
