import * as vscode from "vscode";
import { showOsNotification } from "./osNotify";

/**
 * Dual-fire notification helper for transparent mode. Every milestone /
 * action-required event surfaces as:
 *
 *   1. A native macOS banner via `osascript display notification` so the user
 *      sees something even when VS Code is in the background.
 *   2. A VS Code toast (information / warning / error) with optional action
 *      buttons, picked up when the user refocuses VS Code via the banner
 *      click. Returning a promise that resolves to the picked button (or
 *      `undefined` when dismissed) lets the caller wire phase-specific
 *      behaviour (Open PR, Open output, Resolve, Retry, …).
 *
 * The osascript ping is fire-and-forget; the toast is awaited so the caller
 * can act on the user's button choice.
 */

export type MilestoneSeverity = "info" | "warn" | "error";

export type MilestoneAction = {
  /** Visible button label. Pass to `result === action.label` to match. */
  label: string;
  /** Optional payload the caller can use; the helper itself only returns labels. */
  id?: string;
};

export type MilestoneNotificationInput = {
  /** Required: title both for the OS banner and the VS Code toast leading text. */
  title: string;
  /** Optional one-line subtitle; rendered into the banner subtitle and joined
   *  to the toast as `title — subtitle` so the user sees the same context in
   *  both places. */
  subtitle?: string;
  /** Optional banner body / additional toast detail. */
  body?: string;
  severity: MilestoneSeverity;
  /** Action buttons surfaced on the VS Code toast only. */
  actions?: readonly MilestoneAction[];
  /** Diagnostic sink for osascript failures; never user-facing. */
  log?: (line: string) => void;
};

export type MilestoneNotificationApi = {
  showInformationMessage: typeof vscode.window.showInformationMessage;
  showWarningMessage: typeof vscode.window.showWarningMessage;
  showErrorMessage: typeof vscode.window.showErrorMessage;
  showOsNotification: typeof showOsNotification;
};

const DEFAULT_API: MilestoneNotificationApi = {
  showInformationMessage: vscode.window.showInformationMessage.bind(vscode.window),
  showWarningMessage: vscode.window.showWarningMessage.bind(vscode.window),
  showErrorMessage: vscode.window.showErrorMessage.bind(vscode.window),
  showOsNotification,
};

/**
 * Fire a milestone notification. Returns the picked action label (or
 * undefined when no action was clicked / toast was dismissed).
 *
 * Errors from the OS notification path are routed to `log` and never
 * surfaced as a toast — the whole point of transparent mode is to avoid
 * stacking toasts the user has to dismiss.
 */
export async function notifyMilestone(
  input: MilestoneNotificationInput,
  api: MilestoneNotificationApi = DEFAULT_API
): Promise<string | undefined> {
  api.showOsNotification({
    title: input.title,
    subtitle: input.subtitle,
    body: input.body ?? input.subtitle ?? "",
    log: input.log,
  });

  const message = composeToastMessage(input);
  const labels = (input.actions ?? []).map((a) => a.label);
  switch (input.severity) {
    case "info":
      return api.showInformationMessage(message, ...labels);
    case "warn":
      return api.showWarningMessage(message, ...labels);
    case "error":
      return api.showErrorMessage(message, ...labels);
  }
}

function composeToastMessage(input: MilestoneNotificationInput): string {
  const parts = [input.title];
  if (input.subtitle) {
    parts.push(input.subtitle);
  }
  if (input.body && input.body !== input.subtitle) {
    parts.push(input.body);
  }
  return parts.join(" — ");
}
