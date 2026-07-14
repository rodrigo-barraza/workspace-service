// ─── Prism FileSystemProvider ───────────────────────────────
// Maps VS Code's FileSystemProvider interface to workspace-service
// JSON-RPC calls (file.read, file.write, directory.list, etc.)

import * as vscode from "vscode";
import { RpcClient } from "./RpcClient.js";

// ────────────────────────────────────────────────────────────
// Types — RPC Response Shapes
// ────────────────────────────────────────────────────────────

interface FileReadResult {
  filePath: string;
  content: string;
  contentBase64?: string;
  totalBytes: number;
  totalLines: number;
  isBinary?: boolean;
  lastModified?: string;
  error?: string;
}

interface FileWriteResult {
  filePath: string;
  created: boolean;
  overwritten: boolean;
  bytesWritten: number;
  error?: string;
}

interface FileInfoResult {
  path: string;
  exists: boolean;
  isFile: boolean;
  isDirectory: boolean;
  sizeBytes: number;
  lastModified: string;
  error?: string;
}

interface DirListResult {
  directory: string;
  totalEntries: number;
  entries: Array<{
    name: string;
    path: string;
    isDir: boolean;
    sizeBytes?: number;
  }>;
  error?: string;
}

interface DirCreateResult {
  path: string;
  created: boolean;
  error?: string;
}

interface FileMoveResult {
  source: string;
  destination: string;
  success: boolean;
  error?: string;
}

interface FileDeleteResult {
  filePath: string;
  deleted: boolean;
  error?: string;
}

// ────────────────────────────────────────────────────────────
// FileSystemProvider
// ────────────────────────────────────────────────────────────

export class WorkspaceFileSystem implements vscode.FileSystemProvider {
  static readonly scheme = "wsremote";

  private rpc: RpcClient;

  // VS Code requires these event emitters for cache invalidation
  private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  constructor(rpc: RpcClient) {
    this.rpc = rpc;
  }

  /** Swap the underlying RPC client (e.g. after reconnect) */
  setRpcClient(rpc: RpcClient): void {
    this.rpc = rpc;
  }

  // ──────────────────────────────────────────────────────────
  // Stat
  // ──────────────────────────────────────────────────────────

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const result = await this.rpc.call<FileInfoResult>("file.info", {
      paths: uri.path,
    });

    if (result.error || !result.exists) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    const type = result.isDirectory
      ? vscode.FileType.Directory
      : vscode.FileType.File;

    const mtime = result.lastModified
      ? new Date(result.lastModified).getTime()
      : Date.now();

