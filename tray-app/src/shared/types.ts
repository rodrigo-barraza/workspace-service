export interface AgentConfiguration {
  backendUrl: string;
  secret: string;
  workspaceRoots: string[];
  agentName: string;
  openAtLogin: boolean;
  wslDistro: string;
  wslLinuxPaths: string[];
}

export interface WslDistroInfo {
  name: string;
  state: "Running" | "Stopped" | "Installing" | "Unknown";
  version: number;
  isDefault: boolean;
}

export type AgentConnectionStatus = "connected" | "disconnected" | "connecting";

export interface AgentStatusInfo {
  connectionStatus: AgentConnectionStatus;
  reconnectAttempts: number;
  agentId: string | null;
  backendUrl: string | null;
  roots: string[];
  name: string | null;
}

export interface LogEntry {
  timestamp: string;
  level: "info" | "success" | "warn" | "error" | "rpc";
  message: string;
}
