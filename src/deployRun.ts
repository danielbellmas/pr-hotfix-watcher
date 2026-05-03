import * as vscode from "vscode";
import { runInIntegratedTerminal, runViaSpawn } from "./commandRunner";
import { getHotfixRunMode } from "./config";
import { buildDeployShellScript, type DeployTargets } from "./deployWorkflow";
import type { HotfixCliEnv } from "./hotfixCli";
import { notifyMilestone } from "./notifyMilestone";
import {
  buildDeployNotification,
  type DeployNotificationOutcome,
  showOsNotification,
} from "./osNotify";
import { registerActiveChild, unregisterActiveChild } from "./runRegistry";

const DEPLOY_OUTPUT_TITLE = "Fordefi Hotfix Deploy";
const DEPLOY_TERMINAL_NAME = "Hotfix Deploy";

let deployOutputChannel: vscode.OutputChannel | undefined;

function getDeployOutputChannel(): vscode.OutputChannel {
  if (!deployOutputChannel) {
    deployOutputChannel = vscode.window.createOutputChannel(DEPLOY_OUTPUT_TITLE);
  }
  return deployOutputChannel;
}

/** Register so the deploy channel is disposed on extension deactivation. */
export function registerHotfixDeployOutputChannel(context: vscode.ExtensionContext): void {
  context.subscriptions.push(getDeployOutputChannel());
}

function appendDeployHeader(ch: vscode.OutputChannel, env: HotfixCliEnv, script: string): void {
  ch.appendLine("");
  ch.appendLine(`── ${new Date().toISOString()} ──`);
  ch.appendLine(`Deploy env: ${env}`);
  ch.appendLine(`[deploy] script:`);
  ch.appendLine(script);
  ch.appendLine("");
}

export type DeployRunResult = {
  exitCode: number | undefined;
  ok: boolean;
};

/** Keep call sites paired with each existing toast so toast and ping never drift. */
function pingDeployFinished(
  ch: vscode.OutputChannel,
  outcome: DeployNotificationOutcome,
  env: HotfixCliEnv,
  sourcePrNumbers: readonly number[] | undefined
): void {
  const note = buildDeployNotification({ outcome, env, sourcePrNumbers });
  showOsNotification({
    title: note.title,
    subtitle: note.subtitle,
    body: note.body,
    log: (line) => ch.appendLine(line),
  });
}

function fireDeployStartedMilestone(
  ch: vscode.OutputChannel,
  env: HotfixCliEnv,
  sourcePrNumbers: readonly number[] | undefined
): void {
  const prList = (sourcePrNumbers ?? []).slice().sort((a, b) => a - b);
  const prText = prList.length === 0 ? "" : `PRs: ${prList.map((n) => `#${n}`).join(", ")}`;
  void notifyMilestone({
    title: `Hotfix deploy started`,
    subtitle: `env: ${env}`,
    body: prText,
    severity: "info",
    actions: [{ label: "Open output" }],
    log: (l) => ch.appendLine(l),
  }).then((picked) => {
    if (picked === "Open output") {
      ch.show(true);
    }
  });
}

