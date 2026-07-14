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

export type AgentConnectionStatus = "connected" | "disconnected" | "connecting" | "auth-failed";

export interface AgentStatusInfo {
  connectionStatus: AgentConnectionStatus;
  // A running child that is reconnecting is still "running" — UI enablement
  // (Disconnect button) keys off this, while status dots key off
  // connectionStatus. Conflating the two is what made the old UI lie.
  processRunning: boolean;
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
