const { contextBridge, ipcRenderer } = require("electron");

const IPC_CHANNELS = {
  OPEN_FOLDER_DIALOG: "dialog:open-folder",
  SETUP_COMPLETE: "setup:complete",
};

contextBridge.exposeInMainWorld("prismAgent", {
  openFolderDialog: () => ipcRenderer.invoke(IPC_CHANNELS.OPEN_FOLDER_DIALOG),
  completeSetup: (configuration) =>
    ipcRenderer.invoke(IPC_CHANNELS.SETUP_COMPLETE, configuration),
});
