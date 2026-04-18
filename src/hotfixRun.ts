import * as cp from "node:child_process";
import * as vscode from "vscode";
import { formatPrLabels, truncateRunLogTail } from "./hotfixRunHelpers";

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

/**
 * Runs the configured hotfix shell command after all watched PRs merged.
 * Streams stdout/stderr to the output channel and notifies on completion.
 */
export async function runHotfixShellCommandAfterMerge(options: {
  command: string;
  cwd: string;
  prNumbers: readonly number[];
}): Promise<void> {
  const { command, cwd, prNumbers } = options;
  const prs = formatPrLabels(prNumbers);
  const ch = getOutputChannel();
  ch.appendLine("");
  ch.appendLine(`── ${new Date().toISOString()} ──`);
  ch.appendLine(`Merged PRs: ${prs}`);
  ch.appendLine(`$ ${command}`);
  ch.appendLine("");
  ch.show(true);

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
      resolve();
    });
  });
}
