// ─── Directory Tree Analysis ────────────────────────────────

import { readdir, stat } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { translatePath } from "../utils.ts";
import type { Dirent } from "node:fs";
import type { ProjectSummaryParams, PathValidation, TreeEntry } from "../types.ts";

const MAX_TREE_ENTRIES = 1000;
const MAX_DEPTH = 6;

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".nuxt", "__pycache__",
  "dist", "build", ".cache", ".turbo", "coverage",
  ".venv", "venv", "env",
]);

export class ProjectHandler {
  roots: string[];
  constructor(roots: string[]) {
    this.roots = roots.map((r: string) => resolve(r));
  }

  validatePath(inputPath: string): PathValidation {
    if (!inputPath || typeof inputPath !== "string") {
      return { safe: false, resolved: "", error: "Path is required" };
    }
    const translated = translatePath(inputPath, this.roots);
    const resolved = translated.startsWith("/")
      ? resolve(translated)
      : resolve(this.roots[0], translated);
    return { safe: true, resolved };
  }

  async summary({ path: projectPath, maxDepth = MAX_DEPTH }: ProjectSummaryParams) {
    const validation = this.validatePath(projectPath);
    if (!validation.safe) return { error: validation.error };

    const resolved = validation.resolved;
    const clampedDepth = Math.min(Math.max(maxDepth, 1), MAX_DEPTH);

    let entryCount = 0;

    const buildTree = async (dir: string, depth: number): Promise<TreeEntry[]> => {
      if (entryCount >= MAX_TREE_ENTRIES || depth > clampedDepth) {
        return [];
      }

      try {
        const entries = await readdir(dir, { withFileTypes: true });
        const results: TreeEntry[] = [];

        // Sort: directories first, then files
        const sorted = entries.sort((a: Dirent, b: Dirent) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

        // Phase 1: collect all entries at this level (dirs as placeholders, files fully)
        // This guarantees sibling files aren't starved by deep recursive traversal.
        const directoriesToRecurse: Array<{ index: number; fullPath: string }> = [];

        for (const entry of sorted) {
          if (entryCount >= MAX_TREE_ENTRIES) break;

          if (SKIP_DIRS.has(entry.name)) continue;
          if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;

          const fullPath = resolve(dir, entry.name);
          entryCount++;

          if (entry.isDirectory()) {
            const resultIndex = results.length;
            results.push({
              name: entry.name,
              type: "directory",
              children: [],
            });
            if (depth < clampedDepth) {
              directoriesToRecurse.push({ index: resultIndex, fullPath });
            }
          } else {
            try {
              const fileStat = await stat(fullPath);
              results.push({
                name: entry.name,
                type: "file",
                sizeBytes: fileStat.size,
              });
            } catch {
              results.push({
                name: entry.name,
                type: "file",
              });
            }
          }
        }

        // Phase 2: recurse into directories after all siblings are collected
        for (const { index, fullPath } of directoriesToRecurse) {
          if (entryCount >= MAX_TREE_ENTRIES) break;
          results[index].children = await buildTree(fullPath, depth + 1);
        }

        return results;
      } catch {
        return [];
      }
    };

    const tree = await buildTree(resolved, 1);

    return {
      projectPath: resolved,
      projectName: basename(resolved),
      totalEntries: entryCount,
      truncated: entryCount >= MAX_TREE_ENTRIES,
      maxDepth: clampedDepth,
      tree,
    };
  }
}
