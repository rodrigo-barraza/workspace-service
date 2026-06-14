import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";

contextBridge.exposeInMainWorld("prismAgent", {
  openFolderDialog: () => ipcRenderer.invoke(IPC_CHANNELS.OPEN_FOLDER_DIALOG),
  completeSetup: (configuration: Record<string, unknown>) =>
    ipcRenderer.invoke(IPC_CHANNELS.SETUP_COMPLETE, configuration),
});
