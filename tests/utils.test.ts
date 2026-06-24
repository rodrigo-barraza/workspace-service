import { describe, it, expect, vi } from "vitest";
import { translatePath, translateRoots } from "../src/utils.ts";
import { resolve, dirname } from "node:path";
import * as fs from "node:fs";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    existsSync: vi.fn(),
  };
});

const hostDevelopmentRoot = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");

describe("Path Translation Utilities", () => {
  describe("translatePath", () => {
    it("should pass through empty, null, or undefined values unchanged", () => {
      expect(translatePath(null as any)).toBeNull();
      expect(translatePath(undefined as any)).toBeUndefined();
      expect(translatePath("")).toBe("");
    });

    it("should leave relative paths like '.' completely unchanged for caller to resolve", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      expect(translatePath(".")).toBe(".");
      expect(translatePath("./src")).toBe("./src");
      expect(translatePath("src/index.ts")).toBe("src/index.ts");
    });

    it("should leave /workspace paths unchanged when /workspace exists (Docker mode)", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      expect(translatePath("/workspace")).toBe("/workspace");
      expect(translatePath("/workspace/prism-client")).toBe("/workspace/prism-client");
    });

    it("should translate /workspace to hostDevelopmentRoot when /workspace does not exist and no roots provided", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      expect(translatePath("/workspace")).toBe(hostDevelopmentRoot);
      expect(translatePath("/workspace/prism-client")).toBe(resolve(hostDevelopmentRoot, "prism-client"));
    });

    it("should translate /workspace to roots[0] when provided", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const roots = ["/home/rodrigo/development"];
      expect(translatePath("/workspace", roots)).toBe("/home/rodrigo/development");
      expect(translatePath("/workspace/prism-client/src", roots)).toBe("/home/rodrigo/development/prism-client/src");
    });

    it("should translate /workspace to a custom root like Desktop", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const roots = ["/mnt/c/Users/Rodrigo/Desktop"];
      expect(translatePath("/workspace", roots)).toBe("/mnt/c/Users/Rodrigo/Desktop");
      expect(translatePath("/workspace/file.txt", roots)).toBe("/mnt/c/Users/Rodrigo/Desktop/file.txt");
    });

    it("should not translate paths that merely start with /workspace as a prefix (e.g. /workspace-service)", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      expect(translatePath("/workspace-service")).toBe("/workspace-service");
    });

    it("should leave other absolute paths unchanged", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      expect(translatePath("/home/rodrigo/development")).toBe("/home/rodrigo/development");
      expect(translatePath("/tmp/test.txt")).toBe("/tmp/test.txt");
    });
  });

  describe("translateRoots", () => {
    it("should translate /workspace root to hostDevelopmentRoot when /workspace does not exist", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const translated = translateRoots(["/workspace"]);
      expect(translated[0]).toBe(hostDevelopmentRoot);
    });

    it("should leave non-/workspace roots unchanged", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const roots = ["/mnt/c/Users/Rodrigo/Desktop", "/other/path"];
      expect(translateRoots(roots)).toEqual(roots);
    });

    it("should leave all roots unchanged when /workspace exists (Docker mode)", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      expect(translateRoots(["/workspace", "/other"])).toEqual(["/workspace", "/other"]);
    });
  });

  describe("end-to-end: dot path resolves to workspace root", () => {
    it("'.' should resolve to roots[0] after passing through translatePath + resolve", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const workspaceRoot = "/mnt/c/Users/Rodrigo/Desktop";
      const translated = translatePath(".", [workspaceRoot]);

      expect(translated).toBe(".");

      const resolved = translated.startsWith("/")
        ? resolve(translated)
        : resolve(workspaceRoot, translated);

      expect(resolved).toBe(workspaceRoot);
    });

    it("'/workspace' should resolve to roots[0] after translatePath", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const workspaceRoot = "/mnt/c/Users/Rodrigo/Desktop";
      const translated = translatePath("/workspace", [workspaceRoot]);

      expect(translated).toBe(workspaceRoot);
    });
  });
});
