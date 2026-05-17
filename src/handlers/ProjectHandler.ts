// @ts-nocheck
// ─── Directory Tree Analysis ────────────────────────────────

import { readdir, stat } from "node:fs/promises";
import { resolve, basename } from "node:path";

const MAX_TREE_ENTRIES = 1000;
const MAX_DEPTH = 6;

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".nuxt", "__pycache__",
  "dist", "build", ".cache", ".turbo", "coverage",
  ".venv", "venv", "env",
]);

export class ProjectHandler {
  constructor(roots) {
    this.roots = roots.map((r) => resolve(r));
  }

  validatePath(inputPath) {
    if (!inputPath || typeof inputPath !== "string") {
      return { safe: false, resolved: "", error: "Path is required" };
    }
    return { safe: true, resolved: resolve(inputPath) };
  }

  async summary({ path: projectPath, maxDepth = MAX_DEPTH }) {
    const validation = this.validatePath(projectPath);
    if (!validation.safe) return { error: validation.error };

    const resolved = validation.resolved;
    const clampedDepth = Math.min(Math.max(maxDepth, 1), MAX_DEPTH);

    let entryCount = 0;

    const buildTree = async (dir, depth) => {
      if (entryCount >= MAX_TREE_ENTRIES || depth > clampedDepth) {
        return [];
      }

      try {
        const entries = await readdir(dir, { withFileTypes: true });
        const results = [];

        // Sort: directories first, then files
        const sorted = entries.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

        for (const entry of sorted) {
          if (entryCount >= MAX_TREE_ENTRIES) break;

          if (SKIP_DIRS.has(entry.name)) continue;
          if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;

          const fullPath = resolve(dir, entry.name);
          entryCount++;

          if (entry.isDirectory()) {
            const children = await buildTree(fullPath, depth + 1);
            results.push({
              name: entry.name,
              type: "directory",
              children,
            });
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
