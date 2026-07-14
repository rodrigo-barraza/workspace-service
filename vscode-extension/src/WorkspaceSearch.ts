// ─── Workspace Remote Search Commands ───────────────────────────
// Provides search capabilities through VS Code commands rather
// than the proposed FileSearchProvider/TextSearchProvider APIs.
// Uses the stable QuickPick API for file search and outputs
// text search results to an output channel.

import * as vscode from "vscode";
import { RpcConnectionHolder } from "./RpcClient.js";
import { WorkspaceFileSystem } from "./WorkspaceFileSystem.js";

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

interface GrepResult {
  pattern: string;
  searchPath: string;
  totalMatches: number;
  truncated: boolean;
  results: Array<{
    file: string;
    line: number;
    content: string;
  }>;
  error?: string;
}

interface GlobResult {
  pattern: string;
  searchPath: string;
  totalMatches: number;
  matches: Array<{
    path: string;
    relativePath: string;
    name: string;
  }>;
  error?: string;
}

// ────────────────────────────────────────────────────────────
// Search Commands
// ────────────────────────────────────────────────────────────

/**
 * Register search-related commands.
 * Uses QuickPick for file search and OutputChannel for text search.
 *
 * Registered once at activation — the connection holder is read at command
 * invocation time, so connect/reconnect can swap the RPC client without
 * re-registering (which would throw "command already exists").
 */
export function registerSearchCommands(
  context: vscode.ExtensionContext,
  connection: RpcConnectionHolder,
): void {
  const outputChannel = vscode.window.createOutputChannel("Workspace Remote Search");
  context.subscriptions.push(outputChannel);

  // ── File Search (Quick Open style) ──────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("workspace.searchFiles", async () => {
      const quickPick = vscode.window.createQuickPick();
      quickPick.placeholder = "Search files by name...";
      quickPick.matchOnDescription = true;

      let debounceTimer: ReturnType<typeof setTimeout> | undefined;

      quickPick.onDidChangeValue((value) => {
        if (debounceTimer) clearTimeout(debounceTimer);
        if (!value || value.length < 2) {
          quickPick.items = [];
          return;
        }

        debounceTimer = setTimeout(async () => {
          quickPick.busy = true;
          try {
            const result = await connection.rpc.call<GlobResult>("search.glob", {
              pattern: `*${value}*`,
              searchPath: connection.workspaceRoot,
            });

            if (result.matches) {
              quickPick.items = result.matches.map((m) => ({
                label: m.name,
                description: m.relativePath,
                detail: m.path,
              }));
            }
          } catch {
            quickPick.items = [];
          }
          quickPick.busy = false;
        }, 250);
      });

      quickPick.onDidAccept(() => {
        const selected = quickPick.selectedItems[0];
        if (selected?.detail) {
          const uri = vscode.Uri.from({
            scheme: WorkspaceFileSystem.scheme,
            path: selected.detail,
          });
          vscode.window.showTextDocument(uri);
        }
        quickPick.hide();
      });

      quickPick.onDidHide(() => quickPick.dispose());
      quickPick.show();
    }),
  );

  // ── Text Search (grep) ─────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("workspace.searchText", async () => {
      const query = await vscode.window.showInputBox({
        prompt: "Search text across remote workspace",
        placeHolder: "Enter search pattern...",
      });

      if (!query) return;

      const isRegex = await vscode.window.showQuickPick(["Literal", "Regex"], {
        placeHolder: "Search mode",
      });

      outputChannel.clear();
      outputChannel.show();
      outputChannel.appendLine(`🔍 Searching for: ${query}`);
      outputChannel.appendLine(`   Mode: ${isRegex === "Regex" ? "Regex" : "Literal"}`);
      outputChannel.appendLine(`   Path: ${connection.workspaceRoot}`);
      outputChannel.appendLine("─".repeat(60));

      try {
        const result = await connection.rpc.call<GrepResult>("search.grep", {
          pattern: query,
          searchPath: connection.workspaceRoot,
          isRegex: isRegex === "Regex",
          matchPerLine: true,
        }, 30_000);

        if (result.error) {
          outputChannel.appendLine(`❌ Error: ${result.error}`);
          return;
        }

        if (!result.results || result.results.length === 0) {
          outputChannel.appendLine("No matches found.");
          return;
        }

        outputChannel.appendLine(`Found ${result.totalMatches} match(es)${result.truncated ? " (truncated)" : ""}:\n`);

        // Group by file
        const grouped = new Map<string, Array<{ line: number; content: string }>>();
        for (const match of result.results) {
          const entries = grouped.get(match.file) || [];
          entries.push({ line: match.line, content: match.content });
          grouped.set(match.file, entries);
        }

        for (const [file, matches] of grouped) {
          outputChannel.appendLine(`📄 ${file}`);
          for (const m of matches) {
            outputChannel.appendLine(`   L${m.line}: ${m.content.trim()}`);
          }
          outputChannel.appendLine("");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`❌ RPC Error: ${msg}`);
      }
    }),
  );
}
