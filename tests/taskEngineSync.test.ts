import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// The shared task engine is ONE module in two repositories
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// tools-service runs the same TaskEngine.ts and WorkspaceHooks.ts in local
// mode, so a command behaves the same whether the bridge or the service
// runs it. The copies must stay byte-identical: edit one, copy it over the
// other. Skipped, visibly, when there is no tools-service checkout beside
// this one (a lone clone, a container).

const BRIDGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The tools-service checkout that belongs with this one: `TOOLS_SERVICE_DIR`,
 * else a worktree of the same name (the task branch, or `batch`) beside this
 * one's, else tools-service's main checkout next to this repository's.
 */
function siblingToolsCheckout(): string | null {
  const override = process.env.TOOLS_SERVICE_DIR;
  if (override) return existsSync(override) ? override : null;
  const worktree = BRIDGE_ROOT.match(/^(.*)\/workspace-service\/\.claude\/worktrees\/([^/]+)$/);
  const candidates = worktree
    ? [join(worktree[1], "tools-service/.claude/worktrees", worktree[2]), join(worktree[1], "tools-service")]
    : [join(dirname(BRIDGE_ROOT), "tools-service")];
  return candidates.find((candidate) => existsSync(join(candidate, "package.json"))) ?? null;
}

const TOOLS = siblingToolsCheckout();
const SHARED_FILES = ["TaskEngine.ts", "WorkspaceHooks.ts"];

describe("shared task engine", () => {
  for (const file of SHARED_FILES) {
    const theirs = TOOLS && join(TOOLS, "src/services/tasks", file);
    it.skipIf(!theirs || !existsSync(theirs))(
      `src/handlers/${file} is byte-identical to tools-service's (${theirs ?? "no tools-service checkout"})`,
      () => {
        const ours = readFileSync(join(BRIDGE_ROOT, "src/handlers", file), "utf8");
        expect(
          readFileSync(theirs!, "utf8") === ours,
          `copy workspace-service/src/handlers/${file} over tools-service/src/services/tasks/${file} (or the other way round)`,
        ).toBe(true);
      },
    );
  }
});
