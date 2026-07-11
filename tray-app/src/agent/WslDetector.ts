// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// WSL2 Detection & Path Translation Utilities
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WslDistroInfo } from "../shared/types.js";

const execFileAsync = promisify(execFile);

const WSL_EXECUTABLE = "wsl.exe";
const WSL_COMMAND_TIMEOUT_MILLISECONDS = 10_000;
const NODE_CHECK_TIMEOUT_MILLISECONDS = 15_000;

// ────────────────────────────────────────────────────────────
// Distro Detection
// ────────────────────────────────────────────────────────────

/**
 * Detect all installed WSL2 distros by parsing `wsl.exe -l -v` output.
 *
 * The output format is typically:
 *   NAME                   STATE           VERSION
 * * Ubuntu-24.04           Running         2
 *   Debian                 Stopped         2
 *
 * Note: wsl.exe outputs UTF-16LE when piped on Windows, so we
 * strip null bytes and BOM characters before parsing.
 */
export async function detectWslDistros(): Promise<WslDistroInfo[]> {
  try {
    const { stdout } = await execFileAsync(WSL_EXECUTABLE, ["-l", "-v"], {
      timeout: WSL_COMMAND_TIMEOUT_MILLISECONDS,
      windowsHide: true,
    });

    return parseWslListOutput(stdout);
  } catch {
    return [];
  }
}

/**
 * Check whether WSL is available and at least one WSL2 distro is installed.
 */
export async function isWslAvailable(): Promise<boolean> {
  const distros = await detectWslDistros();
  return distros.some((distro) => distro.version === 2);
}

/**
 * Verify that Node.js is available inside a specific WSL distro.
 * Returns the Node version string on success, or null if unavailable.
 */
export async function checkNodeInDistro(distroName: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      WSL_EXECUTABLE,
      ["-d", distroName, "--", "node", "--version"],
      { timeout: NODE_CHECK_TIMEOUT_MILLISECONDS, windowsHide: true },
    );

    const version = cleanWslOutput(stdout).trim();
    if (version.startsWith("v")) {
      return version;
    }
    return null;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────
// Path Translation
// ────────────────────────────────────────────────────────────

/**
 * Translate a Windows UNC path pointing into a WSL distro to
 * the equivalent Linux-native path.
 *
 * \\wsl.localhost\Ubuntu-24.04\home\rodrigo\dev → /home/rodrigo/dev
 * \\wsl$\Ubuntu-24.04\home\rodrigo\dev         → /home/rodrigo/dev
 *
 * Returns null if the path doesn't match a WSL UNC pattern.
 */
export function wslUncPathToLinuxPath(windowsUncPath: string): { distroName: string; linuxPath: string } | null {
  const normalizedPath = windowsUncPath.replace(/\//g, "\\");

  // Match \\wsl.localhost\<distro>\... or \\wsl$\<distro>\...
  const wslUncPattern = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(.*)$/i;
  const matchResult = normalizedPath.match(wslUncPattern);

  if (!matchResult) {
    return null;
  }

  const distroName = matchResult[1];
  const remainingWindowsPath = matchResult[2] || "";
  const linuxPath = remainingWindowsPath.replace(/\\/g, "/") || "/";

  return { distroName, linuxPath };
}

/**
 * Translate a Windows drive path to the equivalent WSL /mnt/ path.
 *
 * C:\Users\rodrigo\AppData\Local\... → /mnt/c/Users/rodrigo/AppData/Local/...
 * D:\projects\code                   → /mnt/d/projects/code
 */
export function windowsDrivePathToWslMountPath(windowsPath: string): string {
  const normalizedPath = windowsPath.replace(/\//g, "\\");

  // Match drive letter paths: C:\...
  const drivePattern = /^([A-Za-z]):\\(.*)$/;
  const matchResult = normalizedPath.match(drivePattern);

  if (!matchResult) {
    return windowsPath;
  }

  const driveLetter = matchResult[1].toLowerCase();
  const remainingPath = matchResult[2].replace(/\\/g, "/");

  return `/mnt/${driveLetter}/${remainingPath}`;
}

// ────────────────────────────────────────────────────────────
// Internal Parsing Helpers
// ────────────────────────────────────────────────────────────

/**
 * Clean WSL output by removing UTF-16LE null bytes, BOM, and
 * carriage returns that wsl.exe produces when piped on Windows.
 */
function cleanWslOutput(rawOutput: string): string {
  return rawOutput
    .replace(/\0/g, "")
    .replace(/\uFEFF/g, "")
    .replace(/\r/g, "");
}

/**
 * Parse the tabular output of `wsl.exe -l -v` into structured
 * distro info objects.
 */
export function parseWslListOutput(rawOutput: string): WslDistroInfo[] {
  const cleanedOutput = cleanWslOutput(rawOutput);
  const outputLines = cleanedOutput.split("\n").filter((line) => line.trim().length > 0);

  if (outputLines.length < 2) {
    return [];
  }

  // Skip the header line (NAME  STATE  VERSION)
  const dataLines = outputLines.slice(1);
  const distros: WslDistroInfo[] = [];

  for (const line of dataLines) {
    const parsedDistro = parseDistroLine(line);
    if (parsedDistro) {
      distros.push(parsedDistro);
    }
  }

  return distros;
}

/**
 * Parse a single line from `wsl -l -v` output.
 *
 * Lines look like:
 *   "* Ubuntu-24.04           Running         2"
 *   "  Debian                 Stopped         2"
 */
function parseDistroLine(line: string): WslDistroInfo | null {
  const isDefault = line.trimStart().startsWith("*");
  const cleanedLine = line.replace(/^\s*\*?\s*/, "");

  // Split on 2+ whitespace characters to separate columns
  const columns = cleanedLine.trim().split(/\s{2,}/);

  if (columns.length < 3) {
    return null;
  }

  const name = columns[0].trim();
  const stateRaw = columns[1].trim();
  const versionRaw = columns[2].trim();

  if (!name) {
    return null;
  }

  const stateMap: Record<string, WslDistroInfo["state"]> = {
    "Running": "Running",
    "Stopped": "Stopped",
    "Installing": "Installing",
  };

  const state = stateMap[stateRaw] || "Unknown";
  const version = parseInt(versionRaw, 10) || 0;

  return { name, state, version, isDefault };
}
