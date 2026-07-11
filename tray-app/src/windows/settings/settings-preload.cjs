const { contextBridge, ipcRenderer } = require("electron");

const IPC_CHANNELS = {
  GET_CONFIG: "config:get",
  SET_CONFIG: "config:set",
  RESET_CONFIG: "config:reset",
  AGENT_START: "agent:start",
  AGENT_STOP: "agent:stop",
  AGENT_RESTART: "agent:restart",
  AGENT_STATUS: "agent:status",
  OPEN_FOLDER_DIALOG: "dialog:open-folder",
  LOG_GET_ALL: "log:get-all",
  GET_AUTO_LAUNCH: "autolaunch:get",
  SET_AUTO_LAUNCH: "autolaunch:set",
  WSL_DETECT_DISTROS: "wsl:detect-distros",
  WSL_CHECK_NODE: "wsl:check-node",
};

contextBridge.exposeInMainWorld("prismAgent", {
  getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.GET_CONFIG),
  setConfig: (partialConfiguration) =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_CONFIG, partialConfiguration),
  resetConfig: () => ipcRenderer.invoke(IPC_CHANNELS.RESET_CONFIG),
  agentStart: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_START),
  agentStop: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_STOP),
  agentRestart: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_RESTART),
  agentStatus: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_STATUS),
  openFolderDialog: () => ipcRenderer.invoke(IPC_CHANNELS.OPEN_FOLDER_DIALOG),
  getLogs: () => ipcRenderer.invoke(IPC_CHANNELS.LOG_GET_ALL),
  getAutoLaunch: () => ipcRenderer.invoke(IPC_CHANNELS.GET_AUTO_LAUNCH),
  setAutoLaunch: (isEnabled) =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_AUTO_LAUNCH, isEnabled),
  detectWslDistros: () =>
    ipcRenderer.invoke(IPC_CHANNELS.WSL_DETECT_DISTROS),
  checkWslNode: (distroName) =>
    ipcRenderer.invoke(IPC_CHANNELS.WSL_CHECK_NODE, distroName),
});
