import Store from "electron-store";
import { safeStorage } from "electron";
import { hostname } from "node:os";
import type { AgentConfiguration } from "../shared/types.js";

const ENCRYPTED_SECRET_PREFIX = "encrypted:";

const configurationSchema = {
  backendUrl: { type: "string" as const, default: "wss://api.tools.rod.dev" },
  encryptedSecret: { type: "string" as const, default: "" },
  workspaceRoots: { type: "array" as const, default: [] as string[], items: { type: "string" as const } },
  agentName: { type: "string" as const, default: hostname() },
  openAtLogin: { type: "boolean" as const, default: true },
};

const store = new Store({ schema: configurationSchema, name: "prism-workspace-agent" });

function encryptSecret(plainTextSecret: string): string {
  if (!plainTextSecret) return "";
  if (safeStorage.isEncryptionAvailable()) {
    const encryptedBuffer = safeStorage.encryptString(plainTextSecret);
    return ENCRYPTED_SECRET_PREFIX + encryptedBuffer.toString("base64");
  }
  return plainTextSecret;
}

function decryptSecret(storedSecret: string): string {
  if (!storedSecret) return "";
  if (storedSecret.startsWith(ENCRYPTED_SECRET_PREFIX) && safeStorage.isEncryptionAvailable()) {
    const base64Data = storedSecret.slice(ENCRYPTED_SECRET_PREFIX.length);
    const encryptedBuffer = Buffer.from(base64Data, "base64");
    return safeStorage.decryptString(encryptedBuffer);
  }
  return storedSecret;
}

export function getConfiguration(): AgentConfiguration {
  return {
    backendUrl: store.get("backendUrl") as string,
    secret: decryptSecret(store.get("encryptedSecret") as string),
    workspaceRoots: store.get("workspaceRoots") as string[],
    agentName: store.get("agentName") as string,
    openAtLogin: store.get("openAtLogin") as boolean,
  };
}

export function setConfiguration(partialConfiguration: Partial<AgentConfiguration>): void {
  if (partialConfiguration.backendUrl !== undefined) {
    store.set("backendUrl", partialConfiguration.backendUrl);
  }
  if (partialConfiguration.secret !== undefined) {
    store.set("encryptedSecret", encryptSecret(partialConfiguration.secret));
  }
  if (partialConfiguration.workspaceRoots !== undefined) {
    store.set("workspaceRoots", partialConfiguration.workspaceRoots);
  }
  if (partialConfiguration.agentName !== undefined) {
    store.set("agentName", partialConfiguration.agentName);
  }
  if (partialConfiguration.openAtLogin !== undefined) {
    store.set("openAtLogin", partialConfiguration.openAtLogin);
  }
}

export function hasValidConfiguration(): boolean {
  const configuration = getConfiguration();
  return !!(
    configuration.backendUrl &&
    configuration.secret &&
    configuration.workspaceRoots.length > 0
  );
}

export function resetConfiguration(): void {
  store.clear();
}
