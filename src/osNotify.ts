import { spawn } from "child_process";
import type { HotfixCliEnv } from "./hotfixCli";

/**
 * Native macOS notification helper for "deploy finished" events.
 *
 * Split into a pure {@link buildDeployNotification} and a thin
 * {@link showOsNotification} wrapper so the title/subtitle/body composition
 * is unit-tested without spawning AppleScript. The wrapper silently no-ops on
 * non-darwin platforms (the existing VS Code toasts remain the cross-platform
 * signal in that case).
 */

export type DeployNotificationOutcome =
  | { kind: "success" }
  | { kind: "failure"; exitCode: number }
  | { kind: "unknown" }
  | { kind: "signaled"; signal: string }
  | { kind: "spawn_error"; message: string };

export interface DeployNotificationInput {
  outcome: DeployNotificationOutcome;
  env: HotfixCliEnv;
  /** Source PRs the user batched in the sidebar; rendered into the body so
   *  a stale notification still identifies the run. */
  sourcePrNumbers?: readonly number[];
}

export interface DeployNotification {
  title: string;
  subtitle: string;
  body: string;
}

const MAX_SPAWN_ERROR_LEN = 120;

export function buildDeployNotification(input: DeployNotificationInput): DeployNotification {
  const { outcome, env, sourcePrNumbers } = input;
  const prList = formatSourcePrs(sourcePrNumbers);
  switch (outcome.kind) {
    case "success":
      return {
        title: "Hotfix deploy succeeded",
        subtitle: `env: ${env}`,
        body: prList,
      };
    case "failure":
      return {
        title: "Hotfix deploy FAILED",
        subtitle: `env: ${env} — exit ${outcome.exitCode}`,
        body: prList,
      };
    case "unknown":
      return {
        title: "Hotfix deploy finished",
        subtitle: `env: ${env} — exit unknown`,
        body: prList,
      };
    case "signaled":
      return {
        title: "Hotfix deploy stopped",
        subtitle: `env: ${env} — signal ${outcome.signal}`,
        body: prList,
      };
    case "spawn_error":
      return {
        title: "Hotfix deploy did not start",
        subtitle: `env: ${env}`,
        body: combineSpawnErrorBody(outcome.message, prList),
      };
  }
}

function formatSourcePrs(nums: readonly number[] | undefined): string {
  if (!nums || nums.length === 0) {
    return "";
  }
  const sorted = [...nums].sort((a, b) => a - b);
  const list = sorted.map((n) => `#${n}`).join(", ");
  return sorted.length === 1 ? `PR: ${list}` : `PRs: ${list}`;
}

function combineSpawnErrorBody(message: string, prList: string): string {
  const truncated = truncate(message, MAX_SPAWN_ERROR_LEN);
  if (!prList) {
    return truncated;
  }
  return `${truncated} — ${prList}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, max - 1)}…`;
}

export interface OsNotificationArgs {
  title: string;
  subtitle?: string;
  body: string;
  /** Optional sink for diagnostic lines when osascript fails. The deploy
   *  output channel is the natural target — pinger errors must never surface
   *  to the user as a toast since the whole point is unobtrusive signalling. */
  log?: (line: string) => void;
}

/**
 * AppleScript escape rules inside the double-quoted string literal: backslash
 * → `\\`, double quote → `\"`, and any newlines collapsed to spaces (embedded
 * literal newlines inside an AppleScript string literal are unreliable across
 * macOS versions).
 */
export function buildOsNotificationScript(args: {
  title: string;
  subtitle?: string;
  body: string;
}): string {
  const title = escapeAppleScript(args.title);
  const body = escapeAppleScript(args.body);
  const subtitle = args.subtitle ? escapeAppleScript(args.subtitle) : undefined;
  return subtitle
    ? `display notification "${body}" with title "${title}" subtitle "${subtitle}"`
    : `display notification "${body}" with title "${title}"`;
}

/**
 * Fire-and-forget native macOS notification via `osascript -e 'display
 * notification …'`. No-ops on non-darwin. Failures are routed to {@link
 * OsNotificationArgs.log} only — never surfaced to the user.
 */
export function showOsNotification(args: OsNotificationArgs): void {
  if (process.platform !== "darwin") {
    return;
  }
  const script = buildOsNotificationScript(args);

  try {
    const proc = spawn("osascript", ["-e", script], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    // Detach so the extension host can shut down without waiting on osascript;
    // the OS will let the child finish (it takes ~50–150ms) on its own.
    proc.unref();
    let stderr = "";
    proc.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    proc.on("error", (err) => {
      args.log?.(`[osNotify] spawn error: ${err.message}`);
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        const detail = stderr.trim();
        args.log?.(`[osNotify] osascript exit ${code}${detail ? `: ${detail}` : ""}`);
      }
    });
  } catch (err) {
    args.log?.(`[osNotify] caught: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function escapeAppleScript(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, " ");
}
