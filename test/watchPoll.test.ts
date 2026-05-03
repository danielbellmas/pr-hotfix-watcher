import { describe, expect, it } from "vitest";
import { GitHubError, type GitHubPull } from "../src/githubClient";
import { phaseFromSettledPulls } from "../src/watchPoll";

function mkPull(over: Partial<GitHubPull> & Pick<GitHubPull, "number">): GitHubPull {
  return {
    title: "t",
    state: "open",
    merged_at: null,
    created_at: "2024-01-01T00:00:00Z",
    html_url: "https://github.com/o/r/pull/1",
    ...over,
  };
}

function fulfilled(p: GitHubPull): PromiseSettledResult<GitHubPull> {
  return { status: "fulfilled", value: p };
}

function rejected(reason: unknown): PromiseSettledResult<GitHubPull> {
  return { status: "rejected", reason };
}

describe("phaseFromSettledPulls (watch until merge)", () => {
  it("continues while any PR is still open (not merged)", () => {
    const target = [10, 20] as const;
    const settled = [
      fulfilled(mkPull({ number: 10, merged_at: null, state: "open" })),
      fulfilled(mkPull({ number: 20, merged_at: null, state: "open" })),
    ];
    expect(phaseFromSettledPulls(target, settled)).toEqual({
      kind: "continue",
      pendingNumbers: [10, 20],
    });
  });

  it("continues when one merged and one still open", () => {
    const target = [10, 20] as const;
    const settled = [
      fulfilled(
        mkPull({
          number: 10,
          merged_at: "2024-02-01T00:00:00Z",
          state: "closed",
        })
      ),
      fulfilled(mkPull({ number: 20, merged_at: null, state: "open" })),
    ];
    expect(phaseFromSettledPulls(target, settled)).toEqual({
      kind: "continue",
      pendingNumbers: [20],
    });
  });

  it("all_merged when every PR has merged_at set", () => {
    const target = [1, 2] as const;
    const settled = [
      fulfilled(
        mkPull({
          number: 1,
          merged_at: "2024-01-01T00:00:00Z",
          state: "closed",
        })
      ),
      fulfilled(
        mkPull({
          number: 2,
          merged_at: "2024-01-02T00:00:00Z",
          state: "closed",
        })
      ),
    ];
    expect(phaseFromSettledPulls(target, settled)).toEqual({
      kind: "all_merged",
    });
  });

  it("stops on 404 for any watched PR", () => {
    const target = [99, 100] as const;
    const settled = [
      rejected(new GitHubError("Not Found", 404)),
      fulfilled(mkPull({ number: 100, merged_at: null, state: "open" })),
    ];
    expect(phaseFromSettledPulls(target, settled)).toEqual({
      kind: "stop_404",
      prNumber: 99,
    });
  });

  it("poll_error on non-404 rejection (watch keeps running in provider)", () => {
    const target = [1] as const;
    const settled = [rejected(new Error("rate limit"))];
    expect(phaseFromSettledPulls(target, settled)).toEqual({
      kind: "poll_error",
      message: "rate limit",
    });
  });

  it("stops when a PR is closed without merge", () => {
    const target = [5] as const;
    const settled = [fulfilled(mkPull({ number: 5, merged_at: null, state: "closed" }))];
    expect(phaseFromSettledPulls(target, settled)).toEqual({
      kind: "stop_closed",
      prNumbers: [5],
    });
  });

  it("reports multiple closed-without-merge numbers", () => {
    const target = [1, 2] as const;
    const settled = [
      fulfilled(mkPull({ number: 1, merged_at: null, state: "closed" })),
      fulfilled(mkPull({ number: 2, merged_at: null, state: "closed" })),
    ];
    expect(phaseFromSettledPulls(target, settled)).toEqual({
      kind: "stop_closed",
      prNumbers: [1, 2],
    });
  });

  it("returns poll_error when settled length mismatches targets", () => {
    const phase = phaseFromSettledPulls([1, 2], [fulfilled(mkPull({ number: 1 }))]);
    expect(phase).toMatchObject({
      kind: "poll_error",
      message: expect.stringContaining("mismatch"),
    });
  });

  it("404 on second watched PR still reports that PR number", () => {
    const target = [10, 20] as const;
    const settled = [
      fulfilled(mkPull({ number: 10, merged_at: null, state: "open" })),
      rejected(new GitHubError("gone", 404)),
    ];
    expect(phaseFromSettledPulls(target, settled)).toEqual({
      kind: "stop_404",
      prNumber: 20,
    });
  });

  it("poll_error for GitHubError with non-404 status", () => {
    const settled = [rejected(new GitHubError("Forbidden", 403))];
    expect(phaseFromSettledPulls([7], settled)).toEqual({
      kind: "poll_error",
      message: "Forbidden",
    });
  });

  it("all_merged when merged_at is set even if state is still open (API oddity)", () => {
    const settled = [
      fulfilled(mkPull({ number: 1, merged_at: "2024-01-01T00:00:00Z", state: "open" })),
    ];
    expect(phaseFromSettledPulls([1], settled)).toEqual({ kind: "all_merged" });
  });
});
