import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";

// Determine host development directory (parent of workspace-service)
const serviceRoot = resolve(dirname(new URL(import.meta.url).pathname));
// Under 'src', so going up one level gets to the root of workspace-service
const workspaceServiceRoot = resolve(serviceRoot, "..");
// The parent directory of workspace-service (e.g. /home/rodrigo/development)
const hostDevelopmentRoot = resolve(workspaceServiceRoot, "..");

export function translatePath(inputPath: string, roots?: string[]): string {
  if (!inputPath || typeof inputPath !== "string") {
    return inputPath;
  }

  // Only translate absolute paths that start with "/workspace" when the
  // "/workspace" directory does not exist on this host (i.e. running outside Docker).
  // All other paths (relative like ".", "./src", or other absolute paths) pass
  // through unchanged so the caller's resolve(roots[0], path) logic works correctly.
  if ((inputPath === "/workspace" || inputPath.startsWith("/workspace/")) && !existsSync("/workspace")) {
    const localRoot = (roots && roots.length > 0) ? roots[0] : hostDevelopmentRoot;

    if (inputPath === "/workspace") {
      return localRoot;
    }
    return localRoot + inputPath.slice("/workspace".length);
  }

  return inputPath;
}

export function translateRoots(roots: string[]): string[] {
  return roots.map((root: string) => {
    if (root === "/workspace" && !existsSync("/workspace")) {
      return hostDevelopmentRoot;
    }
    return root;
  });
}
