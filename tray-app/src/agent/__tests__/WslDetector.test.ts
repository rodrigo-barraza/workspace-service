import { describe, it, expect } from "vitest";
import {
  parseWslListOutput,
  wslUncPathToLinuxPath,
  windowsDrivePathToWslMountPath,
} from "../WslDetector.ts";

// ────────────────────────────────────────────────────────────
// parseWslListOutput
// ────────────────────────────────────────────────────────────

describe("parseWslListOutput", () => {
  it("should parse a standard wsl -l -v output with multiple distros", () => {
    const rawOutput = [
      "  NAME                   STATE           VERSION",
      "* Ubuntu-24.04           Running         2",
      "  Debian                 Stopped         2",
    ].join("\n");

    const distros = parseWslListOutput(rawOutput);

    expect(distros).toHaveLength(2);
    expect(distros[0]).toEqual({
      name: "Ubuntu-24.04",
      state: "Running",
      version: 2,
      isDefault: true,
    });
    expect(distros[1]).toEqual({
      name: "Debian",
      state: "Stopped",
      version: 2,
      isDefault: false,
    });
  });

  it("should handle output with BOM and null bytes from UTF-16LE encoding", () => {
    const rawOutput = "\uFEFF  N\0A\0M\0E\0   S\0T\0A\0T\0E\0   V\0E\0R\0\n* Ubuntu   Running   2\n";
    const cleanedOutput = rawOutput.replace(/\0/g, "").replace(/\uFEFF/g, "").replace(/\r/g, "");

    const distros = parseWslListOutput(cleanedOutput);

    expect(distros.length).toBeGreaterThanOrEqual(1);
    expect(distros[0].name).toBe("Ubuntu");
    expect(distros[0].isDefault).toBe(true);
  });

  it("should handle output with carriage returns (Windows line endings)", () => {
    const rawOutput = "  NAME                   STATE           VERSION\r\n* Ubuntu                 Running         2\r\n  kali-linux             Stopped         1\r\n";

    const distros = parseWslListOutput(rawOutput);

    expect(distros).toHaveLength(2);
    expect(distros[0].name).toBe("Ubuntu");
    expect(distros[1].name).toBe("kali-linux");
    expect(distros[1].version).toBe(1);
  });

  it("should return empty array for empty output", () => {
    expect(parseWslListOutput("")).toEqual([]);
  });

  it("should return empty array for header-only output", () => {
    expect(parseWslListOutput("  NAME   STATE   VERSION\n")).toEqual([]);
  });

  it("should handle a single distro with Installing state", () => {
    const rawOutput = [
      "  NAME                   STATE           VERSION",
      "  openSUSE-Leap-15.4     Installing      2",
    ].join("\n");

    const distros = parseWslListOutput(rawOutput);

    expect(distros).toHaveLength(1);
    expect(distros[0]).toEqual({
      name: "openSUSE-Leap-15.4",
      state: "Installing",
      version: 2,
      isDefault: false,
    });
  });

  it("should mark unknown states as Unknown", () => {
    const rawOutput = [
      "  NAME                   STATE           VERSION",
      "  TestDistro             Converting      2",
    ].join("\n");

    const distros = parseWslListOutput(rawOutput);

    expect(distros).toHaveLength(1);
    expect(distros[0].state).toBe("Unknown");
  });
});

// ────────────────────────────────────────────────────────────
// wslUncPathToLinuxPath
// ────────────────────────────────────────────────────────────

