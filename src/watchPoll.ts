import type { GitHubPull } from "./githubClient";
import { phaseFromHotfixSettled } from "./hotfixPrMergeWatch";

/**
 * Aggregate phase across a batch of watched PRs. Per-PR classification is
 * delegated to {@link phaseFromHotfixSettled} so the same primitive backs
 * both this poll and the post-fcli hotfix-PR poll.
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
  // First-error-wins so 404/transient-error reports the offending PR's
  // index, not a folded-over later PR.
  const pulls: GitHubPull[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    const prNumber = watchTarget[i];
    if (!result || prNumber === undefined) {
      return { kind: "poll_error", message: `watch poll: missing result at index ${i}` };
    }
    const phase = phaseFromHotfixSettled(result);
    if (phase.kind === "not_found") {
      return { kind: "stop_404", prNumber };
    }
    if (phase.kind === "error") {
      return { kind: "poll_error", message: phase.message };
    }
    pulls.push(phase.pull);
  }
  const closedWithoutMerge = pulls.filter((p) => !p.merged_at && p.state === "closed");
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
