import type { GitHubPull } from "./githubClient";
import { GitHubError } from "./githubClient";

/**
 * Outcome of one watch poll after all `getPullRequest` calls have settled.
 * Drives UI messages and whether the hotfix terminal is started.
 */
export type WatchPollPhase =
  | { kind: "continue"; pendingNumbers: number[] }
  | { kind: "all_merged" }
  | { kind: "stop_404"; prNumber: number }
  | { kind: "stop_closed"; prNumbers: number[] }
  | { kind: "poll_error"; message: string };

export function phaseFromSettledPulls(
  watchTarget: readonly number[],
  settled: readonly PromiseSettledResult<GitHubPull>[]
): WatchPollPhase {
  if (settled.length !== watchTarget.length) {
    return { kind: "poll_error", message: "watch poll: result count mismatch" };
  }
  const pulls: GitHubPull[] = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    const n = watchTarget[i];
    if (r.status === "rejected") {
      const err = r.reason;
      if (err instanceof GitHubError && err.status === 404) {
        return { kind: "stop_404", prNumber: n };
      }
      return {
        kind: "poll_error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
    pulls.push(r.value);
  }
  const closedWithoutMerge = pulls.filter(
    (p) => !p.merged_at && p.state === "closed"
  );
  if (closedWithoutMerge.length > 0) {
    return {
      kind: "stop_closed",
      prNumbers: closedWithoutMerge.map((p) => p.number),
    };
  }
  const pending = pulls.filter((p) => !p.merged_at);
  if (pending.length > 0) {
    return { kind: "continue", pendingNumbers: pending.map((p) => p.number) };
  }
  return { kind: "all_merged" };
}