    return {
      type,
      ctime: mtime,
      mtime,
      size: result.sizeBytes || 0,
    };
  }

  // ──────────────────────────────────────────────────────────
  // Read Directory
  // ──────────────────────────────────────────────────────────

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const result = await this.rpc.call<DirListResult>("directory.list", {
      path: uri.path,
      recursive: false,
    });

    if (result.error) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    return result.entries.map((entry) => [
      entry.name,
      entry.isDir ? vscode.FileType.Directory : vscode.FileType.File,
    ]);
  }

  // ──────────────────────────────────────────────────────────
  // Read File
  // ──────────────────────────────────────────────────────────

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const result = await this.rpc.call<FileReadResult>("file.read", {
      path: uri.path,
      raw: true,
    });

    if (result.error) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    // Binary files return base64
    if (result.isBinary && result.contentBase64) {
      return Buffer.from(result.contentBase64, "base64");
    }

    // Text files return UTF-8
    return Buffer.from(result.content, "utf-8");
  }

  // ──────────────────────────────────────────────────────────
  // Write File
  // ──────────────────────────────────────────────────────────

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    // Check if file exists for create/overwrite validation
    if (!options.overwrite || !options.create) {
      try {
        await this.stat(uri);
        if (!options.overwrite) {
          throw vscode.FileSystemError.FileExists(uri);
        }
      } catch (e) {
        if (e instanceof vscode.FileSystemError && e.code === "FileNotFound") {
          if (!options.create) {
            throw vscode.FileSystemError.FileNotFound(uri);
          }
        } else {
          throw e;
        }
      }
    }

    // Detect binary payloads — coercing them through UTF-8 corrupts bytes
    // that aren't valid UTF-8 sequences. A round-trip comparison catches this.
    const contentBuffer = Buffer.from(content);
    const utf8RoundTrip = Buffer.from(contentBuffer.toString("utf-8"), "utf-8");
    const isBinary = Buffer.compare(utf8RoundTrip, contentBuffer) !== 0;

    const result = await this.rpc.call<FileWriteResult>(
      "file.write",
      isBinary
        ? {
            path: uri.path,
            contentBase64: contentBuffer.toString("base64"),
            createDirs: true,
          }
        : {
            path: uri.path,
            content: contentBuffer.toString("utf-8"),
            createDirs: true,
          },
    );

    if (result.error) {
      throw vscode.FileSystemError.Unavailable(result.error);
    }

    // Fire change event so VS Code refreshes the explorer tree
    this._onDidChangeFile.fire([
      {
        type: result.created
          ? vscode.FileChangeType.Created
          : vscode.FileChangeType.Changed,
        uri,
      },
    ]);
  }

  // ──────────────────────────────────────────────────────────
  // Delete
  // ──────────────────────────────────────────────────────────

  async delete(uri: vscode.Uri): Promise<void> {
    const result = await this.rpc.call<FileDeleteResult>("file.delete", {
      path: uri.path,
    });

    if (result.error) {
      throw vscode.FileSystemError.Unavailable(result.error);
    }

    this._onDidChangeFile.fire([
      { type: vscode.FileChangeType.Deleted, uri },
    ]);
  }

  // ──────────────────────────────────────────────────────────
  // Rename / Move
  // ──────────────────────────────────────────────────────────

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { overwrite: boolean },
  ): Promise<void> {
    if (!options.overwrite) {
      try {
        await this.stat(newUri);
        throw vscode.FileSystemError.FileExists(newUri);
      } catch (e) {
        if (!(e instanceof vscode.FileSystemError && e.code === "FileNotFound")) {
          throw e;
        }
      }
    }

    const result = await this.rpc.call<FileMoveResult>("file.move", {
      source: oldUri.path,
      destination: newUri.path,
    });

    if (result.error) {
      throw vscode.FileSystemError.Unavailable(result.error);
    }

    this._onDidChangeFile.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);
  }

  // ──────────────────────────────────────────────────────────
  // Create Directory
  // ──────────────────────────────────────────────────────────

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const result = await this.rpc.call<DirCreateResult>("directory.create", {
      path: uri.path,
    });

    if (result.error) {
      throw vscode.FileSystemError.Unavailable(result.error);
    }

    this._onDidChangeFile.fire([
      { type: vscode.FileChangeType.Created, uri },
    ]);
  }

  // ──────────────────────────────────────────────────────────
  // Watch
  // ──────────────────────────────────────────────────────────

  // Server-side subscriptions, refcounted per path so disposing one watcher
  // doesn't kill sibling watchers, and replayable after a reconnect (the
  // server loses all subscriptions when the socket drops).
  private watchSubscriptions = new Map<string, { recursive: boolean; count: number }>();

  watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
    const watchPath = uri.path;
    const existing = this.watchSubscriptions.get(watchPath);

    if (existing) {
      existing.count++;
      // Upgrade to recursive if a new watcher needs it
      if (options.recursive && !existing.recursive) {
        existing.recursive = true;
        this.rpc.call("watch.subscribe", {
          path: watchPath,
          recursive: true,
        }).catch(() => {});
      }
    } else {
      this.watchSubscriptions.set(watchPath, { recursive: options.recursive, count: 1 });

      // Subscribe to remote file-system changes
      this.rpc.call("watch.subscribe", {
        path: watchPath,
        recursive: options.recursive,
      }).catch(() => {
        // Non-fatal — watching is best-effort
      });
    }

    let disposed = false;
    return new vscode.Disposable(() => {
      if (disposed) return;
      disposed = true;

      const entry = this.watchSubscriptions.get(watchPath);
      if (!entry) return;

      entry.count--;
      if (entry.count <= 0) {
        // Last watcher on this path — safe to unsubscribe server-side
        this.watchSubscriptions.delete(watchPath);
        this.rpc.call("watch.unsubscribe", {
          path: watchPath,
        }).catch(() => {});
      }
    });
  }

  /** Replay all active watch subscriptions — call after (re)connecting */
  resubscribeWatchers(): void {
    for (const [watchPath, entry] of this.watchSubscriptions) {
      this.rpc.call("watch.subscribe", {
        path: watchPath,
        recursive: entry.recursive,
      }).catch(() => {});
    }
  }

  // ──────────────────────────────────────────────────────────
  // External: fire change events from watch.changed notifications
  // ──────────────────────────────────────────────────────────

  fireExternalChange(rootPath: string, filename: string | null, eventType: string): void {
    if (!filename) return;

    const uri = vscode.Uri.from({
      scheme: WorkspaceFileSystem.scheme,
      path: rootPath.endsWith("/") ? rootPath + filename : rootPath + "/" + filename,
    });

    const changeType = eventType === "rename"
      ? vscode.FileChangeType.Created  // Could be create or delete — VS Code will stat to confirm
      : vscode.FileChangeType.Changed;

    this._onDidChangeFile.fire([{ type: changeType, uri }]);
  }
}
