// ─── Workspace Remote Terminal ──────────────────────────────
// Provides a VS Code Pseudoterminal backed by workspace-service's
// command.run RPC. Enables running shell commands on the remote
// workspace directly from VS Code's integrated terminal.

import * as vscode from "vscode";
import { RpcClient, RpcConnectionHolder } from "./RpcClient.js";

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  executionTimeMs: number;
  error?: string;
}

// ────────────────────────────────────────────────────────────
// Terminal Profile Provider
// ────────────────────────────────────────────────────────────

export class WorkspaceTerminalProvider implements vscode.TerminalProfileProvider {
  // Registered once at activation — the connection holder is read when a
  // terminal profile is requested, so connect/reconnect can swap the RPC
  // client without re-registering the provider (which throws).
  constructor(
    private connection: RpcConnectionHolder,
  ) {}

  provideTerminalProfile(
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.TerminalProfile> {
    return new vscode.TerminalProfile({
      name: "Workspace Remote",
      pty: new WorkspacePseudoterminal(this.connection.rpc, this.connection.workspaceRoot),
      iconPath: new vscode.ThemeIcon("remote"),
    });
  }
}

// ────────────────────────────────────────────────────────────
// Pseudoterminal
// ────────────────────────────────────────────────────────────

class WorkspacePseudoterminal implements vscode.Pseudoterminal {
  private writeEmitter = new vscode.EventEmitter<string>();
  private closeEmitter = new vscode.EventEmitter<number | void>();
  onDidWrite = this.writeEmitter.event;
  onDidClose = this.closeEmitter.event;

  private inputBuffer = "";
  private cwd: string;
  private history: string[] = [];
  private historyIndex = -1;

  constructor(
    private rpc: RpcClient,
    workspaceRoot: string,
  ) {
    this.cwd = workspaceRoot;
  }

  open(): void {
    this.writeEmitter.fire(
      "\x1b[1;36m╔══════════════════════════════════════════╗\x1b[0m\r\n" +
      "\x1b[1;36m║   Workspace Remote Terminal              ║\x1b[0m\r\n" +
      "\x1b[1;36m║   Connected to workspace-service         ║\x1b[0m\r\n" +
      "\x1b[1;36m╚══════════════════════════════════════════╝\x1b[0m\r\n\r\n",
    );
    this._prompt();
  }

  close(): void {
    // Nothing to clean up
  }

  handleInput(data: string): void {
    // Handle special keys
    if (data === "\r") {
      // Enter
      this.writeEmitter.fire("\r\n");
      const command = this.inputBuffer.trim();
      this.inputBuffer = "";
      this.historyIndex = -1;

      if (command) {
        this.history.unshift(command);
        if (this.history.length > 100) this.history.pop();
        this._executeCommand(command);
      } else {
        this._prompt();
      }
    } else if (data === "\x7f") {
      // Backspace
      if (this.inputBuffer.length > 0) {
        this.inputBuffer = this.inputBuffer.slice(0, -1);
        this.writeEmitter.fire("\b \b");
      }
    } else if (data === "\x03") {
      // Ctrl+C
      this.inputBuffer = "";
      this.writeEmitter.fire("^C\r\n");
      this._prompt();
    } else if (data === "\x1b[A") {
      // Up arrow — history
      if (this.historyIndex < this.history.length - 1) {
        this.historyIndex++;
        this._replaceInput(this.history[this.historyIndex]);
      }
    } else if (data === "\x1b[B") {
      // Down arrow — history
      if (this.historyIndex > 0) {
        this.historyIndex--;
        this._replaceInput(this.history[this.historyIndex]);
      } else if (this.historyIndex === 0) {
        this.historyIndex = -1;
        this._replaceInput("");
      }
    } else {
      // Printable input — single keystrokes or pasted chunks (multi-character).
      // Strip ANSI escape sequences and control characters so pastes (and
      // unhandled cursor keys) don't corrupt the input buffer.
      const printable = data
        .replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, "")
        .replace(/[\x00-\x1f\x7f]/g, "");
      if (printable.length > 0) {
        this.inputBuffer += printable;
        this.writeEmitter.fire(printable);
      }
    }
  }

  private _replaceInput(text: string): void {
    // Clear current input
    const clearSeq = "\b \b".repeat(this.inputBuffer.length);
    this.writeEmitter.fire(clearSeq);
    this.inputBuffer = text;
    this.writeEmitter.fire(text);
  }

  private _prompt(): void {
    // Show abbreviated cwd
    const shortCwd = this.cwd.length > 40
      ? "..." + this.cwd.slice(-37)
      : this.cwd;

    this.writeEmitter.fire(`\x1b[1;32mprism\x1b[0m:\x1b[1;34m${shortCwd}\x1b[0m$ `);
  }

  private async _executeCommand(command: string): Promise<void> {
    // Handle cd specially
    if (command.startsWith("cd ")) {
      const target = command.slice(3).trim();
      if (target.startsWith("/")) {
        this.cwd = target;
      } else if (target === "..") {
        this.cwd = this.cwd.replace(/\/[^/]+$/, "") || "/";
      } else {
        this.cwd = this.cwd + "/" + target;
      }
      this._prompt();
      return;
    }

    if (command === "exit") {
      this.closeEmitter.fire(0);
      return;
    }

    try {
      const result = await this.rpc.call<CommandResult>("command.run", {
        command,
        cwd: this.cwd,
        timeout: 60_000,
      }, 65_000);

      if (result.stdout) {
        // Convert \n to \r\n for terminal display
        this.writeEmitter.fire(result.stdout.replace(/\n/g, "\r\n"));
        if (!result.stdout.endsWith("\n")) {
          this.writeEmitter.fire("\r\n");
        }
      }

      if (result.stderr) {
        this.writeEmitter.fire("\x1b[31m" + result.stderr.replace(/\n/g, "\r\n") + "\x1b[0m");
        if (!result.stderr.endsWith("\n")) {
          this.writeEmitter.fire("\r\n");
        }
      }

      if (result.error) {
        this.writeEmitter.fire(`\x1b[31mError: ${result.error}\x1b[0m\r\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.writeEmitter.fire(`\x1b[31mRPC Error: ${msg}\x1b[0m\r\n`);
    }

    this._prompt();
  }
}
