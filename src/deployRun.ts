import * as cp from "node:child_process";
import * as vscode from "vscode";
import { getHotfixRunMode } from "./config";
import {
  buildDeployShellScript,
  type DeployTargets,
} from "./deployWorkflow";
import type { HotfixCliEnv } from "./hotfixCli";

const DEPLOY_OUTPUT_TITLE = "Fordefi Hotfix Deploy";
const DEPLOY_TERMINAL_NAME = "Hotfix Deploy";
const SHELL_INTEGRATION_WAIT_MS = 8000;

let deployOutputChannel: vscode.OutputChannel | undefined;

function getDeployOutputChannel(): vscode.OutputChannel {
  if (!deployOutputChannel) {
    deployOutputChannel =
      vscode.window.createOutputChannel(DEPLOY_OUTPUT_TITLE);
  }
  return deployOutputChannel;
}

/** Register so the deploy channel is disposed on extension deactivation. */
export function registerHotfixDeployOutputChannel(
  context: vscode.ExtensionContext
): void {
  context.subscriptions.push(getDeployOutputChannel());
}

function appendDeployHeader(
  ch: vscode.OutputChannel,
  env: HotfixCliEnv,
  script: string
): void {
  ch.appendLine("");
  ch.appendLine(`── ${new Date().toISOString()} ──`);
  ch.appendLine(`Deploy env: ${env}`);
  ch.appendLine(`$ bash -lc '<deploy script>'`);
  ch.appendLine(script);
  ch.appendLine("");
}

export type DeployRunResult = {
  exitCode: number | undefined;
  ok: boolean;
};

async function runDeployBackground(
  script: string,
  cwd: string
): Promise<DeployRunResult> {
  const ch = getDeployOutputChannel();
  return await new Promise<DeployRunResult>((resolve) => {
    const child = cp.spawn(script, {
      shell: "/bin/bash",
      cwd,
      env: process.env,
      windowsHide: true,
    });
    child.stdout?.on("data", (c: Buffer) => ch.append(c.toString()));
    child.stderr?.on("data", (c: Buffer) => ch.append(c.toString()));
    child.on("error", (err) => {
      ch.appendLine(`[could not start deploy] ${err.message}`);
      void vscode.window.showErrorMessage(
        `Hotfix deploy could not start: ${err.message}`
      );
      resolve({ exitCode: undefined, ok: false });
    });
    child.on("close", (code, signal) => {
      ch.appendLine("");
      if (signal) {
        ch.appendLine(`[deploy finished] signal ${signal}`);
        void vscode.window.showWarningMessage(
          `Hotfix deploy stopped (signal ${String(signal)}).`
        );
        resolve({ exitCode: undefined, ok: false });
        return;
      }
      if (code === 0) {
        ch.appendLine(`[deploy finished] exit 0`);
        void vscode.window.showInformationMessage(
          `Hotfix deploy finished successfully.`
        );
        resolve({ exitCode: 0, ok: true });
        return;
      }
      ch.appendLine(`[deploy finished] exit ${code}`);
      void vscode.window
        .showErrorMessage(
          `Hotfix deploy failed (exit ${code}). See output “${DEPLOY_OUTPUT_TITLE}”.`,
          "Open output"
        )
        .then((sel) => {
          if (sel === "Open output") {
            ch.show(true);
          }
        });
      resolve({
        exitCode: typeof code === "number" ? code : undefined,
        ok: false,
      });
    });
  });
}

function singleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function runDeployIntegratedTerminal(
  script: string,
  cwd: string
): Promise<DeployRunResult> {
  const ch = getDeployOutputChannel();
  const terminal = vscode.window.createTerminal({
    name: DEPLOY_TERMINAL_NAME,
    cwd,
  });
  terminal.show(true);

  let resolvedExit: number | undefined;

  await new Promise<void>((resolve) => {
    let activeExecution: vscode.TerminalShellExecution | undefined;
    let settled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    const disposables: vscode.Disposable[] = [];

    const cleanup = (): void => {
      if (fallbackTimer !== undefined) {
        clearTimeout(fallbackTimer);
        fallbackTimer = undefined;
      }
      for (const d of disposables) {
        d.dispose();
      }
    };
    const done = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const command = `bash -lc ${singleQuote(script)}`;

    const tryExecute = (
      si: vscode.TerminalShellIntegration | undefined
    ): boolean => {
      if (activeExecution || !si) {
        return false;
      }
      try {
        activeExecution = si.executeCommand(command);
        if (fallbackTimer !== undefined) {
          clearTimeout(fallbackTimer);
          fallbackTimer = undefined;
        }
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
      resolvedExit = e.exitCode;
      ch.appendLine("");
      if (e.exitCode === 0) {
        ch.appendLine(`[deploy finished] exit 0`);
        void vscode.window.showInformationMessage(
          `Hotfix deploy finished successfully.`
        );
      } else if (e.exitCode === undefined) {
        ch.appendLine(`[deploy finished] exit code unknown`);
        void vscode.window.showWarningMessage(
          `Hotfix deploy finished but the shell did not report an exit code.`
        );
      } else {
        ch.appendLine(`[deploy finished] exit ${e.exitCode}`);
        void vscode.window.showErrorMessage(
          `Hotfix deploy failed (exit ${e.exitCode}). See terminal “${DEPLOY_TERMINAL_NAME}”.`
        );
      }
      done();
    });
    disposables.push(endSub);

    const fallbackSendText = (reason: string): void => {
      if (activeExecution) return;
      ch.appendLine(`[fallback] ${reason}`);
      terminal.sendText(command, true);
      void vscode.window.showInformationMessage(
        `Hotfix deploy script was sent to terminal “${DEPLOY_TERMINAL_NAME}”. Exit code is not available without shell integration.`
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
      if (activeExecution) return;
      intSub.dispose();
      const i = disposables.indexOf(intSub);
      if (i >= 0) {
        disposables.splice(i, 1);
      }
      fallbackSendText(
        `no shell integration within ${SHELL_INTEGRATION_WAIT_MS}ms`
      );
    }, SHELL_INTEGRATION_WAIT_MS);
  });

  return { exitCode: resolvedExit, ok: resolvedExit === 0 };
}

/**
 * Run the composed deploy script for `env`. Uses the same run mode
 * (integratedTerminal / background) as fcli so the user experience is consistent.
 */
export async function runHotfixDeploy(options: {
  env: HotfixCliEnv;
  targets: DeployTargets;
  cwd: string;
}): Promise<DeployRunResult> {
  const { env, targets, cwd } = options;
  const script = buildDeployShellScript(env, targets);
  const ch = getDeployOutputChannel();
  appendDeployHeader(ch, env, script);
  ch.show(true);

  const mode = getHotfixRunMode();
  if (mode === "background") {
    return runDeployBackground(script, cwd);
  }
  return runDeployIntegratedTerminal(script, cwd);
}
