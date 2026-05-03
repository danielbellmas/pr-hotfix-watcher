import * as vscode from "vscode";
import { runInIntegratedTerminal, runViaSpawn } from "./commandRunner";
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
import { notifyMilestone } from "./notifyMilestone";
import { PromptDetector } from "./promptDetector";
import { registerActiveChild, unregisterActiveChild } from "./runRegistry";
import { isYubikeyAgentRunning } from "./yubikeyAgentDetect";

const OUTPUT_TITLE = "Fordefi Hotfix CLI";

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel(OUTPUT_TITLE);
  }
  return outputChannel;
}

/** Register so the channel is disposed on extension deactivation. */
export function registerHotfixCliOutputChannel(context: vscode.ExtensionContext): void {
  context.subscriptions.push(getOutputChannel());
}

function appendRunHeader(ch: vscode.OutputChannel, prs: string, command: string): void {
  ch.appendLine("");
  ch.appendLine(`── ${new Date().toISOString()} ──`);
  ch.appendLine(`Merged PRs: ${prs}`);
  ch.appendLine(`$ ${command}`);
  ch.appendLine("");
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
    void vscode.window.showInformationMessage(`Hotfix CLI finished successfully for ${prs}.`);
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

/**
 * Transparent-mode run: spawn fcli without a visible terminal, parse its
 * output for known prompt patterns, and surface them as dual-fired
 * notifications. Auto-respond `y\n` to the first `[y/n]` (silent), surface
 * subsequent prompts as actionable notifications.
 */
async function runHotfixTransparent(
  command: string,
  cwd: string,
  prs: string,
  ch: vscode.OutputChannel
): Promise<HotfixRunResult> {
  let yesNoCount = 0;
  const skipYubikey = isYubikeyAgentRunning();
  ch.appendLine(
    `[transparent] starting; yubikey-agent ${
      skipYubikey ? "detected — touch notifications suppressed" : "not detected"
    }`
  );

  let childRef: import("node:child_process").ChildProcess | undefined;
  const detector = new PromptDetector({
    onEvent: (ev) => {
      if (ev.kind === "yubikey_touch_requested") {
        if (skipYubikey) {
          ch.appendLine("[prompt] yubikey touch (suppressed: agent detected)");
          return;
        }
        ch.appendLine("[prompt] yubikey touch requested");
        void notifyMilestone({
          title: "Touch your YubiKey",
          subtitle: `Hotfix CLI is waiting for ${prs}`,
          severity: "warn",
          actions: [{ label: "Open output" }],
          log: (l) => ch.appendLine(l),
        }).then((picked) => {
          if (picked === "Open output") {
            ch.show(true);
          }
        });
        return;
      }
      if (ev.kind === "conflict_detected") {
        ch.appendLine(`[prompt] conflict detected: ${ev.line}`);
        void notifyMilestone({
          title: "Hotfix CLI hit a merge conflict",
          subtitle: `${prs} — needs manual resolution in the worktree`,
          body: ev.line.slice(0, 240),
          severity: "error",
          actions: [{ label: "Open worktree terminal" }, { label: "Open output" }],
          log: (l) => ch.appendLine(l),
        }).then((picked) => {
          if (picked === "Open worktree terminal") {
            void vscode.commands.executeCommand("fordefiHotfix.openWorktreeTerminal", cwd);
          } else if (picked === "Open output") {
            ch.show(true);
          }
        });
        return;
      }
      if (ev.kind === "yes_no_prompt") {
        yesNoCount += 1;
        if (yesNoCount === 1 && getHotfixTerminalAutoFirstConfirm()) {
          // Auto-respond silently; this matches the integrated-terminal
          // auto-first-confirm behaviour so transparent mode is feature-parity.
          const text = getHotfixTerminalAutoFirstConfirmText();
          const payload = /[\r\n]/.test(text) ? text : `${text}\n`;
          const stdin = childRef?.stdin;
          if (stdin && !stdin.destroyed && stdin.writable) {
            try {
              stdin.write(payload);
              ch.appendLine(`[auto-confirm] sent ${JSON.stringify(text)}`);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              ch.appendLine(`[auto-confirm] write failed: ${msg}`);
            }
          } else {
            ch.appendLine("[auto-confirm] stdin not writable");
          }
          return;
        }
        ch.appendLine(`[prompt] additional [y/n] prompt #${yesNoCount}: ${ev.line.trim()}`);
        void notifyMilestone({
          title: "Hotfix CLI is waiting on a prompt",
          subtitle: `${prs} — open the output channel to see what it's asking`,
          body: ev.line.trim().slice(0, 240),
          severity: "warn",
          actions: [{ label: "Open output" }],
          log: (l) => ch.appendLine(l),
        }).then((picked) => {
          if (picked === "Open output") {
            ch.show(true);
          }
        });
        return;
      }
      if (ev.kind === "error_line") {
        ch.appendLine(`[prompt] error line: ${ev.line.trim()}`);
      }
    },
  });

  const result = await runViaSpawn({
    command,
    cwd,
    shell: true,
    captureOutput: true,
    log: (chunk) => ch.append(chunk),
    onChunk: (chunk) => detector.push(chunk),
    onChild: (child) => {
      childRef = child;
      registerActiveChild("fcli", child);
    },
  });
  unregisterActiveChild("fcli");

  if (result.spawnError) {
    ch.appendLine(`[could not start process] ${result.spawnError.message}`);
    void notifyMilestone({
      title: "Hotfix CLI did not start",
      subtitle: `${prs}`,
      body: result.spawnError.message,
      severity: "error",
      actions: [{ label: "Open output" }],
      log: (l) => ch.appendLine(l),
    }).then((picked) => {
      if (picked === "Open output") {
        ch.show(true);
      }
    });
    return { exitCode: undefined, output: result.output };
  }
  if (result.signal) {
    ch.appendLine(`[hotfix-cli stopped] signal ${result.signal}`);
    void notifyMilestone({
      title: "Hotfix CLI stopped",
      subtitle: `${prs} — signal ${String(result.signal)}`,
      severity: "warn",
      actions: [{ label: "Open output" }],
      log: (l) => ch.appendLine(l),
    }).then((picked) => {
      if (picked === "Open output") {
        ch.show(true);
      }
    });
    return { exitCode: undefined, output: result.output };
  }
  if (result.exitCode === 0) {
    ch.appendLine(`[hotfix-cli finished] exit 0`);
    // Success milestone fires later after the orchestrator parses the JSON
    // (we want the toast to mention the resulting hotfix PR). Only notify
    // here as a low-key info ping when nothing was parseable.
    return { exitCode: 0, output: result.output };
  }
  const snippet = truncateRunLogTail(result.output, 280);
  ch.appendLine(`[hotfix-cli finished] exit ${result.exitCode}`);
  void notifyMilestone({
    title: "Hotfix CLI failed",
    subtitle: `${prs} — exit ${result.exitCode}`,
    body: snippet || undefined,
    severity: "error",
    actions: [{ label: "Open output" }],
    log: (l) => ch.appendLine(l),
  }).then((picked) => {
    if (picked === "Open output") {
      ch.show(true);
    }
  });
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
 * Default mode is **transparent**: silent spawn + prompt-detection +
 * dual-fired notifications. The user can opt into the visible
 * `integratedTerminal` debug flow via `fordefiHotfix.debugTerminal`.
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
    ch.appendLine(`[worktree] using ${cwd}${worktree?.created ? " (created)" : ""}`);
  }

  const mode = getHotfixRunMode();
  // Only the legacy debug flow auto-pops the output panel; transparent mode
  // keeps the channel populated silently and only surfaces it when the user
  // clicks "Open output" on a notification.
  if (mode === "integratedTerminal") {
    ch.show(true);
  }

  maybeNotifyFirstWorktreeCreation(cwd, worktree, mode === "integratedTerminal");

  const raw =
    mode === "integratedTerminal"
      ? await runHotfixIntegratedTerminal(command, cwd, prs, ch)
      : await runHotfixTransparent(command, cwd, prs, ch);

  const hotfixPrs = parseHotfixCliJson(raw.output);
  const hotfixPrUrl = hotfixPrs?.[0]?.htmlUrl ?? parseHotfixPrUrl(raw.output);

  if (mode !== "integratedTerminal" && raw.exitCode === 0) {
    // Transparent-mode success milestone — fired here so we can include the
    // resolved PR URL when -o json was honored, falling back to a generic
    // success line otherwise.
    if (hotfixPrs && hotfixPrs.length > 0) {
      const list = hotfixPrs.map((e) => `${e.env}:#${e.prNumber}`).join(", ");
      const firstUrl = hotfixPrs[0].htmlUrl;
      void notifyMilestone({
        title: "Hotfix PR(s) created",
        subtitle: list,
        body: `Source ${prs}`,
        severity: "info",
        actions: [{ label: "Open PR" }, { label: "Open output" }],
        log: (l) => ch.appendLine(l),
      }).then((picked) => {
        if (picked === "Open PR" && firstUrl) {
          void vscode.env.openExternal(vscode.Uri.parse(firstUrl));
        } else if (picked === "Open output") {
          ch.show(true);
        }
      });
    } else if (hotfixPrUrl) {
      void notifyMilestone({
        title: "Hotfix PR created",
        subtitle: hotfixPrUrl,
        body: `Source ${prs}`,
        severity: "info",
        actions: [{ label: "Open PR" }, { label: "Open output" }],
        log: (l) => ch.appendLine(l),
      }).then((picked) => {
        if (picked === "Open PR") {
          void vscode.env.openExternal(vscode.Uri.parse(hotfixPrUrl));
        } else if (picked === "Open output") {
          ch.show(true);
        }
      });
    } else {
      void notifyMilestone({
        title: "Hotfix CLI finished",
        subtitle: `${prs}`,
        severity: "info",
        actions: [{ label: "Open output" }],
        log: (l) => ch.appendLine(l),
      }).then((picked) => {
        if (picked === "Open output") {
          ch.show(true);
        }
      });
    }
  }

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
  worktree: WorktreeRunContext | undefined,
  isVisibleTerminal: boolean
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
  // Wording differs depending on whether the user is about to see a real
  // terminal pop open: in transparent mode there's no terminal to "watch
  // for", so the YubiKey hint is the active-notification, not a hint about
  // a panel.
  const message = isVisibleTerminal
    ? `Created hotfix worktree at ${cwd}. Touch your YubiKey when prompted in the Hotfix CLI terminal.`
    : `Created hotfix worktree at ${cwd}. The hotfix run is starting in the background; you'll be notified when a YubiKey touch or other action is needed.`;
  void vscode.window.showInformationMessage(message);
}
