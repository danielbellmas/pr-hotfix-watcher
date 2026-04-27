import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitHubError,
  isOpenOrMergedPull,
  isOpenOrMergedSearchItem,
  searchAuthorPullRequests,
  type GitHubPull,
  type SearchIssueItem,
} from "../src/githubClient";

function searchItem(p: Partial<SearchIssueItem>): SearchIssueItem {
  return {
    number: 1,
    title: "t",
    state: "open",
    html_url: "https://github.com/o/r/pull/1",
    ...p,
  };
}

function pull(p: Partial<GitHubPull>): GitHubPull {
  return {
    number: 1,
    title: "t",
    state: "open",
    merged_at: null,
    created_at: "2024-06-01T12:00:00Z",
    html_url: "https://github.com/o/r/pull/1",
    ...p,
  };
}

describe("isOpenOrMergedSearchItem", () => {
  it("accepts open", () => {
    expect(isOpenOrMergedSearchItem(searchItem({ state: "open" }))).toBe(true);
  });
  it("accepts closed merged", () => {
    expect(
      isOpenOrMergedSearchItem(
        searchItem({
          state: "closed",
          pull_request: { merged_at: "2024-01-01T00:00:00Z" },
        })
      )
    ).toBe(true);
  });
  it("rejects closed without merge", () => {
    expect(
      isOpenOrMergedSearchItem(
        searchItem({ state: "closed", pull_request: {} })
      )
    ).toBe(false);
    expect(
      isOpenOrMergedSearchItem(
        searchItem({ state: "closed", pull_request: { merged_at: null } })
      )
    ).toBe(false);
  });
});

describe("isOpenOrMergedPull", () => {
  it("accepts open", () => {
    expect(isOpenOrMergedPull(pull({ state: "open", merged_at: null }))).toBe(
      true
    );
  });
  it("accepts merged", () => {
    expect(
      isOpenOrMergedPull(
        pull({ state: "closed", merged_at: "2024-01-01T00:00:00Z" })
      )
    ).toBe(true);
  });
  it("rejects closed without merge", () => {
    expect(isOpenOrMergedPull(pull({ state: "closed", merged_at: null }))).toBe(
      false
    );
  });

  it("treats merged_at as authoritative over state for inclusion", () => {
    expect(
      isOpenOrMergedPull(
        pull({ state: "closed", merged_at: "2024-01-01T00:00:00Z" })
      )
    ).toBe(true);
    expect(
      isOpenOrMergedPull(
        pull({ state: "open", merged_at: "2024-01-01T00:00:00Z" })
      )
    ).toBe(true);
  });
});

describe("GitHubError", () => {
  it("carries status and message", () => {
    const e = new GitHubError("nope", 404);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("GitHubError");
    expect(e.message).toBe("nope");
    expect(e.status).toBe(404);
  });
});

type RepoPullListItem = {
  number: number;
  title: string;
  state: string;
  created_at: string;
  html_url: string;
  merged_at: string | null;
  user: { login: string } | null;
};

function pullListItem(p: Partial<RepoPullListItem>): RepoPullListItem {
  return {
    number: p.number ?? 1,
    title: p.title ?? "title",
    state: p.state ?? "open",
    created_at: p.created_at ?? "2026-04-27T12:00:00Z",
    html_url:
      p.html_url ?? `https://github.com/o/r/pull/${p.number ?? 1}`,
    merged_at: p.merged_at ?? null,
    user: p.user === undefined ? { login: "alice" } : p.user,
  };
}

function stubFetchOnce(
  body: unknown,
  status = 200
): { calls: { url: string; init?: RequestInit }[]; restore: () => void } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

