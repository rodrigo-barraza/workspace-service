const { contextBridge, ipcRenderer } = require("electron");

const IPC_CHANNELS = {
  OPEN_FOLDER_DIALOG: "dialog:open-folder",
  SETUP_COMPLETE: "setup:complete",
  SET_AUTO_LAUNCH: "autolaunch:set",
};

contextBridge.exposeInMainWorld("prismAgent", {
  openFolderDialog: () => ipcRenderer.invoke(IPC_CHANNELS.OPEN_FOLDER_DIALOG),
  completeSetup: (configuration) =>
    ipcRenderer.invoke(IPC_CHANNELS.SETUP_COMPLETE, configuration),
  setAutoLaunch: (isEnabled) =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_AUTO_LAUNCH, isEnabled),
});
