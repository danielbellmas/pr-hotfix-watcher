import { describe, expect, it } from "vitest";
import {
  GitHubError,
  isOpenOrMergedPull,
  isOpenOrMergedSearchItem,
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