async function runDeployTransparent(
  script: string,
  cwd: string,
  env: HotfixCliEnv,
  sourcePrNumbers: readonly number[] | undefined
): Promise<DeployRunResult> {
  const ch = getDeployOutputChannel();
  fireDeployStartedMilestone(ch, env, sourcePrNumbers);
  const result = await runViaSpawn({
    command: script,
    cwd,
    shell: "/bin/bash",
    log: (chunk) => ch.append(chunk),
    onChild: (child) => registerActiveChild("deploy", child),
  });
  unregisterActiveChild("deploy");
  if (result.spawnError) {
    ch.appendLine(`[could not start deploy] ${result.spawnError.message}`);
    void notifyMilestone({
      title: "Hotfix deploy did not start",
      subtitle: `env: ${env}`,
      body: result.spawnError.message,
      severity: "error",
      actions: [{ label: "Open output" }],
      log: (l) => ch.appendLine(l),
    }).then((picked) => {
      if (picked === "Open output") {
        ch.show(true);
      }
    });
    pingDeployFinished(
      ch,
      { kind: "spawn_error", message: result.spawnError.message },
      env,
      sourcePrNumbers
    );
    return { exitCode: undefined, ok: false };
  }
  ch.appendLine("");
  if (result.signal) {
    ch.appendLine(`[deploy finished] signal ${result.signal}`);
    void notifyMilestone({
      title: "Hotfix deploy stopped",
      subtitle: `env: ${env} — signal ${String(result.signal)}`,
      severity: "warn",
      actions: [{ label: "Open output" }],
      log: (l) => ch.appendLine(l),
    }).then((picked) => {
      if (picked === "Open output") {
        ch.show(true);
      }
    });
    pingDeployFinished(
      ch,
      { kind: "signaled", signal: String(result.signal) },
      env,
      sourcePrNumbers
    );
    return { exitCode: undefined, ok: false };
  }
  if (result.exitCode === 0) {
    ch.appendLine(`[deploy finished] exit 0`);
    void notifyMilestone({
      title: "Hotfix deploy succeeded",
      subtitle: `env: ${env}`,
      severity: "info",
      actions: [{ label: "Open output" }],
      log: (l) => ch.appendLine(l),
    }).then((picked) => {
      if (picked === "Open output") {
        ch.show(true);
      }
    });
    pingDeployFinished(ch, { kind: "success" }, env, sourcePrNumbers);
    return { exitCode: 0, ok: true };
  }
  ch.appendLine(`[deploy finished] exit ${result.exitCode}`);
  void notifyMilestone({
    title: "Hotfix deploy FAILED",
    subtitle: `env: ${env} — exit ${result.exitCode}`,
    severity: "error",
    actions: [{ label: "Open output" }],
    log: (l) => ch.appendLine(l),
  }).then((picked) => {
    if (picked === "Open output") {
      ch.show(true);
    }
  });
  pingDeployFinished(
    ch,
    result.exitCode === undefined
      ? { kind: "unknown" }
      : { kind: "failure", exitCode: result.exitCode },
    env,
    sourcePrNumbers
  );
  return { exitCode: result.exitCode, ok: false };
}

function singleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function runDeployIntegratedTerminal(
  script: string,
  cwd: string,
  env: HotfixCliEnv,
  sourcePrNumbers: readonly number[] | undefined
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
      `Hotfix deploy script sent to terminal "${DEPLOY_TERMINAL_NAME}". Exit code is unavailable without shell integration.`
    );
    return { exitCode: result.exitCode, ok: false };
  }
  ch.appendLine("");
  if (result.exitCode === 0) {
    ch.appendLine(`[deploy finished] exit 0`);
    void vscode.window.showInformationMessage(`Hotfix deploy finished successfully.`);
    pingDeployFinished(ch, { kind: "success" }, env, sourcePrNumbers);
  } else if (result.exitCode === undefined) {
    ch.appendLine(`[deploy finished] exit code unknown`);
    void vscode.window.showWarningMessage(
      `Hotfix deploy finished but the shell did not report an exit code.`
    );
    pingDeployFinished(ch, { kind: "unknown" }, env, sourcePrNumbers);
  } else {
    ch.appendLine(`[deploy finished] exit ${result.exitCode}`);
    void vscode.window.showErrorMessage(
      `Hotfix deploy failed (exit ${result.exitCode}). See terminal "${DEPLOY_TERMINAL_NAME}".`
    );
    pingDeployFinished(ch, { kind: "failure", exitCode: result.exitCode }, env, sourcePrNumbers);
  }
  return { exitCode: result.exitCode, ok: result.exitCode === 0 };
}

/**
 * Run the composed deploy script for `env`. Mode picked by `getHotfixRunMode`:
 * `integratedTerminal` only when `fordefiHotfix.debugTerminal` is true (or
 * when the legacy mode setting still pins it); everything else is the new
 * transparent path with notification-driven UX.
 *
 * `sourcePrNumbers` is optional; when present it is rendered into the macOS
 * "deploy finished" notification body so a stale ping can be traced back to
 * the run that triggered it.
 */
export async function runHotfixDeploy(options: {
  env: HotfixCliEnv;
  targets: DeployTargets;
  cwd: string;
  sourcePrNumbers?: readonly number[];
}): Promise<DeployRunResult> {
  const { env, targets, cwd, sourcePrNumbers } = options;
  const script = buildDeployShellScript(env, targets);
  const ch = getDeployOutputChannel();
  appendDeployHeader(ch, env, script);

  const mode = getHotfixRunMode();
  if (mode === "integratedTerminal") {
    ch.show(true);
    return runDeployIntegratedTerminal(script, cwd, env, sourcePrNumbers);
  }
  return runDeployTransparent(script, cwd, env, sourcePrNumbers);
}
