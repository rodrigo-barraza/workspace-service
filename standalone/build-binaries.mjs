#!/usr/bin/env node

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Standalone Workspace Agent — Binary Builder Script
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { execSync } from "node:child_process";
import { writeFileSync, copyFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentFilename = fileURLToPath(import.meta.url);
const currentDirectory = resolve(currentFilename, "..");

const targetDirectory = resolve(currentDirectory, "../dist/binaries");
const standaloneSourceFile = resolve(currentDirectory, "workspace-agent.mjs");
const temporaryCommonJsFile = resolve(currentDirectory, "../dist/workspace-agent.cjs");
const seaConfigurationPath = resolve(currentDirectory, "../dist/sea-config.json");
const preparationBlobPath = resolve(currentDirectory, "../dist/sea-prep.blob");

console.log("=== Building Standalone Workspace Agent Executables ===");

// 1. Ensure directory structure
if (!existsSync(targetDirectory)) {
  mkdirSync(targetDirectory, { recursive: true });
}

// 2. Transpile to CommonJS with esbuild
console.log("Transpiling workspace-agent to CommonJS…");
execSync(`npx esbuild "${standaloneSourceFile}" --bundle --platform=node --format=cjs --outfile="${temporaryCommonJsFile}"`, { stdio: "inherit" });

// 3. Write sea-config.json
console.log("Creating SEA configuration…");
const seaConfiguration = {
  main: temporaryCommonJsFile,
  output: preparationBlobPath,
  disableSentinel: true,
};
writeFileSync(seaConfigurationPath, JSON.stringify(seaConfiguration, null, 2), "utf-8");

// 4. Generate SEA preparation blob
console.log("Generating SEA preparation blob…");
execSync(`node --experimental-sea-config "${seaConfigurationPath}"`, { stdio: "inherit" });

// 5. Build for current host platform (Linux/macOS)
const currentPlatform = process.platform;
const sentinelFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

if (currentPlatform === "linux") {
  const binaryDestination = join(targetDirectory, "workspace-agent-linux");
  console.log(`Building Linux binary: ${binaryDestination}`);
  // Copy current node binary
  const nodeBinaryPath = execSync("readlink -f $(which node)", { encoding: "utf-8" }).trim();
  copyFileSync(nodeBinaryPath, binaryDestination);
  // Inject blob
  execSync(`npx postject "${binaryDestination}" NODE_SEA_BLOB "${preparationBlobPath}" --sentinel-fuse ${sentinelFuse}`, { stdio: "inherit" });
  console.log("Linux binary built successfully!");
} else if (currentPlatform === "darwin") {
  const binaryDestination = join(targetDirectory, "workspace-agent-macos");
  console.log(`Building macOS binary: ${binaryDestination}`);
  const nodeBinaryPath = execSync("which node", { encoding: "utf-8" }).trim();
  copyFileSync(nodeBinaryPath, binaryDestination);
  execSync(`npx postject "${binaryDestination}" NODE_SEA_BLOB "${preparationBlobPath}" --sentinel-fuse ${sentinelFuse}`, { stdio: "inherit" });
  // Resign binary on macOS
  try {
    execSync(`codesign --sign - "${binaryDestination}"`, { stdio: "inherit" });
  } catch (error) {
    console.warn("Failed to codesign macOS binary (ignoring):", error.message);
  }
  console.log("macOS binary built successfully!");
}

// 6. Clean up temporary files
console.log("Cleaning up temporary build artifacts…");
if (existsSync(temporaryCommonJsFile)) {
  rmSync(temporaryCommonJsFile);
}
if (existsSync(seaConfigurationPath)) {
  rmSync(seaConfigurationPath);
}
if (existsSync(preparationBlobPath)) {
  rmSync(preparationBlobPath);
}

console.log("=== Build complete! ===");
