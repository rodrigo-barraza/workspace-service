const { contextBridge, ipcRenderer } = require("electron");

const IPC_CHANNELS = {
  OPEN_FOLDER_DIALOG: "dialog:open-folder",
  SETUP_COMPLETE: "setup:complete",
  SET_AUTO_LAUNCH: "autolaunch:set",
  STATUS_CHANGED: "agent:status-changed",
  WSL_DETECT_DISTROS: "wsl:detect-distros",
  WSL_CHECK_NODE: "wsl:check-node",
};

contextBridge.exposeInMainWorld("prismAgent", {
  openFolderDialog: () => ipcRenderer.invoke(IPC_CHANNELS.OPEN_FOLDER_DIALOG),
  completeSetup: (configuration) =>
    ipcRenderer.invoke(IPC_CHANNELS.SETUP_COMPLETE, configuration),
  setAutoLaunch: (isEnabled) =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_AUTO_LAUNCH, isEnabled),
  detectWslDistros: () =>
    ipcRenderer.invoke(IPC_CHANNELS.WSL_DETECT_DISTROS),
  checkWslNode: (distroName) =>
    ipcRenderer.invoke(IPC_CHANNELS.WSL_CHECK_NODE, distroName),
  onStatusChanged: (callback) => {
    ipcRenderer.on(IPC_CHANNELS.STATUS_CHANGED, (_event, status) => callback(status));
  },
});
