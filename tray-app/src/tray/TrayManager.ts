import { Tray, Menu, nativeImage, app, dialog, BrowserWindow, Notification } from "electron";
import { resolve } from "node:path";
import { agentProcess } from "../agent/AgentProcess.js";
import { wslUncPathToLinuxPath } from "../agent/WslDetector.js";
import { getConfiguration, setConfiguration, hasValidConfiguration } from "../config/ConfigStore.js";
import type { AgentConnectionStatus } from "../shared/types.js";

const TRAY_ICON_SIZE = 16;

function getIconPath(iconName: string): string {
  return resolve(import.meta.dirname, "../../assets/tray", iconName);
}

function createTrayIcon(iconName: string): Electron.NativeImage {
  const iconPath = getIconPath(iconName);
  try {
    const image = nativeImage.createFromPath(iconPath);
    return image.resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
  } catch {
    return nativeImage.createEmpty();
  }
}

const STATUS_ICONS: Record<AgentConnectionStatus, string> = {
  connected: "tray-connected.png",
  disconnected: "tray-disconnected.png",
  connecting: "tray-connecting.png",
};

const STATUS_LABELS: Record<AgentConnectionStatus, string> = {
  connected: "Connected",
  disconnected: "Disconnected",
  connecting: "Connecting…",
};

let tray: Tray | null = null;
let settingsWindow: BrowserWindow | null = null;
let currentStatus: AgentConnectionStatus = "disconnected";

function buildContextMenu(): Menu {
  const configuration = getConfiguration();
  const isRunning = agentProcess.isRunning();
  const isAutoLaunchEnabled = app.getLoginItemSettings().openAtLogin;

  const backendLabel = configuration.backendUrl
    ? configuration.backendUrl.replace(/^wss?:\/\//, "").replace(/\/ws\/agent$/, "")
    : "Not configured";

  const wslDistro = configuration.wslDistro?.trim();
  const modeLabel = wslDistro ? `WSL2 (${wslDistro})` : "Native";

  return Menu.buildFromTemplate([
    {
      label: `Status: ${STATUS_LABELS[currentStatus]}`,
      enabled: false,
      icon: createTrayIcon(STATUS_ICONS[currentStatus]),
    },
    {
      label: `Backend: ${backendLabel}`,
      enabled: false,
    },
    {
      label: `Mode: ${modeLabel}`,
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Connect",
      enabled: !isRunning && hasValidConfiguration(),
      click: () => {
        const latestConfiguration = getConfiguration();
        agentProcess.start(latestConfiguration);
      },
    },
    {
      label: "Disconnect",
      enabled: isRunning,
      click: () => {
        agentProcess.stop();
      },
    },
    { type: "separator" },
    {
      label: "Change Workspace…",
      click: async () => {
        const result = await dialog.showOpenDialog({
          title: "Select Workspace Directory",
          properties: ["openDirectory"],
          defaultPath: configuration.workspaceRoots[0] || undefined,
        });
        if (!result.canceled && result.filePaths.length > 0) {
          const configurationUpdate: Record<string, unknown> = { workspaceRoots: result.filePaths };

          if (wslDistro) {
            const uncResult = wslUncPathToLinuxPath(result.filePaths[0]);
            configurationUpdate.wslLinuxPaths = uncResult ? [uncResult.linuxPath] : result.filePaths;
          }

          setConfiguration(configurationUpdate);
          if (isRunning) {
            agentProcess.restart();
          }
          rebuildMenu();
          showNotification("Workspace Changed", `Now syncing: ${result.filePaths[0]}`);
        }
      },
    },
    {
      label: "Settings…",
      click: () => openSettingsWindow(),
    },
    { type: "separator" },
    {
      label: "Open on Startup",
      type: "checkbox",
      checked: isAutoLaunchEnabled,
      click: (menuItem) => {
        app.setLoginItemSettings({
          openAtLogin: menuItem.checked,
          openAsHidden: true,
          args: ["--hidden"],
        });
        setConfiguration({ openAtLogin: menuItem.checked });
      },
    },
    { type: "separator" },
    {
      label: "Quit Prism Agent",
      click: () => {
        agentProcess.stop();
        app.quit();
      },
    },
  ]);
}

function rebuildMenu(): void {
  if (tray) {
    tray.setContextMenu(buildContextMenu());
  }
}

function updateTrayIcon(status: AgentConnectionStatus): void {
  currentStatus = status;
  if (tray) {
    tray.setImage(createTrayIcon(STATUS_ICONS[status]));
    tray.setToolTip(`Prism Workspace — ${STATUS_LABELS[status]}`);
    rebuildMenu();
  }
}

function showNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

function openSettingsWindow(): void {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 520,
    height: 700,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Prism Workspace — Settings",
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolve(import.meta.dirname, "../windows/settings/settings-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const settingsHtmlPath = resolve(import.meta.dirname, "../windows/settings/settings.html");
  settingsWindow.loadFile(settingsHtmlPath);

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

export function openSetupWindow(): Promise<void> {
  return new Promise((resolvePromise) => {
    const setupWindow = new BrowserWindow({
      width: 500,
      height: 600,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      title: "Prism Workspace — Setup",
      autoHideMenuBar: true,
      webPreferences: {
        preload: resolve(import.meta.dirname, "../windows/setup/setup-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const setupHtmlPath = resolve(import.meta.dirname, "../windows/setup/setup.html");
    setupWindow.loadFile(setupHtmlPath);

    setupWindow.on("closed", () => {
      resolvePromise();
    });
  });
}

export function initializeTray(): void {
  tray = new Tray(createTrayIcon(STATUS_ICONS.disconnected));
  tray.setToolTip("Prism Workspace — Disconnected");
  tray.setContextMenu(buildContextMenu());

  agentProcess.on("status-changed", (status: AgentConnectionStatus) => {
    const previousStatus = currentStatus;
    updateTrayIcon(status);

    if (status === "connected") {
      showNotification("Prism Workspace", "Connected successfully");
    } else if (status === "disconnected" && previousStatus === "connected") {
      showNotification("Prism Workspace", "Disconnected");
    }
  });

  if (process.platform === "win32") {
    tray.on("click", () => {
      tray?.popUpContextMenu();
    });
  }
}
