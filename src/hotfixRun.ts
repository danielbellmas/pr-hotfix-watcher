import * as vscode from "vscode";
import {
  runInIntegratedTerminal,
  runViaSpawn,
} from "./commandRunner";
import {
  getHotfixRunMode,
  getHotfixTerminalAutoFirstConfirm,
  getHotfixTerminalAutoFirstConfirmDelayMs,
  getHotfixTerminalAutoFirstConfirmText,
  getHotfixTerminalName,
} from "./config";
import {
  formatPrLabels,
  type HotfixPrEntry,
  parseHotfixCliJson,
  parseHotfixPrUrl,
  truncateRunLogTail,
} from "./hotfixRunHelpers";

const OUTPUT_TITLE = "Fordefi Hotfix CLI";

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel(OUTPUT_TITLE);
  }
  return outputChannel;
}

/** Register so the channel is disposed on extension deactivation. */
export function registerHotfixCliOutputChannel(
  context: vscode.ExtensionContext
): void {
  context.subscriptions.push(getOutputChannel());
}

function appendRunHeader(
  ch: vscode.OutputChannel,
  prs: string,
  command: string
): void {
  ch.appendLine("");
  ch.appendLine(`── ${new Date().toISOString()} ──`);
  ch.appendLine(`Merged PRs: ${prs}`);
  ch.appendLine(`$ ${command}`);
  ch.appendLine("");
}

function notifySpawnClose(
  prs: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  combined: string,
  ch: vscode.OutputChannel
): void {
  ch.appendLine("");
  if (signal) {
    ch.appendLine(`[hotfix-cli finished] signal ${signal}`);
    void vscode.window
      .showWarningMessage(
        `Hotfix CLI stopped (signal ${String(
          signal
        )}) for ${prs}. See output "${OUTPUT_TITLE}".`,
        "Open output"
      )
      .then((sel) => {
        if (sel === "Open output") {
          ch.show(true);
        }
      });
  } else if (code === 0) {
    ch.appendLine("[hotfix-cli finished] exit 0");
    void vscode.window.showInformationMessage(
      `Hotfix CLI finished successfully for ${prs}.`
    );
  } else {
    ch.appendLine(`[hotfix-cli finished] exit ${code}`);
    const snippet = truncateRunLogTail(combined, 280);
    void vscode.window
      .showErrorMessage(
        `Hotfix CLI failed (exit ${code}) for ${prs}.${
          snippet ? ` — ${snippet}` : ""
        } See output "${OUTPUT_TITLE}".`,
        "Open output"
      )
      .then((sel) => {
        if (sel === "Open output") {
          ch.show(true);
        }
      });
  }
}

function notifyTerminalEnd(
  prs: string,
  exitCode: number | undefined,
  ch: vscode.OutputChannel
): void {
  ch.appendLine("");
  if (exitCode === undefined) {
    ch.appendLine("[hotfix-cli finished] exit code unknown");
    void vscode.window
      .showWarningMessage(
        `Hotfix CLI finished for ${prs}, but the shell did not report an exit code. Check the integrated terminal output.`,
        "Open output"
      )
      .then((sel) => {
        if (sel === "Open output") {
          ch.show(true);
        }
      });
  } else if (exitCode === 0) {
    ch.appendLine("[hotfix-cli finished] exit 0");
    void vscode.window.showInformationMessage(
      `Hotfix CLI finished successfully for ${prs}.`
    );
  } else {
    ch.appendLine(`[hotfix-cli finished] exit ${exitCode}`);
    void vscode.window
      .showErrorMessage(
        `Hotfix CLI failed (exit ${exitCode}) for ${prs}. See the integrated terminal and output "${OUTPUT_TITLE}".`,
        "Open output"
      )
      .then((sel) => {
        if (sel === "Open output") {
          ch.show(true);
        }
      });
  }
}

type HotfixRunResult = {
  /** Exit 0 for spawn mode; shell-integration exit 0 for terminal mode; undefined when unknown. */
  exitCode: number | undefined;
  /** Whatever we captured from stdout/stderr (already tail-bounded). */
  output: string;
};

async function runHotfixSpawnBackground(
  command: string,
  cwd: string,
  prs: string,
  ch: vscode.OutputChannel
): Promise<HotfixRunResult> {
  const result = await runViaSpawn({
    command,
    cwd,
    shell: true,
    captureOutput: true,
    log: (chunk) => ch.append(chunk),
  });
  if (result.spawnError) {
    ch.appendLine(`[could not start process] ${result.spawnError.message}`);
    void vscode.window.showErrorMessage(
      `Hotfix CLI could not start for ${prs}: ${result.spawnError.message}`
    );
    return { exitCode: undefined, output: result.output };
  }
  notifySpawnClose(prs, result.exitCode ?? null, result.signal, result.output, ch);
  return { exitCode: result.exitCode, output: result.output };
}

