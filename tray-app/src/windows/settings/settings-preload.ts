import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";

contextBridge.exposeInMainWorld("prismAgent", {
  getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.GET_CONFIG),
  setConfig: (partialConfiguration: Record<string, unknown>) =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_CONFIG, partialConfiguration),
  resetConfig: () => ipcRenderer.invoke(IPC_CHANNELS.RESET_CONFIG),
  agentStart: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_START),
  agentStop: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_STOP),
  agentRestart: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_RESTART),
  agentStatus: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_STATUS),
  openFolderDialog: () => ipcRenderer.invoke(IPC_CHANNELS.OPEN_FOLDER_DIALOG),
  getLogs: () => ipcRenderer.invoke(IPC_CHANNELS.LOG_GET_ALL),
  getAutoLaunch: () => ipcRenderer.invoke(IPC_CHANNELS.GET_AUTO_LAUNCH),
  setAutoLaunch: (isEnabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_AUTO_LAUNCH, isEnabled),
});
