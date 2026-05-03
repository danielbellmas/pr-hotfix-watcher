import { getPullRequest, GitHubError, type GitHubPull } from "./githubClient";

/**
 * Outcome of one hotfix-PR merge-watch poll.
 * Drives deploy orchestration and UI messages.
 */
export type HotfixMergePhase =
  | { kind: "waiting"; pull: GitHubPull }
  | { kind: "merged"; pull: GitHubPull }
  | { kind: "closed"; pull: GitHubPull }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

export function phaseFromHotfixPull(pull: GitHubPull): HotfixMergePhase {
  if (pull.merged_at) {
    return { kind: "merged", pull };
  }
  if (pull.state === "closed") {
    return { kind: "closed", pull };
  }
  return { kind: "waiting", pull };
}

export function phaseFromHotfixSettled(
  settled: PromiseSettledResult<GitHubPull>
): HotfixMergePhase {
  if (settled.status === "fulfilled") {
    return phaseFromHotfixPull(settled.value);
  }
  const err = settled.reason;
  if (err instanceof GitHubError && err.status === 404) {
    return { kind: "not_found" };
  }
  return {
    kind: "error",
    message: err instanceof Error ? err.message : String(err),
  };
}

export type HotfixPrMergeWatchOptions = {
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
  intervalMs: number;
  /** Called on every poll (waiting or terminal). */
  onPhase?: (phase: HotfixMergePhase) => void;
  /** Signal for external cancel (e.g. user clicks stop watching). */
  signal?: { aborted: boolean };
  /** Injected fetch for tests — defaults to {@link getPullRequest}. */
  fetch?: (token: string, owner: string, repo: string, prNumber: number) => Promise<GitHubPull>;
  /** Injected sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
};

export type HotfixPrMergeWatchResult =
  | { kind: "merged"; pull: GitHubPull }
  | { kind: "closed"; pull: GitHubPull }
  | { kind: "not_found" }
  | { kind: "aborted" }
  | { kind: "error"; message: string };

const defaultSleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/**
 * Polls the hotfix PR until it is merged, closed without merging, not found,
 * or the caller aborts. Resolves to a terminal {@link HotfixPrMergeWatchResult}.
 */
export async function watchHotfixPrMerge(
  options: HotfixPrMergeWatchOptions
): Promise<HotfixPrMergeWatchResult> {
  const {
    token,
    owner,
    repo,
    prNumber,
    intervalMs,
    onPhase,
    signal,
    fetch = getPullRequest,
    sleep = defaultSleep,
  } = options;
  while (!signal?.aborted) {
    const settled = await Promise.allSettled([fetch(token, owner, repo, prNumber)]);
    const phase = phaseFromHotfixSettled(settled[0]);
    onPhase?.(phase);
    if (phase.kind === "merged") {
      return { kind: "merged", pull: phase.pull };
    }
    if (phase.kind === "closed") {
      return { kind: "closed", pull: phase.pull };
    }
    if (phase.kind === "not_found") {
      return { kind: "not_found" };
    }
    if (phase.kind === "error") {
      // Transient errors: surface but keep polling.
    }
    await sleep(Math.max(100, intervalMs));
  }
  return { kind: "aborted" };
}
