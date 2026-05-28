import {
  getAuthenticatedLogin,
  isHotfixTitle,
  searchAuthorPullRequests,
  type SearchIssueItem,
} from "./githubClient";
import { parseGithubPullUrl, type ParsedPrUrl } from "./hotfixRunHelpers";

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_LOOKBACK_MS = 4 * 60 * 60 * 1000;

export type DiscoverHotfixPrOptions = {
  token: string;
  owner: string;
  repo: string;
  /** PRs that triggered this hotfix run — logged for traceability only. */
  sourcePrNumbers?: readonly number[];
  /** Only consider PRs created at or after this epoch ms. */
  notBeforeMs?: number;
  log?: (msg: string) => void;
};

export type WaitForHotfixPrOptions = DiscoverHotfixPrOptions & {
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: { aborted: boolean };
};

function pickNewestHotfixCandidate(
  pulls: SearchIssueItem[],
  notBeforeMs: number,
  log: (msg: string) => void
): ParsedPrUrl | undefined {
  let best: SearchIssueItem | undefined;
  let bestCreated = 0;
  for (const p of pulls) {
    if (!isHotfixTitle(p.title)) {
      continue;
    }
    const created = p.created_at ? Date.parse(p.created_at) : 0;
    if (!Number.isFinite(created) || created < notBeforeMs) {
      continue;
    }
    if (!best || created > bestCreated) {
      best = p;
      bestCreated = created;
    }
  }
  if (!best) {
    log(`discovery: no [Hotfix] PR created since ${new Date(notBeforeMs).toISOString()}`);
    return undefined;
  }
  const parsed = parseGithubPullUrl(best.html_url);
  if (!parsed) {
    log(`discovery: newest candidate has unparseable url ${best.html_url}`);
    return undefined;
  }
  log(
    `discovery: picked #${parsed.prNumber} "${best.title}" (state=${best.state}, created=${best.created_at ?? "?"})`
  );
  return parsed;
}

/** One-shot scan of recent author PRs for a newly created hotfix PR. */
export async function discoverHotfixPullRequest(
  options: DiscoverHotfixPrOptions
): Promise<ParsedPrUrl | undefined> {
  const log = options.log ?? (() => {});
  const notBeforeMs = options.notBeforeMs ?? Date.now() - DEFAULT_LOOKBACK_MS;
  const author = await getAuthenticatedLogin(options.token);
  log(
    `discovery: scan author=${author} repo=${options.owner}/${options.repo} sources=${(options.sourcePrNumbers ?? []).join(",") || "none"}`
  );
  const pulls = await searchAuthorPullRequests(
    options.token,
    options.owner,
    options.repo,
    author,
    40
  );
  log(`discovery: author PR scan returned ${pulls.length} row(s)`);
  return pickNewestHotfixCandidate(pulls, notBeforeMs, log);
}

/**
 * Poll GitHub until a new [Hotfix] PR appears (or timeout / abort).
 * Used when fcli output did not include HOTFIX_PR_URL — especially after
 * integrated-terminal sendText fallback returns before fcli finishes.
 */
export async function waitForHotfixPullRequest(
  options: WaitForHotfixPrOptions
): Promise<ParsedPrUrl | undefined> {
  const log = options.log ?? (() => {});
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_MS);
  const timeoutMs = Math.max(pollIntervalMs, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const notBeforeMs = options.notBeforeMs ?? Date.now() - DEFAULT_LOOKBACK_MS;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  log(
    `discovery: polling every ${pollIntervalMs}ms for up to ${Math.round(timeoutMs / 1000)}s (notBefore=${new Date(notBeforeMs).toISOString()})`
  );

  while (!options.signal?.aborted) {
    attempt += 1;
    log(`discovery: poll attempt ${attempt}`);
    try {
      const found = await discoverHotfixPullRequest({
        ...options,
        notBeforeMs,
        log,
      });
      if (found) {
        return found;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`discovery: poll error (will retry): ${msg}`);
    }
    if (Date.now() >= deadline) {
      log(`discovery: timed out after ${attempt} attempt(s)`);
      return undefined;
    }
    await sleep(pollIntervalMs);
  }
  log("discovery: aborted");
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
