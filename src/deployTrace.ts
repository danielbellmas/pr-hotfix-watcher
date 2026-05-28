import type * as vscode from "vscode";

export type DeployTracer = {
  info: (msg: string) => void;
  detail: (label: string, value: string | number | boolean | undefined | null) => void;
};

function formatDetail(label: string, value: string | number | boolean | undefined | null): string {
  const v = value === undefined ? "undefined" : value === null ? "null" : String(value);
  return `${label}=${v}`;
}

/** Structured deploy-phase logging to the Deploy output channel (and optional CLI channel). */
export function createDeployTracer(
  deployChannel: vscode.OutputChannel,
  cliChannel?: vscode.OutputChannel
): DeployTracer {
  const write = (line: string): void => {
    deployChannel.appendLine(line);
    cliChannel?.appendLine(line);
  };
  return {
    info: (msg) => write(`[deploy-trace] ${msg}`),
    detail: (label, value) => write(`[deploy-trace]   ${formatDetail(label, value)}`),
  };
}
