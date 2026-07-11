// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Prism Workspace Connector — Electron Main Process
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { app, ipcMain, dialog, BrowserWindow } from "electron";
import { initializeTray, openSetupWindow } from "./tray/TrayManager.js";
import { agentProcess } from "./agent/AgentProcess.js";
import {
  getConfiguration,
  setConfiguration,
  hasValidConfiguration,
  resetConfiguration,
} from "./config/ConfigStore.js";
import { IPC_CHANNELS } from "./shared/ipc-channels.js";
import { detectWslDistros, checkNodeInDistro } from "./agent/WslDetector.js";

const isHiddenLaunch = process.argv.includes("--hidden");

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on("second-instance", () => {
  // If a second instance is launched, do nothing — tray is already running
});

// Prevent the app from quitting when all windows are closed (tray-only mode)
app.on("window-all-closed", () => {
  // Intentionally empty — prevent quit on window close (tray-only app)
});

// ────────────────────────────────────────────────────────────
// IPC Handlers
// ────────────────────────────────────────────────────────────

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.GET_CONFIG, () => {
    return getConfiguration();
  });

  ipcMain.handle(IPC_CHANNELS.SET_CONFIG, (_event, partialConfiguration) => {
    setConfiguration(partialConfiguration);
    return getConfiguration();
  });

  ipcMain.handle(IPC_CHANNELS.RESET_CONFIG, () => {
    resetConfiguration();
    return getConfiguration();
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_START, () => {
    const configuration = getConfiguration();
    agentProcess.start(configuration);
    return agentProcess.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_STOP, () => {
    agentProcess.stop();
    return agentProcess.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_RESTART, () => {
    agentProcess.restart();
    return agentProcess.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_STATUS, () => {
    return agentProcess.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_FOLDER_DIALOG, async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: Electron.OpenDialogOptions = {
      title: "Select Workspace Directory",
      properties: ["openDirectory"],
    };
    const openDialogResult = parentWindow
      ? await dialog.showOpenDialog(parentWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (openDialogResult.canceled || openDialogResult.filePaths.length === 0) {
      return null;
    }
    return openDialogResult.filePaths[0];
  });

  ipcMain.handle(IPC_CHANNELS.SETUP_COMPLETE, (_event, configuration) => {
    setConfiguration(configuration);
    const savedConfiguration = getConfiguration();
    agentProcess.start(savedConfiguration);
    return savedConfiguration;
  });

  ipcMain.handle(IPC_CHANNELS.LOG_GET_ALL, () => {
    return agentProcess.getLogs();
  });

  ipcMain.handle(IPC_CHANNELS.GET_AUTO_LAUNCH, () => {
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.handle(IPC_CHANNELS.SET_AUTO_LAUNCH, (_event, isEnabled: boolean) => {
    app.setLoginItemSettings({
      openAtLogin: isEnabled,
      openAsHidden: true,
      args: ["--hidden"],
    });
    setConfiguration({ openAtLogin: isEnabled });
    return isEnabled;
  });

  ipcMain.handle(IPC_CHANNELS.WSL_DETECT_DISTROS, async () => {
    return detectWslDistros();
  });

  ipcMain.handle(IPC_CHANNELS.WSL_CHECK_NODE, async (_event, distroName: string) => {
    return checkNodeInDistro(distroName);
  });
}

// ────────────────────────────────────────────────────────────
// App Lifecycle
// ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Hide from dock on macOS (tray-only app)
  if (process.platform === "darwin") {
    app.dock?.hide();
  }

  registerIpcHandlers();
  initializeTray();

  // Reconcile OS-level login item with stored preference on every startup.
  // This ensures the tray app re-registers itself if the OS login item was
  // lost (e.g. reinstall, OS update, or manual registry/plist removal).
  if (hasValidConfiguration()) {
    const configuration = getConfiguration();
    const currentLoginSettings = app.getLoginItemSettings();
    if (configuration.openAtLogin && !currentLoginSettings.openAtLogin) {
      app.setLoginItemSettings({
        openAtLogin: true,
        openAsHidden: true,
        args: ["--hidden"],
      });
    } else if (!configuration.openAtLogin && currentLoginSettings.openAtLogin) {
      app.setLoginItemSettings({ openAtLogin: false });
    }
  }

  if (hasValidConfiguration()) {
    // Config exists — start agent immediately
    const configuration = getConfiguration();
    agentProcess.start(configuration);
  } else if (!isHiddenLaunch) {
    // No config — show the setup wizard
    await openSetupWindow();

    // After wizard closes, check if config was saved
    if (hasValidConfiguration()) {
      const configuration = getConfiguration();
      agentProcess.start(configuration);
    }
  }
});

app.on("before-quit", () => {
  agentProcess.stop();
});
