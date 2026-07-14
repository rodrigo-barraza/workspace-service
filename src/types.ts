// ─── Centralized Types ─────────────────────────────────────

// ── JSON-RPC ─────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  // JSON-RPC 2.0 allows string OR number ids — never assume string methods on it
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

// ── Agent Client ────────────────────────────────────────────

export interface AgentClientOptions {
  backendUrl: string;
  roots: string[];
  name: string;
  secret: string;
  reconnectInterval?: number;
}

// ── RPC Method Handler ──────────────────────────────────────

export type RpcHandler = (params: Record<string, unknown>) => unknown | Promise<unknown>;
export type NotifyFn = (event: string, data: Record<string, unknown>) => void;

// ── File Operations ─────────────────────────────────────────

export interface ReadFileParams {
  path: string;
  startLine?: number;
  endLine?: number;
  raw?: boolean;
}

export interface WriteFileParams {
  path: string;
  content?: string;
  // Base64-encoded binary payload — takes precedence over `content`
  contentBase64?: string;
  createDirs?: boolean;
}

export interface StringReplaceParameters {
  path: string;
  oldString: string;
  newString: string;
  allowMultiple?: boolean;
}

export interface PatchFileParams {
  path: string;
  patch: string;
}

export interface FileInfoParams {
  paths: string | string[];
}

export interface FileDiffParams {
  pathA: string;
  pathB?: string;
  content?: string;
  contextLines?: number;
}

export interface MoveFileParams {
  source: string;
  destination: string;
  createDirs?: boolean;
}

export interface DeleteFileParams {
  path: string;
}

export interface MultiFileReadParams {
  files: Array<{ path: string; startLine?: number; endLine?: number }>;
}

export interface ListDirectoryParams {
  path: string;
  recursive?: boolean;
  maxDepth?: number;
}

export interface CreateDirectoryParams {
  path: string;
}

// ── Search Operations ───────────────────────────────────────

export interface GrepSearchParams {
  pattern: string;
  searchPath: string;
  isRegex?: boolean;
  includes?: string[];
  caseInsensitive?: boolean;
  matchPerLine?: boolean;
}

export interface GlobFilesParams {
  pattern: string;
  searchPath: string;
}

// ── Git Operations ──────────────────────────────────────────

export interface GitStatusParams {
  path: string;
}

export interface GitDiffParams {
  path: string;
  staged?: boolean;
  filePath?: string;
  ref?: string;
}

export interface GitLogParams {
  path: string;
  limit?: number;
  author?: string;
  since?: string;
  filePath?: string;
}

// ── Command Operations ──────────────────────────────────────

export interface CommandRunParams {
  command: string;
  cwd?: string;
  timeout?: number;
}

// ── Project Operations ──────────────────────────────────────

export interface ProjectSummaryParams {
  path: string;
  maxDepth?: number;
}

// ── Watch Operations ────────────────────────────────────────

export interface WatchParams {
  path: string;
  recursive?: boolean;
}

export type {
  FileInfoEntry,
  DirectoryEntry,
  TreeEntry,
  GitFileChange,
  GrepMatch,
  GlobMatch,
  PathValidationResult as PathValidation,
} from "@rodrigo-barraza/utilities-library";


