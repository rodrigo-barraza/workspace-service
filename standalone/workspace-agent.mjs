#!/usr/bin/env node

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Workspace Agent — CLI Wrapper
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
//  Zero dependencies. Runs on Node.js 22+ (uses built-in WebSocket).
//
//  Usage:
//    node workspace-agent.mjs \
//      --backend ws://your-server:5590 \
//      --workspace /path/to/your/project \
//      --secret YOUR_API_SECRET
//
//  All flags also accept env vars:
//    WORKSPACE_BACKEND, WORKSPACE_ROOTS (comma-separated), WORKSPACE_SERVICE_SECRET
//
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import readline from "node:readline";

import { WorkspaceAgent, hostname } from "./workspace-agent-core.mjs";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Logger (thin — just for CLI output in this wrapper)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const CLI_COLORS = { reset: "\x1b[0m", dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m" };

function cliTimestamp() { return new Date().toISOString().slice(11, 23); }
const logger = {
  info:    (message) => console.log(`${CLI_COLORS.dim}${cliTimestamp()}${CLI_COLORS.reset} ${CLI_COLORS.blue}INFO${CLI_COLORS.reset}  ${message}`),
  success: (message) => console.log(`${CLI_COLORS.dim}${cliTimestamp()}${CLI_COLORS.reset} ${CLI_COLORS.green}  OK${CLI_COLORS.reset}  ${message}`),
  warn:    (message) => console.log(`${CLI_COLORS.dim}${cliTimestamp()}${CLI_COLORS.reset} ${CLI_COLORS.yellow}WARN${CLI_COLORS.reset}  ${message}`),
  error:   (message) => console.log(`${CLI_COLORS.dim}${cliTimestamp()}${CLI_COLORS.reset} ${CLI_COLORS.red} ERR${CLI_COLORS.reset}  ${message}`),
};

async function waitForKeypressBeforeExit() {
  if (process.platform === "win32" && process.stdin.isTTY) {
    const readlineInterface = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise((resolvePromise) => {
      readlineInterface.question("\nPress Enter to exit...", () => {
        readlineInterface.close();
        resolvePromise();
      });
    });
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CLI
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--backend" || args[index] === "-b") { parsed.backend = args[++index]; }
    else if (args[index] === "--workspace" || args[index] === "-w") {
      parsed.workspace = parsed.workspace || [];
      while (index + 1 < args.length && !args[index + 1].startsWith("-")) { parsed.workspace.push(args[++index]); }
    }
    else if (args[index] === "--secret" || args[index] === "-s") { parsed.secret = args[++index]; }
    else if (args[index] === "--name" || args[index] === "-n") { parsed.name = args[++index]; }
    else if (args[index] === "--help" || args[index] === "-h") { parsed.help = true; }
  }
  return parsed;
}

function showHelp() {
  console.log(`
  Workspace Agent — Zero-dependency standalone workspace sidecar

  Usage:
    node workspace-agent.mjs [options]

  Options:
    -b, --backend <url>        WebSocket URL of tools-service (or WORKSPACE_BACKEND env)
    -w, --workspace <paths...> Local directory root(s) to expose (or WORKSPACE_ROOTS env, comma-separated)
    -s, --secret <secret>      API secret for authentication (or WORKSPACE_SERVICE_SECRET env)
    -n, --name <name>          Human-readable agent name (default: hostname)
    -h, --help                 Show this help message

  Examples:
    node workspace-agent.mjs -b ws://192.168.86.2:5590 -w /home/user/projects -s mySecret
    node workspace-agent.mjs --backend ws://myserver:5590 --workspace ~/dev ~/work
  `);
}

const AGENT_CONFIG_FILE_PATH = join(homedir(), ".prism-workspace-agent.json");

async function readPersistentConfiguration() {
  try {
    if (existsSync(AGENT_CONFIG_FILE_PATH)) {
      const configurationData = await readFile(AGENT_CONFIG_FILE_PATH, "utf-8");
      return JSON.parse(configurationData);
    }
  } catch (error) {
    logger.warn(`Failed to read config file: ${error.message}`);
  }
  return null;
}

async function writePersistentConfiguration(configuration) {
  try {
    await mkdir(dirname(AGENT_CONFIG_FILE_PATH), { recursive: true });
    await writeFile(AGENT_CONFIG_FILE_PATH, JSON.stringify(configuration, null, 2), "utf-8");
    logger.success(`Saved configuration to ${AGENT_CONFIG_FILE_PATH}`);
  } catch (error) {
    logger.warn(`Failed to save config file: ${error.message}`);
  }
}

function promptUserQuestion(questionText) {
  const readlineInterface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolvePromise) => {
    readlineInterface.question(questionText, (userAnswer) => {
      readlineInterface.close();
      resolvePromise(userAnswer.trim());
    });
  });
}

