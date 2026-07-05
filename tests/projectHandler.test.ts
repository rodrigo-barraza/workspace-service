import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ProjectHandler } from "../src/handlers/ProjectHandler.ts";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { TreeEntry } from "../src/types.ts";

// ══════════════════════════════════════════════════════════════
// ProjectHandler — Regression Tests
// ══════════════════════════════════════════════════════════════

const FIXTURE_ROOT = resolve(import.meta.dirname!, ".fixtures-project-handler");

/**
 * Recursively collect all entry names at a specific depth in the tree.
 */
function collectNamesAtDepth(
  entries: TreeEntry[],
  targetDepth: number,
  currentDepth = 0,
): string[] {
  const names: string[] = [];
  for (const entry of entries) {
    if (currentDepth === targetDepth) {
      names.push(entry.name);
    }
    if (entry.type === "directory" && entry.children && currentDepth < targetDepth) {
      names.push(...collectNamesAtDepth(entry.children, targetDepth, currentDepth + 1));
    }
  }
  return names;
}

/**
 * Flatten the entire tree into a list of { name, type } entries.
 */
function flattenTree(entries: TreeEntry[]): Array<{ name: string; type: string }> {
  const result: Array<{ name: string; type: string }> = [];
  for (const entry of entries) {
    result.push({ name: entry.name, type: entry.type });
    if (entry.type === "directory" && entry.children) {
      result.push(...flattenTree(entry.children));
    }
  }
  return result;
}