describe("searchAuthorPullRequests", () => {
  afterEach(() => vi.restoreAllMocks());

  it("hits the Pulls List API (not /search/issues) with sort=updated&direction=desc", async () => {
    const stub = stubFetchOnce([]);
    try {
      await searchAuthorPullRequests("t0k3n", "owner", "repo", "alice", 20);
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0].url).toBe(
        "https://api.github.com/repos/owner/repo/pulls?state=all&sort=updated&direction=desc&per_page=100"
      );
    } finally {
      stub.restore();
    }
  });

  it("filters by author.login and preserves API order (updated-desc)", async () => {
    const stub = stubFetchOnce([
      pullListItem({ number: 100, user: { login: "bob" } }),
      pullListItem({ number: 99, user: { login: "alice" } }),
      pullListItem({ number: 98, user: { login: "carol" } }),
      pullListItem({ number: 97, user: { login: "alice" } }),
    ]);
    try {
      const got = await searchAuthorPullRequests(
        "t",
        "o",
        "r",
        "alice",
        10
      );
      expect(got.map((x) => x.number)).toEqual([99, 97]);
    } finally {
      stub.restore();
    }
  });

  it("caps the result at perPage even when more authored PRs are present", async () => {
    const stub = stubFetchOnce(
      Array.from({ length: 30 }, (_, i) =>
        pullListItem({ number: 1000 - i, user: { login: "alice" } })
      )
    );
    try {
      const got = await searchAuthorPullRequests("t", "o", "r", "alice", 5);
      expect(got).toHaveLength(5);
      expect(got[0].number).toBe(1000);
      expect(got[4].number).toBe(996);
    } finally {
      stub.restore();
    }
  });

  it("clamps perPage to [1, 100]", async () => {
    const items = Array.from({ length: 200 }, (_, i) =>
      pullListItem({ number: 1000 - i, user: { login: "alice" } })
    );
    const stubHi = stubFetchOnce(items);
    try {
      const hi = await searchAuthorPullRequests("t", "o", "r", "alice", 999);
      expect(hi.length).toBeLessThanOrEqual(100);
    } finally {
      stubHi.restore();
    }
    const stubLo = stubFetchOnce(items);
    try {
      const lo = await searchAuthorPullRequests("t", "o", "r", "alice", 0);
      expect(lo).toHaveLength(1);
    } finally {
      stubLo.restore();
    }
  });

  it("maps top-level merged_at into pull_request.merged_at for downstream isOpenOrMergedSearchItem", async () => {
    const stub = stubFetchOnce([
      pullListItem({
        number: 50,
        state: "closed",
        merged_at: "2026-04-25T10:00:00Z",
        user: { login: "alice" },
      }),
      pullListItem({
        number: 49,
        state: "closed",
        merged_at: null,
        user: { login: "alice" },
      }),
    ]);
    try {
      const got = await searchAuthorPullRequests("t", "o", "r", "alice", 10);
      expect(got[0].pull_request?.merged_at).toBe("2026-04-25T10:00:00Z");
      expect(got[1].pull_request?.merged_at).toBeNull();
      expect(isOpenOrMergedSearchItem(got[0])).toBe(true);
      expect(isOpenOrMergedSearchItem(got[1])).toBe(false);
    } finally {
      stub.restore();
    }
  });

  it("returns [] when no PR matches the author (the bug we are fixing did the same — verify no crash)", async () => {
    const stub = stubFetchOnce([
      pullListItem({ number: 1, user: { login: "bob" } }),
    ]);
    try {
      const got = await searchAuthorPullRequests(
        "t",
        "o",
        "r",
        "danielbellmas",
        20
      );
      expect(got).toEqual([]);
    } finally {
      stub.restore();
    }
  });

  it("survives a missing user object (anonymous / ghost user) without throwing", async () => {
    const stub = stubFetchOnce([
      pullListItem({ number: 5, user: null }),
      pullListItem({ number: 6, user: { login: "alice" } }),
    ]);
    try {
      const got = await searchAuthorPullRequests("t", "o", "r", "alice", 10);
      expect(got.map((x) => x.number)).toEqual([6]);
    } finally {
      stub.restore();
    }
  });

  it("surfaces a GitHubError on non-2xx (token / permission failures stay loud)", async () => {
    const stub = stubFetchOnce({ message: "Bad credentials" }, 401);
    try {
      await expect(
        searchAuthorPullRequests("t", "o", "r", "alice", 10)
      ).rejects.toBeInstanceOf(GitHubError);
    } finally {
      stub.restore();
    }
  });
});
