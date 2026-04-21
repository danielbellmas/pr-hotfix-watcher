import { describe, expect, it } from "vitest";
import { GitHubError, type GitHubPull } from "../src/githubClient";
import {
  phaseFromHotfixPull,
  phaseFromHotfixSettled,
  watchHotfixPrMerge,
} from "../src/hotfixPrMergeWatch";

function pull(overrides: Partial<GitHubPull> = {}): GitHubPull {
  return {
    number: 123,
    title: "Hotfix: something",
    state: "open",
    merged_at: null,
    created_at: "2026-04-21T00:00:00Z",
    html_url: "https://github.com/arnac-io/arnac/pull/123",
    ...overrides,
  };
}

describe("phaseFromHotfixPull", () => {
  it("returns merged when merged_at is set", () => {
    const p = pull({ merged_at: "2026-04-21T10:00:00Z", state: "closed" });
    expect(phaseFromHotfixPull(p)).toEqual({ kind: "merged", pull: p });
  });

  it("returns closed when state=closed and not merged", () => {
    const p = pull({ state: "closed" });
    expect(phaseFromHotfixPull(p)).toEqual({ kind: "closed", pull: p });
  });

  it("returns waiting when still open", () => {
    const p = pull();
    expect(phaseFromHotfixPull(p)).toEqual({ kind: "waiting", pull: p });
  });
});

describe("phaseFromHotfixSettled", () => {
  it("maps a 404 rejection to not_found", () => {
    const settled: PromiseSettledResult<GitHubPull> = {
      status: "rejected",
      reason: new GitHubError("missing", 404),
    };
    expect(phaseFromHotfixSettled(settled)).toEqual({ kind: "not_found" });
  });

  it("maps other rejections to error with message", () => {
    const settled: PromiseSettledResult<GitHubPull> = {
      status: "rejected",
      reason: new Error("boom"),
    };
    expect(phaseFromHotfixSettled(settled)).toEqual({
      kind: "error",
      message: "boom",
    });
  });

  it("delegates to phaseFromHotfixPull for fulfilled results", () => {
    const p = pull({ merged_at: "2026-04-21T10:00:00Z" });
    expect(
      phaseFromHotfixSettled({ status: "fulfilled", value: p })
    ).toEqual({
      kind: "merged",
      pull: p,
    });
  });
});

describe("watchHotfixPrMerge", () => {
  it("resolves merged after polling through open states", async () => {
    const sequence: GitHubPull[] = [
      pull(),
      pull(),
      pull({ merged_at: "2026-04-21T10:00:00Z", state: "closed" }),
    ];
    let calls = 0;
    const res = await watchHotfixPrMerge({
      token: "t",
      owner: "o",
      repo: "r",
      prNumber: 1,
      intervalMs: 0,
      fetch: async () => sequence[calls++],
      sleep: async () => undefined,
    });
    expect(calls).toBe(3);
    expect(res.kind).toBe("merged");
  });

  it("stops on closed-without-merge", async () => {
    const res = await watchHotfixPrMerge({
      token: "t",
      owner: "o",
      repo: "r",
      prNumber: 1,
      intervalMs: 0,
      fetch: async () => pull({ state: "closed" }),
      sleep: async () => undefined,
    });
    expect(res.kind).toBe("closed");
  });

  it("stops on 404 not found", async () => {
    const res = await watchHotfixPrMerge({
      token: "t",
      owner: "o",
      repo: "r",
      prNumber: 1,
      intervalMs: 0,
      fetch: async () => {
        throw new GitHubError("missing", 404);
      },
      sleep: async () => undefined,
    });
    expect(res.kind).toBe("not_found");
  });

  it("keeps polling on transient errors until signal aborts", async () => {
    const signal = { aborted: false };
    let calls = 0;
    const p = watchHotfixPrMerge({
      token: "t",
      owner: "o",
      repo: "r",
      prNumber: 1,
      intervalMs: 0,
      signal,
      fetch: async () => {
        calls++;
        if (calls >= 3) {
          signal.aborted = true;
        }
        throw new Error("network flaked");
      },
      sleep: async () => undefined,
    });
    const res = await p;
    expect(res.kind).toBe("aborted");
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});
