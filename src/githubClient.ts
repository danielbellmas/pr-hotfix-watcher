export type GitHubPull = {
  number: number;
  title: string;
  state: string;
  merged_at: string | null;
  created_at: string;
  html_url: string;
};

export type SearchIssueItem = {
  number: number;
  title: string;
  state: string;
  created_at?: string;
  pull_request?: { merged_at?: string | null };
  html_url: string;
};

/**
 * Best-effort filter on `/search/issues` rows. Search payloads often omit
 * `pull_request.merged_at` for merged PRs, so do not use this to gate `getPullRequest`;
 * use {@link isOpenOrMergedPull} on the pulls API response instead.
 */
export function isOpenOrMergedSearchItem(it: SearchIssueItem): boolean {
  const merged = Boolean(it.pull_request?.merged_at);
  return it.state === "open" || merged;
}

export function isOpenOrMergedPull(p: GitHubPull): boolean {
  return p.state === "open" || Boolean(p.merged_at);
}

export class GitHubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GitHubError";
  }
}

/**
 * Handler invoked on any 401 response. Registered by `extension.ts` to bust
 * the `gh auth token` cache so a fresh `gh auth login` recovers on the very
 * next API call instead of waiting out the 30-second cache TTL.
 */
let authFailureHandler: (() => void) | undefined;

export function setAuthFailureHandler(fn: (() => void) | undefined): void {
  authFailureHandler = fn;
}

async function githubJson<T>(
  path: string,
  token: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`,
      ...init?.headers,
    },
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 && authFailureHandler) {
      try {
        authFailureHandler();
      } catch {
        // swallow — cache invalidation is best-effort
      }
    }
    throw new GitHubError(text || res.statusText, res.status);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export async function getAuthenticatedLogin(token: string): Promise<string> {
  const u = await githubJson<{ login: string }>("/user", token);
  return u.login;
}

export type SearchResult = {
  items: SearchIssueItem[];
  total_count: number;
};

export async function searchAuthorPullRequests(
  token: string,
  owner: string,
  repo: string,
  authorLogin: string,
  perPage: number
): Promise<SearchIssueItem[]> {
  const q = `is:pr author:${authorLogin} repo:${owner}/${repo} sort:updated-desc`;
  const path = `/search/issues?q=${encodeURIComponent(q)}&per_page=${Math.min(
    perPage,
    100
  )}`;
  const data = await githubJson<SearchResult>(path, token);
  return data.items ?? [];
}

export async function searchRepoPullRequests(
  token: string,
  owner: string,
  repo: string,
  text: string,
  perPage: number
): Promise<SearchIssueItem[]> {
  const q = `is:pr repo:${owner}/${repo} ${text}`.trim();
  const path = `/search/issues?q=${encodeURIComponent(q)}&per_page=${Math.min(
    Math.max(perPage, 1),
    100
  )}`;
  const data = await githubJson<SearchResult>(path, token);
  return data.items ?? [];
}

export async function getPullRequest(
  token: string,
  owner: string,
  repo: string,
  number: number
): Promise<GitHubPull> {
  return githubJson<GitHubPull>(
    `/repos/${owner}/${repo}/pulls/${number}`,
    token
  );
}
