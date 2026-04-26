import * as vscode from "vscode";
import {
  runInIntegratedTerminal,
  runViaSpawn,
} from "./commandRunner";
import { getHotfixRunMode } from "./config";
import {
  buildDeployShellScript,
  type DeployTargets,
} from "./deployWorkflow";
import type { HotfixCliEnv } from "./hotfixCli";

const DEPLOY_OUTPUT_TITLE = "Fordefi Hotfix Deploy";
const DEPLOY_TERMINAL_NAME = "Hotfix Deploy";

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
  const result = await runViaSpawn({
    command: script,
    cwd,
    shell: "/bin/bash",
    log: (chunk) => ch.append(chunk),
  });
  if (result.spawnError) {
    ch.appendLine(`[could not start deploy] ${result.spawnError.message}`);
    void vscode.window.showErrorMessage(
      `Hotfix deploy could not start: ${result.spawnError.message}`
    );
    return { exitCode: undefined, ok: false };
  }
  ch.appendLine("");
  if (result.signal) {
    ch.appendLine(`[deploy finished] signal ${result.signal}`);
    void vscode.window.showWarningMessage(
      `Hotfix deploy stopped (signal ${String(result.signal)}).`
    );
    return { exitCode: undefined, ok: false };
  }
  if (result.exitCode === 0) {
    ch.appendLine(`[deploy finished] exit 0`);
    void vscode.window.showInformationMessage(
      `Hotfix deploy finished successfully.`
    );
    return { exitCode: 0, ok: true };
  }
  ch.appendLine(`[deploy finished] exit ${result.exitCode}`);
  void vscode.window
    .showErrorMessage(
      `Hotfix deploy failed (exit ${result.exitCode}). See output “${DEPLOY_OUTPUT_TITLE}”.`,
      "Open output"
    )
    .then((sel) => {
      if (sel === "Open output") {
        ch.show(true);
      }
    });
  return { exitCode: result.exitCode, ok: false };
}

function singleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function runDeployIntegratedTerminal(
  script: string,
  cwd: string
): Promise<DeployRunResult> {
  const ch = getDeployOutputChannel();
  const command = `bash -lc ${singleQuote(script)}`;
  const result = await runInIntegratedTerminal({
    command,
    cwd,
    terminalName: DEPLOY_TERMINAL_NAME,
    log: (line) => ch.appendLine(line),
  });
  if (result.fallbackUsed) {
    void vscode.window.showInformationMessage(
      `Hotfix deploy script was sent to terminal “${DEPLOY_TERMINAL_NAME}”. Exit code is not available without shell integration.`
    );
    return { exitCode: result.exitCode, ok: false };
  }
  ch.appendLine("");
  if (result.exitCode === 0) {
    ch.appendLine(`[deploy finished] exit 0`);
    void vscode.window.showInformationMessage(
      `Hotfix deploy finished successfully.`
    );
  } else if (result.exitCode === undefined) {
    ch.appendLine(`[deploy finished] exit code unknown`);
    void vscode.window.showWarningMessage(
      `Hotfix deploy finished but the shell did not report an exit code.`
    );
  } else {
    ch.appendLine(`[deploy finished] exit ${result.exitCode}`);
    void vscode.window.showErrorMessage(
      `Hotfix deploy failed (exit ${result.exitCode}). See terminal “${DEPLOY_TERMINAL_NAME}”.`
    );
  }
  return { exitCode: result.exitCode, ok: result.exitCode === 0 };
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
