export const IPC_CHANNELS = {
  GET_CONFIG: "config:get",
  SET_CONFIG: "config:set",
  RESET_CONFIG: "config:reset",
  AGENT_START: "agent:start",
  AGENT_STOP: "agent:stop",
  AGENT_RESTART: "agent:restart",
  AGENT_STATUS: "agent:status",
  OPEN_FOLDER_DIALOG: "dialog:open-folder",
  SETUP_COMPLETE: "setup:complete",
  LOG_ENTRY: "log:entry",
  STATUS_CHANGED: "agent:status-changed",
  LOG_GET_ALL: "log:get-all",
  GET_AUTO_LAUNCH: "autolaunch:get",
  SET_AUTO_LAUNCH: "autolaunch:set",
  WSL_DETECT_DISTROS: "wsl:detect-distros",
  WSL_CHECK_NODE: "wsl:check-node",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