function selectDirectoryViaNativeDialog() {
  const currentPlatform = process.platform;
  try {
    if (currentPlatform === "win32") {
      const powershellScript = `
        Add-Type -AssemblyName System.Windows.Forms
        $folderBrowser = New-Object System.Windows.Forms.FolderBrowserDialog
        $folderBrowser.Description = "Select workspace directory to sync with Prism"
        $folderBrowser.ShowNewFolderButton = $true
        if ($folderBrowser.ShowDialog() -eq "OK") { $folderBrowser.SelectedPath }
      `;
      const sanitizedScript = powershellScript.replace(/\n/g, ";");
      const pathResult = execSync(`powershell -NoProfile -Command "${sanitizedScript}"`, { encoding: "utf-8" }).trim();
      return pathResult || null;
    } else if (currentPlatform === "darwin") {
      const appleScriptCommand = `POSIX path of (choose folder with prompt "Select workspace directory to sync with Prism:")`;
      const pathResult = execSync(`osascript -e '${appleScriptCommand}'`, { encoding: "utf-8" }).trim();
      return pathResult || null;
    } else if (currentPlatform === "linux") {
      try {
        const pathResult = execSync('zenity --file-selection --directory --title="Select workspace directory to sync with Prism"', { encoding: "utf-8" }).trim();
        return pathResult || null;
      } catch (error) {
        return null;
      }
    }
  } catch (error) {
    return null;
  }
  return null;
}

async function runInteractiveConfigurationWizard() {
  logger.info("No configuration found. Starting setup wizard…");

  let backendUrlInput = await promptUserQuestion("Enter Prism Backend WebSocket URL (default: wss://api.tools.rod.dev): ");
  if (!backendUrlInput) {
    backendUrlInput = "wss://api.tools.rod.dev";
  }

  let secretInput = await promptUserQuestion("Enter your Prism API Access Token/Secret: ");
  while (!secretInput) {
    logger.warn("API Secret is required to connect to Prism.");
    secretInput = await promptUserQuestion("Enter your Prism API Access Token/Secret: ");
  }

  logger.info("Opening folder selection dialog…");
  let selectedWorkspaceFolder = selectDirectoryViaNativeDialog();

  if (selectedWorkspaceFolder) {
    logger.success(`Selected workspace directory: ${selectedWorkspaceFolder}`);
  } else {
    logger.info("No folder was selected from the dialog. Please enter the directory path manually.");
    const defaultWorkspacePath = resolve(process.cwd());
    const manualWorkspaceInput = await promptUserQuestion(`Enter local workspace directory path (default: ${defaultWorkspacePath}): `);
    selectedWorkspaceFolder = manualWorkspaceInput ? resolve(manualWorkspaceInput) : defaultWorkspacePath;
  }

  while (!existsSync(selectedWorkspaceFolder) || !statSync(selectedWorkspaceFolder).isDirectory()) {
    logger.error(`Workspace directory does not exist or is not a directory: ${selectedWorkspaceFolder}`);
    const manualWorkspaceInput = await promptUserQuestion("Enter workspace directory path: ");
    if (!manualWorkspaceInput) {
      continue;
    }
    selectedWorkspaceFolder = resolve(manualWorkspaceInput);
  }

  const configuration = {
    backend: backendUrlInput,
    secret: secretInput,
    workspace: [selectedWorkspaceFolder],
  };

  await writePersistentConfiguration(configuration);
  return configuration;
}

