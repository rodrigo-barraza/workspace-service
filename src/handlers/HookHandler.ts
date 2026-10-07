// ─── Repository Hooks (hook.run, hooks.config, transcript.append) ───
// A Prism agent working in a repository on this machine runs that
// repository's hooks here, where the repository is — in it, with this
// machine's tools. The mechanics are shared with tools-service's local mode
// (WorkspaceHooks.ts); this class adds the bridge's rules: every directory
// must sit under a registered root, and hooks get this process's own
// environment with credentials stripped.

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { sanitizedChildEnv } from "./CommandHandler.ts";
import {
  appendTranscript,
  clampHookRunTimeout,
  containingRoot,
  hookEnvironment,
  readHooksConfig,
  runHookCommand,
} from "./WorkspaceHooks.ts";
import type { HookRunResult, HooksConfig } from "./WorkspaceHooks.ts";
import type { HookRunParams, HooksConfigParams, TranscriptAppendParams } from "../types.ts";

export class HookHandler {
  roots: string[];
  constructor(roots: string[]) {
    this.roots = roots.map((root: string) => resolve(root));
  }

  /** Run one hook command in `cwd` with `stdin` as its input. */
  async run({ command, cwd, stdin, env, timeoutMs }: HookRunParams): Promise<HookRunResult> {
    if (typeof command !== "string" || !command.trim()) {
      throw new Error("'command' is required (string)");
    }
    if (stdin !== undefined && typeof stdin !== "string") {
      throw new Error("'stdin' must be a string");
    }
    return runHookCommand({
      command,
      cwd: this._registeredDirectory(cwd, "cwd"),
      stdin,
      env: hookEnvironment(sanitizedChildEnv(), env),
      timeoutMs: clampHookRunTimeout(timeoutMs),
    });
  }

  /** The hooks files that apply to `root`: the nearest project file and the user's. */
  config({ root }: HooksConfigParams): HooksConfig {
    const directory = this._registeredDirectory(root, "root");
    return readHooksConfig(directory, containingRoot(directory, this.roots) ?? directory, homedir());
  }

  /** Claude Code-shaped transcript lines for hooks that read `transcript_path`. */
  appendTranscript({ conversationId, lines }: TranscriptAppendParams): { path: string } {
    return appendTranscript(conversationId, lines);
  }

  /** An existing directory under a registered root — whatever WORKSPACE_CONTAINMENT says. */
  private _registeredDirectory(value: unknown, field: string): string {
    if (typeof value !== "string" || !isAbsolute(value)) {
      throw new Error(`'${field}' must be an absolute path`);
    }
    const directory = resolve(value);
    if (!containingRoot(directory, this.roots)) {
      throw new Error(`'${field}' is outside the workspace root(s): ${directory}. Accessible root(s): ${this.roots.join(", ")}`);
    }
    let isDirectory = false;
    try {
      isDirectory = statSync(directory).isDirectory();
    } catch {
      // Missing
    }
    if (!isDirectory) throw new Error(`'${field}' is not a directory: ${directory}`);
    return directory;
  }
}
