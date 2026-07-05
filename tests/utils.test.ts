import { describe, it, expect, vi, beforeEach } from "vitest";
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

// ══════════════════════════════════════════════════════════════
// Legacy Path Translation (development mode outside Docker)
// ══════════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════════
// Path Virtualization (LLM sees "/" → actual "/workspace")
// ══════════════════════════════════════════════════════════════
//
// In the test environment, the env vars are not set, so defaults apply:
//   WORKSPACE_VIRTUAL_ROOT = "/"  (default)
//   WORKSPACE_ACTUAL_ROOT  = "/workspace"  (default)
//   isVirtualized          = true
//
// These tests exercise devirtualizePath, virtualizePath, and the
// field-name-aware recursive translators.

describe("Path Virtualization (LLM sees '/' → actual '/workspace')", () => {

  // ────────────────────────────────────────────────────────────
  // devirtualizePath — incoming: LLM path → filesystem path
  // ────────────────────────────────────────────────────────────

  describe("devirtualizePath", () => {
    it("should convert virtual root paths to actual filesystem paths", async () => {
      const { devirtualizePath } = await import("../src/utils.ts");

      expect(devirtualizePath("/src/foo.ts")).toBe("/workspace/src/foo.ts");
      expect(devirtualizePath("/")).toBe("/workspace");
      expect(devirtualizePath("/package.json")).toBe("/workspace/package.json");
    });

    it("should handle deeply nested virtual paths", async () => {
      const { devirtualizePath } = await import("../src/utils.ts");

      expect(devirtualizePath("/src/components/Header/Header.tsx")).toBe("/workspace/src/components/Header/Header.tsx");
      expect(devirtualizePath("/node_modules/.pnpm/vite@6.0.0/node_modules/vite/dist/index.js"))
        .toBe("/workspace/node_modules/.pnpm/vite@6.0.0/node_modules/vite/dist/index.js");
    });

    it("should pass through paths that already use the actual root", async () => {
      const { devirtualizePath } = await import("../src/utils.ts");

      expect(devirtualizePath("/workspace/src/foo.ts")).toBe("/workspace/src/foo.ts");
      expect(devirtualizePath("/workspace")).toBe("/workspace");
      expect(devirtualizePath("/workspace/")).toBe("/workspace/");
    });

    it("should pass through relative paths unchanged", async () => {
      const { devirtualizePath } = await import("../src/utils.ts");

      expect(devirtualizePath(".")).toBe(".");
      expect(devirtualizePath("./src")).toBe("./src");
      expect(devirtualizePath("src/foo.ts")).toBe("src/foo.ts");
      expect(devirtualizePath("../other-project")).toBe("../other-project");
    });

    it("should pass through empty or falsy values", async () => {
      const { devirtualizePath } = await import("../src/utils.ts");

      expect(devirtualizePath("")).toBe("");
    });
  });

  // ────────────────────────────────────────────────────────────
  // virtualizePath — outgoing: filesystem path → LLM path
  // ────────────────────────────────────────────────────────────

  describe("virtualizePath", () => {
    it("should convert actual filesystem paths to virtual root paths", async () => {
      const { virtualizePath } = await import("../src/utils.ts");

      expect(virtualizePath("/workspace/src/foo.ts")).toBe("/src/foo.ts");
      expect(virtualizePath("/workspace")).toBe("/");
      expect(virtualizePath("/workspace/package.json")).toBe("/package.json");
    });

    it("should handle deeply nested actual paths", async () => {
      const { virtualizePath } = await import("../src/utils.ts");

      expect(virtualizePath("/workspace/src/components/Header/Header.tsx")).toBe("/src/components/Header/Header.tsx");
    });

    it("should pass through paths outside the actual root", async () => {
      const { virtualizePath } = await import("../src/utils.ts");

      expect(virtualizePath("/etc/hosts")).toBe("/etc/hosts");
      expect(virtualizePath("/tmp/test.txt")).toBe("/tmp/test.txt");
      expect(virtualizePath("/usr/local/bin/node")).toBe("/usr/local/bin/node");
    });

    it("should not match paths that merely share the prefix (e.g. /workspace-service)", async () => {
      const { virtualizePath } = await import("../src/utils.ts");

      expect(virtualizePath("/workspace-service")).toBe("/workspace-service");
      expect(virtualizePath("/workspacex/foo")).toBe("/workspacex/foo");
    });

    it("should pass through empty or falsy values", async () => {
      const { virtualizePath } = await import("../src/utils.ts");

      expect(virtualizePath("")).toBe("");
    });
  });

  // ────────────────────────────────────────────────────────────
  // devirtualizeRequestParams — field-name-aware recursive translator
  // ────────────────────────────────────────────────────────────

  describe("devirtualizeRequestParams (field-name-aware)", () => {
    it("should devirtualize known path fields in file.read params", async () => {
      const { devirtualizeRequestParams } = await import("../src/utils.ts");

      const params = { path: "/src/index.ts", startLine: 1, endLine: 50 };
      const result = devirtualizeRequestParams(params) as Record<string, unknown>;

      expect(result.path).toBe("/workspace/src/index.ts");
      expect(result.startLine).toBe(1);
      expect(result.endLine).toBe(50);
    });

    it("should devirtualize cwd in command.run params without corrupting the command string", async () => {
      const { devirtualizeRequestParams } = await import("../src/utils.ts");

      const params = {
        command: "git clone https://github.com/example/repo.git",
        cwd: "/prism-service",
        timeout: 30000,
      };
      const result = devirtualizeRequestParams(params) as Record<string, unknown>;

      expect(result.command).toBe("git clone https://github.com/example/repo.git");
      expect(result.cwd).toBe("/workspace/prism-service");
      expect(result.timeout).toBe(30000);
    });

    it("should NOT devirtualize command strings that start with /", async () => {
      const { devirtualizeRequestParams } = await import("../src/utils.ts");

      const params = {
        command: "/usr/bin/python3 -c 'print(1)'",
        cwd: "/",
      };
      const result = devirtualizeRequestParams(params) as Record<string, unknown>;

      // command must NOT be corrupted — it's not a path field
      expect(result.command).toBe("/usr/bin/python3 -c 'print(1)'");
      expect(result.cwd).toBe("/workspace");
    });

    it("should NOT devirtualize file content strings", async () => {
      const { devirtualizeRequestParams } = await import("../src/utils.ts");

      const params = {
        path: "/src/config.ts",
        content: "export const API_URL = '/api/v1';\n// Root path: /",
      };
      const result = devirtualizeRequestParams(params) as Record<string, unknown>;

      expect(result.path).toBe("/workspace/src/config.ts");
      // Content must NOT be modified
      expect(result.content).toBe("export const API_URL = '/api/v1';\n// Root path: /");
    });

    it("should NOT devirtualize oldString/newString in string replace params", async () => {
      const { devirtualizeRequestParams } = await import("../src/utils.ts");

      const params = {
        path: "/src/app.ts",
        oldString: "/old/import/path",
        newString: "/new/import/path",
        allowMultiple: false,
      };
      const result = devirtualizeRequestParams(params) as Record<string, unknown>;

      expect(result.path).toBe("/workspace/src/app.ts");
      expect(result.oldString).toBe("/old/import/path");
      expect(result.newString).toBe("/new/import/path");
    });

    it("should NOT devirtualize grep patterns", async () => {
      const { devirtualizeRequestParams } = await import("../src/utils.ts");

      const params = {
        pattern: "/api/users",
        searchPath: "/src",
        isRegex: false,
      };
      const result = devirtualizeRequestParams(params) as Record<string, unknown>;

      expect(result.pattern).toBe("/api/users");
      expect(result.searchPath).toBe("/workspace/src");
    });

    it("should devirtualize both source and destination in file.move params", async () => {
      const { devirtualizeRequestParams } = await import("../src/utils.ts");

      const params = {
        source: "/src/old.ts",
        destination: "/src/new.ts",
        createDirs: true,
      };
      const result = devirtualizeRequestParams(params) as Record<string, unknown>;

      expect(result.source).toBe("/workspace/src/old.ts");
      expect(result.destination).toBe("/workspace/src/new.ts");
    });

    it("should devirtualize pathA and pathB in file.diff params", async () => {
      const { devirtualizeRequestParams } = await import("../src/utils.ts");

      const params = {
        pathA: "/src/v1.ts",
        pathB: "/src/v2.ts",
        contextLines: 3,
      };
      const result = devirtualizeRequestParams(params) as Record<string, unknown>;

      expect(result.pathA).toBe("/workspace/src/v1.ts");
      expect(result.pathB).toBe("/workspace/src/v2.ts");
    });

    it("should devirtualize nested 'path' inside arrays (e.g. file.readMulti)", async () => {
      const { devirtualizeRequestParams } = await import("../src/utils.ts");

      const params = {
        files: [
          { path: "/src/a.ts", startLine: 1 },
          { path: "/src/b.ts", endLine: 100 },
        ],
      };
      const result = devirtualizeRequestParams(params) as Record<string, unknown>;
      const files = result.files as Array<Record<string, unknown>>;

      expect(files[0].path).toBe("/workspace/src/a.ts");
      expect(files[0].startLine).toBe(1);
      expect(files[1].path).toBe("/workspace/src/b.ts");
    });

    it("should devirtualize git operation paths", async () => {
      const { devirtualizeRequestParams } = await import("../src/utils.ts");

      // git.status
      const statusParams = { path: "/prism-service" };
      expect((devirtualizeRequestParams(statusParams) as Record<string, unknown>).path).toBe("/workspace/prism-service");

      // git.diff with filePath
      const diffParams = { path: "/prism-service", filePath: "/prism-service/src/index.ts", staged: true };
      const diffResult = devirtualizeRequestParams(diffParams) as Record<string, unknown>;
      expect(diffResult.path).toBe("/workspace/prism-service");
      expect(diffResult.filePath).toBe("/workspace/prism-service/src/index.ts");
      expect(diffResult.staged).toBe(true);
    });

    it("should handle the virtual root '/' as a path value", async () => {
      const { devirtualizeRequestParams } = await import("../src/utils.ts");

      const params = { path: "/" };
      const result = devirtualizeRequestParams(params) as Record<string, unknown>;
      expect(result.path).toBe("/workspace");
    });

    it("should leave relative paths in path fields unchanged", async () => {
      const { devirtualizeRequestParams } = await import("../src/utils.ts");

      const params = { path: ".", cwd: "./subdir" };
      const result = devirtualizeRequestParams(params) as Record<string, unknown>;
      expect(result.path).toBe(".");
      expect(result.cwd).toBe("./subdir");
    });

    it("should pass through paths already pointing to actual root", async () => {
      const { devirtualizeRequestParams } = await import("../src/utils.ts");

      const params = { path: "/workspace/src/index.ts" };
      const result = devirtualizeRequestParams(params) as Record<string, unknown>;
      expect(result.path).toBe("/workspace/src/index.ts");
    });

    it("should NOT devirtualize unknown/arbitrary field names", async () => {
      const { devirtualizeRequestParams } = await import("../src/utils.ts");

      const params = {
        path: "/src/foo.ts",
        label: "/some/label",
        description: "/this/is/not/a/path",
        tag: "/v1.0.0",
      };
      const result = devirtualizeRequestParams(params) as Record<string, unknown>;

      expect(result.path).toBe("/workspace/src/foo.ts");
      expect(result.label).toBe("/some/label");
      expect(result.description).toBe("/this/is/not/a/path");
      expect(result.tag).toBe("/v1.0.0");
    });

    it("should handle null, undefined, and boolean values without errors", async () => {
      const { devirtualizeRequestParams } = await import("../src/utils.ts");

      const params = {
        path: "/src/foo.ts",
        recursive: true,
        maxDepth: null,
        extra: undefined,
      };
      const result = devirtualizeRequestParams(params) as Record<string, unknown>;

      expect(result.path).toBe("/workspace/src/foo.ts");
      expect(result.recursive).toBe(true);
      expect(result.maxDepth).toBeNull();
    });
  });

  // ────────────────────────────────────────────────────────────
  // virtualizeResponsePaths — field-name-aware recursive translator
  // ────────────────────────────────────────────────────────────

  describe("virtualizeResponsePaths (field-name-aware)", () => {
    it("should virtualize filePath in file.read responses", async () => {
      const { virtualizeResponsePaths } = await import("../src/utils.ts");

      const response = {
        filePath: "/workspace/src/index.ts",
        totalLines: 42,
        totalBytes: 1024,
        content: "const x = 1;\nconst y = 2;",
      };
      const result = virtualizeResponsePaths(response) as Record<string, unknown>;

      expect(result.filePath).toBe("/src/index.ts");
      expect(result.totalLines).toBe(42);
      expect(result.content).toBe("const x = 1;\nconst y = 2;");
    });

    it("should virtualize path in git responses", async () => {
      const { virtualizeResponsePaths } = await import("../src/utils.ts");

      const response = {
        path: "/workspace/prism-service",
        branch: "main",
        files: [
          { status: "M", file: "/workspace/prism-service/src/index.ts" },
          { status: "A", file: "/workspace/prism-service/src/new.ts" },
        ],
      };
      const result = virtualizeResponsePaths(response) as Record<string, unknown>;

      expect(result.path).toBe("/prism-service");
      expect(result.branch).toBe("main");
      const files = result.files as Array<Record<string, unknown>>;
      expect(files[0].file).toBe("/prism-service/src/index.ts");
      expect(files[1].file).toBe("/prism-service/src/new.ts");
    });

    it("should virtualize directory field in listDirectory responses", async () => {
      const { virtualizeResponsePaths } = await import("../src/utils.ts");

      const response = {
        directory: "/workspace/src",
        totalEntries: 5,
        entries: [
          { name: "index.ts", path: "index.ts", isDir: false },
          { name: "utils", path: "utils", isDir: true },
        ],
      };
      const result = virtualizeResponsePaths(response) as Record<string, unknown>;

      expect(result.directory).toBe("/src");
    });

    it("should NOT virtualize stdout/stderr in command responses", async () => {
      const { virtualizeResponsePaths } = await import("../src/utils.ts");

      const response = {
        success: true,
        stdout: "total 32\ndrwxr-xr-x 5 root root 4096 Jul  5 /workspace/src\n",
        stderr: "",
        exitCode: 0,
        executionTimeMs: 45,
      };
      const result = virtualizeResponsePaths(response) as Record<string, unknown>;

      // stdout must NOT be modified — it's command output, not a path field
      expect(result.stdout).toBe("total 32\ndrwxr-xr-x 5 root root 4096 Jul  5 /workspace/src\n");
      expect(result.stderr).toBe("");
    });

    it("should NOT virtualize error message strings", async () => {
      const { virtualizeResponsePaths } = await import("../src/utils.ts");

      const response = {
        error: "File not found: /workspace/missing.ts",
      };
      const result = virtualizeResponsePaths(response) as Record<string, unknown>;

      // Error is not a path field — passes through unchanged
      expect(result.error).toBe("File not found: /workspace/missing.ts");
    });

    it("should NOT virtualize code content in read responses", async () => {
      const { virtualizeResponsePaths } = await import("../src/utils.ts");

      const codeContent = "import { foo } from '/workspace/utils';\nconst root = '/workspace';";
      const response = {
        filePath: "/workspace/src/app.ts",
        content: codeContent,
      };
      const result = virtualizeResponsePaths(response) as Record<string, unknown>;

      expect(result.filePath).toBe("/src/app.ts");
      // Content must NOT be modified — it's file content, not a path
      expect(result.content).toBe(codeContent);
    });

    it("should virtualize file paths in arrays of grep matches", async () => {
      const { virtualizeResponsePaths } = await import("../src/utils.ts");

      const response = {
        matches: [
          { file: "/workspace/src/a.ts", line: 10, content: "const x = 1;" },
          { file: "/workspace/src/b.ts", line: 20, content: "const y = 2;" },
        ],
        totalMatches: 2,
      };
      const result = virtualizeResponsePaths(response) as Record<string, unknown>;
      const matches = result.matches as Array<Record<string, unknown>>;

      expect(matches[0].file).toBe("/src/a.ts");
      expect(matches[1].file).toBe("/src/b.ts");
      // content must NOT be modified
      expect(matches[0].content).toBe("const x = 1;");
    });

    it("should virtualize projectPath in project.summary responses", async () => {
      const { virtualizeResponsePaths } = await import("../src/utils.ts");

      const response = {
        projectPath: "/workspace/prism-service",
        projectName: "prism-service",
        tree: { name: "src", type: "directory", children: [] },
      };
      const result = virtualizeResponsePaths(response) as Record<string, unknown>;

      expect(result.projectPath).toBe("/prism-service");
      expect(result.projectName).toBe("prism-service");
    });

    it("should handle null and undefined values in responses", async () => {
      const { virtualizeResponsePaths } = await import("../src/utils.ts");

      const response = {
        filePath: "/workspace/test.ts",
        error: null,
        extra: undefined,
      };
      const result = virtualizeResponsePaths(response) as Record<string, unknown>;

      expect(result.filePath).toBe("/test.ts");
      expect(result.error).toBeNull();
    });

    it("should handle deeply nested response structures", async () => {
      const { virtualizeResponsePaths } = await import("../src/utils.ts");

      const response = {
        entries: [
          {
            name: "src",
            type: "directory",
            children: [
              {
                name: "components",
                type: "directory",
                path: "/workspace/src/components",
                children: [],
              },
            ],
          },
        ],
      };
      const result = virtualizeResponsePaths(response) as Record<string, unknown>;
      const entries = result.entries as Array<Record<string, unknown>>;
      const children = entries[0].children as Array<Record<string, unknown>>;

      expect(children[0].path).toBe("/src/components");
    });
  });

  // ────────────────────────────────────────────────────────────
  // Round-trip: devirtualize → virtualize should be identity
  // ────────────────────────────────────────────────────────────

  describe("round-trip consistency", () => {
    it("devirtualize then virtualize a path should return the original virtual path", async () => {
      const { devirtualizePath, virtualizePath } = await import("../src/utils.ts");

      const virtualPaths = ["/", "/src/foo.ts", "/package.json", "/deeply/nested/file.ts"];
      for (const virtualPath of virtualPaths) {
        const actual = devirtualizePath(virtualPath);
        const backToVirtual = virtualizePath(actual);
        expect(backToVirtual).toBe(virtualPath);
      }
    });

    it("virtualize then devirtualize an actual path should return the original actual path", async () => {
      const { devirtualizePath, virtualizePath } = await import("../src/utils.ts");

      const actualPaths = ["/workspace", "/workspace/src/foo.ts", "/workspace/package.json"];
      for (const actualPath of actualPaths) {
        const virtual = virtualizePath(actualPath);
        const backToActual = devirtualizePath(virtual);
        expect(backToActual).toBe(actualPath);
      }
    });

    it("full RPC round-trip: devirtualize params → handler processes → virtualize result", async () => {
      const { devirtualizeRequestParams, virtualizeResponsePaths } = await import("../src/utils.ts");

      // Simulate file.read RPC
      const incomingParams = { path: "/src/index.ts", startLine: 1 };
      const handlerParams = devirtualizeRequestParams(incomingParams) as Record<string, unknown>;
      expect(handlerParams.path).toBe("/workspace/src/index.ts");

      // Simulate handler response (uses actual paths)
      const handlerResponse = {
        filePath: "/workspace/src/index.ts",
        totalLines: 100,
        content: "console.log('hello');",
      };
      const virtualizedResponse = virtualizeResponsePaths(handlerResponse) as Record<string, unknown>;
      expect(virtualizedResponse.filePath).toBe("/src/index.ts");
      expect(virtualizedResponse.content).toBe("console.log('hello');");
    });

    it("full RPC round-trip: command.run with cwd and stdout", async () => {
      const { devirtualizeRequestParams, virtualizeResponsePaths } = await import("../src/utils.ts");

      // Incoming from LLM
      const incomingParams = { command: "ls -la /usr/local", cwd: "/prism-service" };
      const handlerParams = devirtualizeRequestParams(incomingParams) as Record<string, unknown>;

      // Command must NOT be modified
      expect(handlerParams.command).toBe("ls -la /usr/local");
      expect(handlerParams.cwd).toBe("/workspace/prism-service");

      // Response from handler
      const handlerResponse = {
        success: true,
        stdout: "/workspace/prism-service $ ls -la /usr/local\ntotal 0\n",
        stderr: "",
        exitCode: 0,
      };
      const virtualizedResponse = virtualizeResponsePaths(handlerResponse) as Record<string, unknown>;

      // stdout must NOT be modified
      expect(virtualizedResponse.stdout).toBe("/workspace/prism-service $ ls -la /usr/local\ntotal 0\n");
    });
  });

  // ────────────────────────────────────────────────────────────
  // Edge cases & adversarial inputs
  // ────────────────────────────────────────────────────────────

  describe("edge cases & adversarial inputs", () => {
    it("should handle paths with special characters", async () => {
      const { devirtualizePath, virtualizePath } = await import("../src/utils.ts");

      expect(devirtualizePath("/src/my file (1).ts")).toBe("/workspace/src/my file (1).ts");
      expect(virtualizePath("/workspace/src/my file (1).ts")).toBe("/src/my file (1).ts");
    });

    it("should handle paths with unicode characters", async () => {
      const { devirtualizePath, virtualizePath } = await import("../src/utils.ts");

      expect(devirtualizePath("/src/日本語.ts")).toBe("/workspace/src/日本語.ts");
      expect(virtualizePath("/workspace/src/日本語.ts")).toBe("/src/日本語.ts");
    });

    it("should handle paths with trailing slashes", async () => {
      const { devirtualizePath, virtualizePath } = await import("../src/utils.ts");

      // Trailing slashes are preserved
      expect(devirtualizePath("/src/")).toBe("/workspace/src/");
      expect(virtualizePath("/workspace/src/")).toBe("/src/");
    });

    it("should not double-prefix paths already at the actual root", async () => {
      const { devirtualizePath } = await import("../src/utils.ts");

      // This should NOT become /workspace/workspace/src/foo.ts
      expect(devirtualizePath("/workspace/src/foo.ts")).toBe("/workspace/src/foo.ts");
      expect(devirtualizePath("/workspace")).toBe("/workspace");
    });

    it("should handle empty object params", async () => {
      const { devirtualizeRequestParams, virtualizeResponsePaths } = await import("../src/utils.ts");

      expect(devirtualizeRequestParams({})).toEqual({});
      expect(virtualizeResponsePaths({})).toEqual({});
    });

    it("should handle primitive values at root level", async () => {
      const { devirtualizeRequestParams, virtualizeResponsePaths } = await import("../src/utils.ts");

      expect(devirtualizeRequestParams(42)).toBe(42);
      expect(devirtualizeRequestParams(true)).toBe(true);
      expect(devirtualizeRequestParams(null)).toBeNull();
      expect(virtualizeResponsePaths(42)).toBe(42);
      expect(virtualizeResponsePaths(null)).toBeNull();
    });

    it("should NOT devirtualize glob patterns in includes arrays", async () => {
      const { devirtualizeRequestParams } = await import("../src/utils.ts");

      const params = {
        pattern: "TODO",
        searchPath: "/src",
        includes: ["*.ts", "*.tsx", "!**/node_modules/**"],
        caseInsensitive: true,
      };
      const result = devirtualizeRequestParams(params) as Record<string, unknown>;

      expect(result.searchPath).toBe("/workspace/src");
      // includes are glob patterns, NOT paths — must not be modified
      expect(result.includes).toEqual(["*.ts", "*.tsx", "!**/node_modules/**"]);
    });

    it("should NOT devirtualize git ref strings", async () => {
      const { devirtualizeRequestParams } = await import("../src/utils.ts");

      const params = {
        path: "/prism-service",
        ref: "HEAD~3",
        filePath: "/prism-service/src/index.ts",
      };
      const result = devirtualizeRequestParams(params) as Record<string, unknown>;

      expect(result.path).toBe("/workspace/prism-service");
      expect(result.ref).toBe("HEAD~3");
      expect(result.filePath).toBe("/workspace/prism-service/src/index.ts");
    });

    it("should NOT devirtualize author or since strings in git.log", async () => {
      const { devirtualizeRequestParams } = await import("../src/utils.ts");

      const params = {
        path: "/prism-service",
        limit: 20,
        author: "rodrigo",
        since: "2026-01-01",
      };
      const result = devirtualizeRequestParams(params) as Record<string, unknown>;

      expect(result.path).toBe("/workspace/prism-service");
      expect(result.author).toBe("rodrigo");
      expect(result.since).toBe("2026-01-01");
    });

    it("should NOT devirtualize base64 content in binary file responses", async () => {
      const { virtualizeResponsePaths } = await import("../src/utils.ts");

      const response = {
        filePath: "/workspace/assets/logo.png",
        isBinary: true,
        sizeBytes: 2048,
        contentBase64: "iVBORw0KGgoAAAANSUhEUgAA/workspace/fake",
      };
      const result = virtualizeResponsePaths(response) as Record<string, unknown>;

      expect(result.filePath).toBe("/assets/logo.png");
      // base64 content must NOT be corrupted
      expect(result.contentBase64).toBe("iVBORw0KGgoAAAANSUhEUgAA/workspace/fake");
    });

    it("should NOT devirtualize 'name' field even if it looks like a path", async () => {
      const { virtualizeResponsePaths } = await import("../src/utils.ts");

      const response = {
        entries: [
          { name: "/workspace/src", type: "directory" },
        ],
      };
      const result = virtualizeResponsePaths(response) as Record<string, unknown>;
      const entries = result.entries as Array<Record<string, unknown>>;

      // 'name' is not a response path field — must stay unchanged
      expect(entries[0].name).toBe("/workspace/src");
    });

    it("should handle the directory.tree response correctly", async () => {
      const { virtualizeResponsePaths } = await import("../src/utils.ts");

      const response = {
        entries: [
          {
            name: "src",
            type: "directory",
            children: [
              { name: "index.ts", type: "file" },
              {
                name: "components",
                type: "directory",
                children: [{ name: "App.tsx", type: "file" }],
              },
            ],
          },
          { name: "package.json", type: "file" },
        ],
      };

      const result = virtualizeResponsePaths(response) as Record<string, unknown>;
      const entries = result.entries as Array<Record<string, unknown>>;

      // Tree entries use 'name' (relative) and 'type', no absolute paths
      // Nothing should be corrupted
      expect(entries[0].name).toBe("src");
      expect(entries[1].name).toBe("package.json");
      const children = entries[0].children as Array<Record<string, unknown>>;
      expect(children[0].name).toBe("index.ts");
    });
  });
});