describe("wslUncPathToLinuxPath", () => {
  it("should translate \\\\wsl.localhost\\<distro>\\path to Linux path", () => {
    const result = wslUncPathToLinuxPath("\\\\wsl.localhost\\Ubuntu-24.04\\home\\rodrigo\\development");

    expect(result).not.toBeNull();
    expect(result!.distroName).toBe("Ubuntu-24.04");
    expect(result!.linuxPath).toBe("/home/rodrigo/development");
  });

  it("should translate \\\\wsl$\\<distro>\\path (legacy format)", () => {
    const result = wslUncPathToLinuxPath("\\\\wsl$\\Ubuntu-24.04\\home\\rodrigo\\dev");

    expect(result).not.toBeNull();
    expect(result!.distroName).toBe("Ubuntu-24.04");
    expect(result!.linuxPath).toBe("/home/rodrigo/dev");
  });

  it("should handle root path with no trailing components", () => {
    const result = wslUncPathToLinuxPath("\\\\wsl.localhost\\Debian");

    expect(result).not.toBeNull();
    expect(result!.distroName).toBe("Debian");
    expect(result!.linuxPath).toBe("/");
  });

  it("should handle paths with forward slashes (mixed format)", () => {
    const result = wslUncPathToLinuxPath("//wsl.localhost/Ubuntu/home/user/project");

    expect(result).not.toBeNull();
    expect(result!.distroName).toBe("Ubuntu");
    expect(result!.linuxPath).toBe("/home/user/project");
  });

  it("should return null for non-WSL UNC paths", () => {
    expect(wslUncPathToLinuxPath("\\\\server\\share\\folder")).toBeNull();
  });

  it("should return null for regular Windows paths", () => {
    expect(wslUncPathToLinuxPath("C:\\Users\\rodrigo\\Desktop")).toBeNull();
  });

  it("should return null for empty string", () => {
    expect(wslUncPathToLinuxPath("")).toBeNull();
  });

  it("should return null for Linux paths (not UNC)", () => {
    expect(wslUncPathToLinuxPath("/home/rodrigo/dev")).toBeNull();
  });

  it("should handle distro names with dots and hyphens", () => {
    const result = wslUncPathToLinuxPath("\\\\wsl.localhost\\openSUSE-Leap-15.4\\opt\\project");

    expect(result).not.toBeNull();
    expect(result!.distroName).toBe("openSUSE-Leap-15.4");
    expect(result!.linuxPath).toBe("/opt/project");
  });

  it("should be case-insensitive for the wsl.localhost prefix", () => {
    const result = wslUncPathToLinuxPath("\\\\WSL.LOCALHOST\\Ubuntu\\tmp");

    expect(result).not.toBeNull();
    expect(result!.distroName).toBe("Ubuntu");
    expect(result!.linuxPath).toBe("/tmp");
  });
});

// ────────────────────────────────────────────────────────────
// windowsDrivePathToWslMountPath
// ────────────────────────────────────────────────────────────

describe("windowsDrivePathToWslMountPath", () => {
  it("should translate C:\\ drive path to /mnt/c/ mount path", () => {
    expect(windowsDrivePathToWslMountPath("C:\\Users\\rodrigo\\AppData\\Local\\app"))
      .toBe("/mnt/c/Users/rodrigo/AppData/Local/app");
  });

  it("should lowercase the drive letter", () => {
    expect(windowsDrivePathToWslMountPath("D:\\Projects\\Code"))
      .toBe("/mnt/d/Projects/Code");
  });

  it("should handle lowercase drive letters", () => {
    expect(windowsDrivePathToWslMountPath("e:\\data\\files"))
      .toBe("/mnt/e/data/files");
  });

  it("should handle root of a drive", () => {
    expect(windowsDrivePathToWslMountPath("C:\\"))
      .toBe("/mnt/c/");
  });

  it("should handle forward slashes in input", () => {
    expect(windowsDrivePathToWslMountPath("C:/Users/rodrigo/file.txt"))
      .toBe("/mnt/c/Users/rodrigo/file.txt");
  });

  it("should pass through non-drive paths unchanged", () => {
    expect(windowsDrivePathToWslMountPath("/home/rodrigo/dev"))
      .toBe("/home/rodrigo/dev");
  });

  it("should pass through UNC paths unchanged (handled by wslUncPathToLinuxPath)", () => {
    expect(windowsDrivePathToWslMountPath("\\\\server\\share"))
      .toBe("\\\\server\\share");
  });

  it("should handle paths with spaces", () => {
    expect(windowsDrivePathToWslMountPath("C:\\Program Files\\My App\\config"))
      .toBe("/mnt/c/Program Files/My App/config");
  });
});
