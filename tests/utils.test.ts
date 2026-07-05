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

describe("Path Virtualization (LLM sees '/' → actual '/workspace')", () => {
  // These functions use module-level constants, not fs.existsSync,
  // so they operate independently of the mock.

  describe("devirtualizePath", () => {
    it("should convert virtual root paths to actual filesystem paths", async () => {
      const { devirtualizePath } = await import("../src/utils.ts");

      // Only runs meaningful translation when WORKSPACE_VIRTUAL_ROOT !== WORKSPACE_ACTUAL_ROOT
      // In test environment, WORKSPACE_VIRTUAL_ROOT defaults to "/"
      // and WORKSPACE_ACTUAL_ROOT defaults to "/workspace"
      expect(devirtualizePath("/src/foo.ts")).toBe("/workspace/src/foo.ts");
      expect(devirtualizePath("/")).toBe("/workspace");
      expect(devirtualizePath("/package.json")).toBe("/workspace/package.json");
    });

    it("should pass through paths that already use the actual root", async () => {
      const { devirtualizePath } = await import("../src/utils.ts");

      expect(devirtualizePath("/workspace/src/foo.ts")).toBe("/workspace/src/foo.ts");
      expect(devirtualizePath("/workspace")).toBe("/workspace");
    });

    it("should pass through relative paths unchanged", async () => {
      const { devirtualizePath } = await import("../src/utils.ts");

      expect(devirtualizePath(".")).toBe(".");
      expect(devirtualizePath("./src")).toBe("./src");
      expect(devirtualizePath("src/foo.ts")).toBe("src/foo.ts");
    });

    it("should pass through empty or falsy values", async () => {
      const { devirtualizePath } = await import("../src/utils.ts");

      expect(devirtualizePath("")).toBe("");
    });
  });

  describe("virtualizePath", () => {
    it("should convert actual filesystem paths to virtual root paths", async () => {
      const { virtualizePath } = await import("../src/utils.ts");

      expect(virtualizePath("/workspace/src/foo.ts")).toBe("/src/foo.ts");
      expect(virtualizePath("/workspace")).toBe("/");
      expect(virtualizePath("/workspace/package.json")).toBe("/package.json");
    });

    it("should pass through paths outside the actual root", async () => {
      const { virtualizePath } = await import("../src/utils.ts");

      expect(virtualizePath("/etc/hosts")).toBe("/etc/hosts");
      expect(virtualizePath("/tmp/test.txt")).toBe("/tmp/test.txt");
    });

    it("should pass through empty or falsy values", async () => {
      const { virtualizePath } = await import("../src/utils.ts");

      expect(virtualizePath("")).toBe("");
    });
  });

  describe("virtualizeResponsePaths (recursive)", () => {
    it("should recursively virtualize paths in nested objects", async () => {
      const { virtualizeResponsePaths } = await import("../src/utils.ts");

      const response = {
        filePath: "/workspace/src/index.ts",
        totalLines: 42,
        content: "console.log('hello');",
        nested: {
          absolutePath: "/workspace/tests/foo.test.ts",
          flag: true,
        },
      };

      const virtualized = virtualizeResponsePaths(response) as Record<string, unknown>;
      expect(virtualized.filePath).toBe("/src/index.ts");
      expect(virtualized.totalLines).toBe(42);
      expect((virtualized.nested as Record<string, unknown>).absolutePath).toBe("/tests/foo.test.ts");
    });

    it("should recursively virtualize paths in arrays", async () => {
      const { virtualizeResponsePaths } = await import("../src/utils.ts");

      const response = {
        files: ["/workspace/a.ts", "/workspace/b.ts"],
        count: 2,
      };

      const virtualized = virtualizeResponsePaths(response) as Record<string, unknown>;
      expect(virtualized.files).toEqual(["/a.ts", "/b.ts"]);
    });

    it("should not modify strings that are not path-like (e.g. error messages)", async () => {
      const { virtualizeResponsePaths } = await import("../src/utils.ts");

      const response = {
        error: "File not found: /workspace/missing.ts",
        code: "ENOENT",
      };

      const virtualized = virtualizeResponsePaths(response) as Record<string, unknown>;
      // Error message strings are NOT paths — they pass through unchanged.
      // Only string values that ARE full paths get virtualized.
      expect(virtualized.error).toBe("File not found: /workspace/missing.ts");
      expect(virtualized.code).toBe("ENOENT");
    });
  });

  describe("devirtualizeRequestParams (recursive)", () => {
    it("should recursively devirtualize paths in request params", async () => {
      const { devirtualizeRequestParams } = await import("../src/utils.ts");

      const params = {
        path: "/src/index.ts",
        startLine: 1,
        endLine: 50,
      };

      const devirtualized = devirtualizeRequestParams(params) as Record<string, unknown>;
      expect(devirtualized.path).toBe("/workspace/src/index.ts");
      expect(devirtualized.startLine).toBe(1);
    });

    it("should handle command.run params with cwd", async () => {
      const { devirtualizeRequestParams } = await import("../src/utils.ts");

      const params = {
        command: "git status",
        cwd: "/prism-service",
      };

      const devirtualized = devirtualizeRequestParams(params) as Record<string, unknown>;
      expect(devirtualized.command).toBe("git status");
      expect(devirtualized.cwd).toBe("/workspace/prism-service");
    });
  });
});