async function runHotfixIntegratedTerminal(
  command: string,
  cwd: string,
  prs: string,
  ch: vscode.OutputChannel
): Promise<HotfixRunResult> {
  const terminalName = getHotfixTerminalName();
  const autoFirst = getHotfixTerminalAutoFirstConfirm()
    ? {
        text: getHotfixTerminalAutoFirstConfirmText(),
        delayMs: getHotfixTerminalAutoFirstConfirmDelayMs(),
      }
    : undefined;
  const result = await runInIntegratedTerminal({
    command,
    cwd,
    terminalName,
    log: (line) => ch.appendLine(line),
    captureOutput: true,
    autoFirstConfirm: autoFirst,
  });
  if (result.fallbackUsed) {
    void vscode.window.showInformationMessage(
      `Hotfix command sent to terminal "${terminalName}" for ${prs}. Complete YubiKey / prompts there — exit code is unavailable without shell integration.`
    );
  } else {
    notifyTerminalEnd(prs, result.exitCode, ch);
  }
  return { exitCode: result.exitCode, output: result.output };
}

export type HotfixShellRunResult = {
  /** Exit code from the fcli process (0 when successful). undefined when the shell did not report one. */
  exitCode: number | undefined;
  /** True when we have positive confirmation the command finished successfully. */
  ok: boolean;
  /**
   * Hotfix PR URL parsed from the legacy `HOTFIX_PR_URL=...` line. Kept for
   * back-compat with older fcli builds that did not yet support `-o json`.
   * When {@link hotfixPrs} is set it should be preferred over this field.
   */
  hotfixPrUrl: string | undefined;
  /**
   * Hotfix PRs parsed from `fcli ... -o json` stdout payload (one entry per
   * environment when the user asked for both pre and prod). `undefined` when
   * fcli was invoked without `-o json` or the JSON payload was unreadable —
   * callers should then fall back to {@link hotfixPrUrl}.
   */
  hotfixPrs?: HotfixPrEntry[];
  /** Captured command output (tail-bounded). May be empty when shell-integration read is unavailable. */
  output: string;
};

export type WorktreeRunContext = {
  /** True when `ensureHotfixWorktree` created the worktree on this invocation. */
  created: boolean;
  /** Present when `ensureHotfixWorktree` had to fall back to the original repo root. */
  fallback?: string;
  /** Optional human-readable detail paired with {@link fallback}. */
  fallbackDetail?: string;
  /**
   * globalState key used to gate the one-time "touch your YubiKey" toast so we
   * only show it on initial creation.
   */
  notificationKey?: string;
  /** Extension context whose globalState backs {@link notificationKey}. */
  context?: {
    globalState: {
      get<T>(key: string, fallback?: T): T | undefined;
      update(key: string, value: unknown): Thenable<void> | Promise<void>;
    };
  };
};

/**
 * Runs the configured hotfix shell command after all watched PRs merged.
 * Mode `integratedTerminal` (default): real terminal for YubiKey / prompts; toasts when shell integration reports exit.
 * Mode `background`: spawn in extension host; streams to output channel.
 */
export async function runHotfixShellCommandAfterMerge(options: {
  command: string;
  cwd: string;
  prNumbers: readonly number[];
  worktree?: WorktreeRunContext;
}): Promise<HotfixShellRunResult> {
  const { command, cwd, prNumbers, worktree } = options;
  const prs = formatPrLabels(prNumbers);
  const ch = getOutputChannel();
  appendRunHeader(ch, prs, command);
  if (worktree?.fallback) {
    ch.appendLine(
      `[worktree] fallback: ${worktree.fallback}${
        worktree.fallbackDetail ? ` — ${worktree.fallbackDetail}` : ""
      } (running in ${cwd})`
    );
  } else {
    ch.appendLine(
      `[worktree] using ${cwd}${worktree?.created ? " (created)" : ""}`
    );
  }
  ch.show(true);

  maybeNotifyFirstWorktreeCreation(cwd, worktree);

  const mode = getHotfixRunMode();
  const raw =
    mode === "background"
      ? await runHotfixSpawnBackground(command, cwd, prs, ch)
      : await runHotfixIntegratedTerminal(command, cwd, prs, ch);

  const hotfixPrs = parseHotfixCliJson(raw.output);
  const hotfixPrUrl =
    hotfixPrs?.[0]?.htmlUrl ?? parseHotfixPrUrl(raw.output);
  return {
    exitCode: raw.exitCode,
    ok: raw.exitCode === 0,
    hotfixPrUrl,
    hotfixPrs,
    output: raw.output,
  };
}

function maybeNotifyFirstWorktreeCreation(
  cwd: string,
  worktree: WorktreeRunContext | undefined
): void {
  if (!worktree?.created || worktree.fallback) {
    return;
  }
  const key = worktree.notificationKey;
  const gs = worktree.context?.globalState;
  if (key && gs) {
    if (gs.get<boolean>(key) === true) {
      return;
    }
    void gs.update(key, true);
  }
  void vscode.window.showInformationMessage(
    `Created hotfix worktree at ${cwd}. Touch your YubiKey when prompted in the Hotfix CLI terminal.`
  );
}
