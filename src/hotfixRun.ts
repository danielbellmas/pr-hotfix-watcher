import * as cp from "node:child_process";
import * as vscode from "vscode";
import {
  getHotfixRunMode,
  getHotfixTerminalAutoFirstConfirm,
  getHotfixTerminalAutoFirstConfirmDelayMs,
  getHotfixTerminalAutoFirstConfirmText,
  getHotfixTerminalName,
} from "./config";
import { formatPrLabels, truncateRunLogTail } from "./hotfixRunHelpers";

const OUTPUT_TITLE = "Fordefi Hotfix CLI";

/** Wait for shell integration after creating a terminal (ms). */
const SHELL_INTEGRATION_WAIT_MS = 8000;

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

function notifySpawnClose(
  prs: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  combined: string,
  ch: vscode.OutputChannel,
): void {
  ch.appendLine("");
  if (signal) {
    ch.appendLine(`[finished] signal ${signal}`);
    void vscode.window.showWarningMessage(
      `Hotfix CLI stopped (signal ${String(signal)}) for ${prs}. See output “${OUTPUT_TITLE}”.`,
      "Open output",
    ).then((sel) => {
      if (sel === "Open output") {
        ch.show(true);
      }
    });
  } else if (code === 0) {
    ch.appendLine("[finished] exit 0");
    void vscode.window.showInformationMessage(`Hotfix CLI finished successfully for ${prs}.`);
  } else {
    ch.appendLine(`[finished] exit ${code}`);
    const snippet = truncateRunLogTail(combined, 280);
    void vscode.window
      .showErrorMessage(
        `Hotfix CLI failed (exit ${code}) for ${prs}.${snippet ? ` ${snippet}` : ""} See output “${OUTPUT_TITLE}”.`,
        "Open output",
      )
      .then((sel) => {
        if (sel === "Open output") {
          ch.show(true);
        }
      });
  }
}

function notifyTerminalEnd(prs: string, exitCode: number | undefined, ch: vscode.OutputChannel): void {
  ch.appendLine("");
  if (exitCode === undefined) {
    ch.appendLine("[finished] exit code unknown");
    void vscode.window.showWarningMessage(
      `Hotfix CLI finished for ${prs}, but the shell did not report an exit code. Check the terminal output.`,
      "Open output",
    ).then((sel) => {
      if (sel === "Open output") {
        ch.show(true);
      }
    });
  } else if (exitCode === 0) {
    ch.appendLine("[finished] exit 0");
    void vscode.window.showInformationMessage(`Hotfix CLI finished successfully for ${prs}.`);
  } else {
    ch.appendLine(`[finished] exit ${exitCode}`);
    void vscode.window
      .showErrorMessage(
        `Hotfix CLI failed (exit ${exitCode}) for ${prs}. See the integrated terminal and output “${OUTPUT_TITLE}”.`,
        "Open output",
      )
      .then((sel) => {
        if (sel === "Open output") {
          ch.show(true);
        }
      });
  }
}

async function runHotfixSpawnBackground(command: string, cwd: string, prs: string, ch: vscode.OutputChannel): Promise<void> {
  let combined = "";
  await new Promise<void>((resolve) => {
    const child = cp.spawn(command, {
      shell: true,
      cwd,
      env: process.env,
      windowsHide: true,
    });

    const onChunk = (chunk: Buffer): void => {
      const t = chunk.toString();
      combined = (combined + t).slice(-16000);
      ch.append(t);
    };

    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    child.on("error", (err) => {
      ch.appendLine(`[could not start process] ${err.message}`);
      void vscode.window.showErrorMessage(`Hotfix CLI could not start for ${prs}: ${err.message}`);
      resolve();
    });

    child.on("close", (code, signal) => {
      notifySpawnClose(prs, code, signal, combined, ch);
      resolve();
    });
  });
}