async function exitWithError(errorMessage) {
  logger.error(errorMessage);
  await waitForKeypressBeforeExit();
  process.exit(1);
}

async function main() {
  const cliOptions = parseArgs();

  if (cliOptions.help) { showHelp(); process.exit(0); }

  let backendUrl = cliOptions.backend || process.env.WORKSPACE_BACKEND;
  let workspacePaths = cliOptions.workspace || (process.env.WORKSPACE_ROOTS ? process.env.WORKSPACE_ROOTS.split(",").map((text) => text.trim()).filter(Boolean) : []);
  let secret = cliOptions.secret || process.env.WORKSPACE_SERVICE_SECRET;

  const isConfigurationIncomplete = !backendUrl || workspacePaths.length === 0 || !secret;
  if (isConfigurationIncomplete) {
    let configuration = await readPersistentConfiguration();
    if (configuration) {
      backendUrl = backendUrl || configuration.backend;
      workspacePaths = workspacePaths.length > 0 ? workspacePaths : (configuration.workspace || []);
      secret = secret || configuration.secret;
    }

    const isStillIncomplete = !backendUrl || workspacePaths.length === 0 || !secret;
    if (isStillIncomplete) {
      const configuration = await runInteractiveConfigurationWizard();
      backendUrl = backendUrl || configuration.backend;
      workspacePaths = workspacePaths.length > 0 ? workspacePaths : (configuration.workspace || []);
      secret = secret || configuration.secret;
    }
  }

  if (!backendUrl) { await exitWithError("Missing --backend flag, env var, or configuration. Use --help for usage."); }
  if (!workspacePaths || workspacePaths.length === 0) { await exitWithError("Missing --workspace flag, env var, or configuration. Use --help for usage."); }

  const roots = workspacePaths.map((path) => resolve(path));
  for (const root of roots) {
    if (!existsSync(root)) { await exitWithError(`Workspace path does not exist: ${root}`); }
    if (!statSync(root).isDirectory()) { await exitWithError(`Workspace path is not a directory: ${root}`); }
  }

  if (backendUrl.startsWith("http://")) backendUrl = backendUrl.replace("http://", "ws://");
  else if (backendUrl.startsWith("https://")) backendUrl = backendUrl.replace("https://", "wss://");
  if (!backendUrl.includes("/ws/agent")) backendUrl = backendUrl.replace(/\/+$/, "") + "/ws/agent";

  secret = secret || "";
  const agentName = cliOptions.name || hostname();

  logger.info("━━━ Workspace Agent ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  logger.info(`Name ............. ${agentName}`);
  logger.info(`Backend .......... ${backendUrl}`);
  logger.info(`Workspaces ....... ${roots.join(", ")}`);
  logger.info(`Auth ............. ${secret ? "secret configured" : "none"}`);
  logger.info(`Platform ......... ${process.platform} (Node ${process.version})`);
  logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const agent = new WorkspaceAgent({ backendUrl, roots, name: agentName, secret });
  agent.on("error", () => {}); // Prevent unhandled EventEmitter error crashes
  agent.connect();

  function shutdown(signal) {
    logger.info(`Received ${signal}, shutting down…`);
    agent.disconnect();
    setTimeout(() => process.exit(0), 500);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch(async (error) => {
  logger.error(`Failed to start workspace agent: ${error.message}`);
  await waitForKeypressBeforeExit();
  process.exit(1);
});