describe("ProjectHandler", () => {
  const handler = new ProjectHandler([FIXTURE_ROOT]);

  beforeAll(() => {
    rmSync(FIXTURE_ROOT, { recursive: true, force: true });
    mkdirSync(FIXTURE_ROOT, { recursive: true });
  });

  afterAll(() => {
    rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  });

  // ────────────────────────────────────────────────────────────
  // Regression: root-level files must not be starved by deep
  // directory recursion when entryCount approaches MAX_TREE_ENTRIES.
  //
  // Previously, directories were sorted first and recursed inline,
  // so the shared entryCount budget was exhausted deep inside
  // subdirectories before root-level files were ever processed.
  // ────────────────────────────────────────────────────────────

  describe("root-level file starvation regression", () => {
    const STARVATION_ROOT = resolve(FIXTURE_ROOT, "starvation-scenario");

    beforeAll(() => {
      mkdirSync(STARVATION_ROOT, { recursive: true });

      // Create root-level files (these MUST appear in the output)
      writeFileSync(resolve(STARVATION_ROOT, "package.json"), "{}");
      writeFileSync(resolve(STARVATION_ROOT, "README.md"), "# Hello");
      writeFileSync(resolve(STARVATION_ROOT, "tsconfig.json"), "{}");
      writeFileSync(resolve(STARVATION_ROOT, "index.ts"), "export {}");

      // Create many directories, each with many files, to exhaust the entry budget.
      // 20 directories × 60 files each = 1200 nested entries + 20 dirs + 4 root files = 1224 total
      // This exceeds MAX_TREE_ENTRIES (1000), so without deferred recursion the
      // root-level files would be starved.
      for (let directoryIndex = 0; directoryIndex < 20; directoryIndex++) {
        const directoryName = `module-${String(directoryIndex).padStart(3, "0")}`;
        const directoryPath = resolve(STARVATION_ROOT, directoryName);
        mkdirSync(directoryPath, { recursive: true });

        for (let fileIndex = 0; fileIndex < 60; fileIndex++) {
          writeFileSync(
            resolve(directoryPath, `file-${String(fileIndex).padStart(3, "0")}.ts`),
            `// generated fixture ${directoryIndex}-${fileIndex}`,
          );
        }
      }
    });

    it("should include root-level files even when total entries exceed MAX_TREE_ENTRIES", async () => {
      const result = await handler.summary({ path: STARVATION_ROOT });

      expect(result).not.toHaveProperty("error");
      expect(result).toHaveProperty("tree");
      expect(result.truncated).toBe(true);

      const rootNames = (result.tree as TreeEntry[]).map((entry: TreeEntry) => entry.name);

      // Root-level files MUST be present — this is the core regression assertion
      expect(rootNames).toContain("package.json");
      expect(rootNames).toContain("README.md");
      expect(rootNames).toContain("tsconfig.json");
      expect(rootNames).toContain("index.ts");
    });

    it("should include root-level directories alongside root-level files", async () => {
      const result = await handler.summary({ path: STARVATION_ROOT });

      const rootEntries = result.tree as TreeEntry[];
      const rootDirectories = rootEntries.filter((entry: TreeEntry) => entry.type === "directory");
      const rootFiles = rootEntries.filter((entry: TreeEntry) => entry.type === "file");

      // All 20 directories should be present at root level
      expect(rootDirectories.length).toBe(20);

      // All 4 root files should be present
      expect(rootFiles.length).toBe(4);
    });

    it("should sort directories before files at every tree level", async () => {
      const result = await handler.summary({ path: STARVATION_ROOT });
      const rootEntries = result.tree as TreeEntry[];

      // Find the transition point where directories end and files begin
      let sawFile = false;
      for (const entry of rootEntries) {
        if (entry.type === "file") sawFile = true;
        if (entry.type === "directory" && sawFile) {
          throw new Error(
            `Directory "${entry.name}" appeared after file entries — sort order violated`,
          );
        }
      }
    });
  });

  // ────────────────────────────────────────────────────────────
  // Basic tree building correctness
  // ────────────────────────────────────────────────────────────

  describe("basic tree correctness", () => {
    const BASIC_ROOT = resolve(FIXTURE_ROOT, "basic-tree");

    beforeAll(() => {
      mkdirSync(BASIC_ROOT, { recursive: true });

      writeFileSync(resolve(BASIC_ROOT, "app.ts"), "export {}");
      writeFileSync(resolve(BASIC_ROOT, "config.json"), "{}");

      mkdirSync(resolve(BASIC_ROOT, "src"), { recursive: true });
      writeFileSync(resolve(BASIC_ROOT, "src", "main.ts"), "console.log()");
      writeFileSync(resolve(BASIC_ROOT, "src", "utils.ts"), "export {}");

      mkdirSync(resolve(BASIC_ROOT, "src", "components"), { recursive: true });
      writeFileSync(resolve(BASIC_ROOT, "src", "components", "Button.tsx"), "<button/>");
    });

    it("should return a nested tree with correct structure", async () => {
      const result = await handler.summary({ path: BASIC_ROOT, maxDepth: 6 });

      expect(result).not.toHaveProperty("error");
      expect(result.truncated).toBe(false);

      const rootNames = (result.tree as TreeEntry[]).map((entry: TreeEntry) => entry.name);
      expect(rootNames).toContain("src");
      expect(rootNames).toContain("app.ts");
      expect(rootNames).toContain("config.json");
    });

    it("should recurse into subdirectories", async () => {
      const result = await handler.summary({ path: BASIC_ROOT, maxDepth: 6 });
      const allEntries = flattenTree(result.tree as TreeEntry[]);

      const allNames = allEntries.map((entry) => entry.name);
      expect(allNames).toContain("main.ts");
      expect(allNames).toContain("utils.ts");
      expect(allNames).toContain("components");
      expect(allNames).toContain("Button.tsx");
    });

    it("should respect maxDepth and stop recursion at the limit", async () => {
      const result = await handler.summary({ path: BASIC_ROOT, maxDepth: 1 });

      const rootEntries = result.tree as TreeEntry[];
      const srcDirectory = rootEntries.find((entry: TreeEntry) => entry.name === "src");

      expect(srcDirectory).toBeDefined();
      // At maxDepth=1, root is depth 1, so children of root dirs should NOT be populated
      expect(srcDirectory!.children).toEqual([]);
    });
  });

  // ────────────────────────────────────────────────────────────
  // Filtering: SKIP_DIRS and dotfiles
  // ────────────────────────────────────────────────────────────

  describe("directory and dotfile filtering", () => {
    const FILTER_ROOT = resolve(FIXTURE_ROOT, "filter-test");

    beforeAll(() => {
      mkdirSync(FILTER_ROOT, { recursive: true });

      // Directories that should be skipped
      mkdirSync(resolve(FILTER_ROOT, "node_modules"), { recursive: true });
      writeFileSync(resolve(FILTER_ROOT, "node_modules", "leftpad.js"), "module.exports = {}");

      mkdirSync(resolve(FILTER_ROOT, ".git"), { recursive: true });
      writeFileSync(resolve(FILTER_ROOT, ".git", "HEAD"), "ref: refs/heads/main");

      mkdirSync(resolve(FILTER_ROOT, "dist"), { recursive: true });
      writeFileSync(resolve(FILTER_ROOT, "dist", "bundle.js"), "()=>{}");

      // Dotfiles that should be skipped
      writeFileSync(resolve(FILTER_ROOT, ".eslintrc"), "{}");
      writeFileSync(resolve(FILTER_ROOT, ".prettierrc"), "{}");

      // Exception: .env.example should NOT be skipped
      writeFileSync(resolve(FILTER_ROOT, ".env.example"), "API_KEY=xxx");

      // Normal entries that should be included
      writeFileSync(resolve(FILTER_ROOT, "index.ts"), "export {}");
      mkdirSync(resolve(FILTER_ROOT, "src"), { recursive: true });
    });

    it("should exclude SKIP_DIRS (node_modules, .git, dist)", async () => {
      const result = await handler.summary({ path: FILTER_ROOT, maxDepth: 6 });
      const allEntries = flattenTree(result.tree as TreeEntry[]);
      const allNames = allEntries.map((entry) => entry.name);

      expect(allNames).not.toContain("node_modules");
      expect(allNames).not.toContain(".git");
      expect(allNames).not.toContain("dist");
      expect(allNames).not.toContain("leftpad.js");
      expect(allNames).not.toContain("HEAD");
      expect(allNames).not.toContain("bundle.js");
    });

    it("should exclude dotfiles except .env.example", async () => {
      const result = await handler.summary({ path: FILTER_ROOT, maxDepth: 6 });
      const rootNames = (result.tree as TreeEntry[]).map((entry: TreeEntry) => entry.name);

      expect(rootNames).not.toContain(".eslintrc");
      expect(rootNames).not.toContain(".prettierrc");
      expect(rootNames).toContain(".env.example");
    });

    it("should include normal files and directories", async () => {
      const result = await handler.summary({ path: FILTER_ROOT, maxDepth: 6 });
      const rootNames = (result.tree as TreeEntry[]).map((entry: TreeEntry) => entry.name);

      expect(rootNames).toContain("index.ts");
      expect(rootNames).toContain("src");
    });
  });
});