async function runHotfixIntegratedTerminal(command: string, cwd: string, prs: string, ch: vscode.OutputChannel): Promise<void> {
  const terminalName = getHotfixTerminalName();
  const terminal = vscode.window.createTerminal({ name: terminalName, cwd });
  terminal.show(true);

  await new Promise<void>((resolve) => {
    let activeExecution: vscode.TerminalShellExecution | undefined;
    let settled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let autoFirstConfirmTimer: ReturnType<typeof setTimeout> | undefined;
    const disposables: vscode.Disposable[] = [];

    const cleanup = (): void => {
      if (fallbackTimer !== undefined) {
        clearTimeout(fallbackTimer);
        fallbackTimer = undefined;
      }
      if (autoFirstConfirmTimer !== undefined) {
        clearTimeout(autoFirstConfirmTimer);
        autoFirstConfirmTimer = undefined;
      }
      for (const d of disposables) {
        d.dispose();
      }
    };

    const done = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };

    const scheduleAutoFirstConfirm = (): void => {
      if (!getHotfixTerminalAutoFirstConfirm()) {
        return;
      }
      const delay = getHotfixTerminalAutoFirstConfirmDelayMs();
      const text = getHotfixTerminalAutoFirstConfirmText();
      if (autoFirstConfirmTimer !== undefined) {
        clearTimeout(autoFirstConfirmTimer);
      }
      autoFirstConfirmTimer = setTimeout(() => {
        autoFirstConfirmTimer = undefined;
        if (settled) {
          return;
        }
        const addNewline = !/[\r\n]/.test(text);
        ch.appendLine(`[auto-confirm] sending first-prompt input after ${delay}ms`);
        try {
          terminal.sendText(text, addNewline);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          ch.appendLine(`[auto-confirm] ${msg}`);
        }
      }, delay);
    };

    const tryExecute = (si: vscode.TerminalShellIntegration | undefined): boolean => {
      if (activeExecution || !si) {
        return false;
      }
      try {
        activeExecution = si.executeCommand(command);
        if (fallbackTimer !== undefined) {
          clearTimeout(fallbackTimer);
          fallbackTimer = undefined;
        }
        scheduleAutoFirstConfirm();
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ch.appendLine(`[executeCommand failed] ${msg}`);
        activeExecution = undefined;
        return false;
      }
    };

    const endSub = vscode.window.onDidEndTerminalShellExecution((e) => {
      if (!activeExecution || e.execution !== activeExecution) {
        return;
      }
      ch.appendLine(`[shell integration] exit ${e.exitCode === undefined ? "undefined" : String(e.exitCode)}`);
      notifyTerminalEnd(prs, e.exitCode, ch);
      done();
    });
    disposables.push(endSub);

    const fallbackSendText = (reason: string): void => {
      if (activeExecution) {
        return;
      }
      ch.appendLine(`[fallback] ${reason}`);
      terminal.sendText(command, true);
      void vscode.window.showInformationMessage(
        `Hotfix command was sent to terminal “${terminalName}” for ${prs}. Complete YubiKey / prompts there — exit code is not available without shell integration.`,
      );
      done();
    };

    if (tryExecute(terminal.shellIntegration)) {
      return;
    }

    const intSub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal !== terminal) {
        return;
      }
      if (tryExecute(e.shellIntegration)) {
        intSub.dispose();
        const i = disposables.indexOf(intSub);
        if (i >= 0) {
          disposables.splice(i, 1);
        }
      }
    });
    disposables.push(intSub);

    fallbackTimer = setTimeout(() => {
      if (activeExecution) {
        return;
      }
      intSub.dispose();
      const i = disposables.indexOf(intSub);
      if (i >= 0) {
        disposables.splice(i, 1);
      }
      fallbackSendText(`no shell integration within ${SHELL_INTEGRATION_WAIT_MS}ms`);
    }, SHELL_INTEGRATION_WAIT_MS);
  });
}

/**
 * Runs the configured hotfix shell command after all watched PRs merged.
 * Mode `integratedTerminal` (default): real terminal for YubiKey / prompts; toasts when shell integration reports exit.
 * Mode `background`: spawn in extension host; streams to output channel.
 */
export async function runHotfixShellCommandAfterMerge(options: {
  command: string;
  cwd: string;
  prNumbers: readonly number[];
}): Promise<void> {
  const { command, cwd, prNumbers } = options;
  const prs = formatPrLabels(prNumbers);
  const ch = getOutputChannel();
  appendRunHeader(ch, prs, command);
  ch.show(true);

  const mode = getHotfixRunMode();
  if (mode === "background") {
    await runHotfixSpawnBackground(command, cwd, prs, ch);
  } else {
    await runHotfixIntegratedTerminal(command, cwd, prs, ch);
  }
}
