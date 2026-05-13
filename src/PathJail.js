// ─── Filesystem Jail ────────────────────────────────────────
// Every path that enters or exits a handler MUST pass through
// PathJail.contains().  It resolves symlinks (realpath) and
// verifies the true on-disk location falls inside the
// declared workspace roots.

import { resolve, sep, dirname, basename } from "node:path";
import { realpathSync } from "node:fs";

export class PathJail {
  /**
   * @param {string[]} roots - Workspace root directories
   */
  constructor(roots) {
    // Resolve AND realpath the roots at boot so symlinked
    // roots themselves are handled correctly.
    this.roots = roots.map((r) => {
      const resolved = resolve(r);
      try {
        return realpathSync(resolved);
      } catch {
        return resolved;
      }
    });
  }

  /**
   * Validate that an absolute or relative path resolves inside
   * one of the workspace roots.
   *
   * Uses `realpathSync` to follow symlinks and detect escapes.
   * For paths that don't exist yet (e.g. write_file creating a
   * new file), it walks up the ancestor chain until it finds a
   * real directory, realpaths that, then re-appends the trailing
   * segments.
   *
   * @param {string} inputPath
   * @returns {{ safe: boolean, resolved: string, error?: string }}
   */
  contains(inputPath) {
    if (!inputPath || typeof inputPath !== "string") {
      return { safe: false, resolved: "", error: "Path is required (string)" };
    }

    // Resolve relative paths against the first root
    const resolved = inputPath.startsWith("/")
      ? resolve(inputPath)
      : resolve(this.roots[0], inputPath);

    // Try realpath first (existing files/dirs)
    let real;
    try {
      real = realpathSync(resolved);
    } catch {
      // Path doesn't exist yet — resolve the existing ancestor
      real = this._resolveNewPath(resolved);
    }

    if (!this._isInside(real)) {
      return {
        safe: false,
        resolved: real,
        error: `Path '${real}' is outside workspace roots`,
      };
    }

    return { safe: true, resolved: real };
  }

  /**
   * Check if an absolute path falls within any root.
   * @param {string} absolutePath
   * @returns {boolean}
   */
  _isInside(absolutePath) {
    return this.roots.some(
      (root) => absolutePath === root || absolutePath.startsWith(root + sep),
    );
  }

  /**
   * For paths that don't exist yet, walk up the directory tree
   * until we reach a real directory, realpath it, then re-append
   * the non-existent trailing segments.
   *
   * Example:
   *   /volume1/media/newdir/file.txt
   *   → /volume1/media exists → realpath → /volume1/media
   *   → re-append newdir/file.txt
   *   → /volume1/media/newdir/file.txt
   *
   * @param {string} targetPath
   * @returns {string}
   */
  _resolveNewPath(targetPath) {
    const trailing = [];
    let current = targetPath;

    while (current !== "/" && current !== ".") {
      try {
        const real = realpathSync(current);
        // Re-append the non-existent segments
        return trailing.length > 0
          ? resolve(real, ...trailing)
          : real;
      } catch {
        trailing.unshift(basename(current));
        current = dirname(current);
      }
    }

    // Reached filesystem root — path is fully non-existent
    return targetPath;
  }
}
