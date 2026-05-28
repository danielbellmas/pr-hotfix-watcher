import { describe, expect, it, vi } from "vitest";
import { discoverHotfixPullRequest, waitForHotfixPullRequest } from "../src/hotfixPrDiscovery";
import * as githubClient from "../src/githubClient";

describe("discoverHotfixPullRequest", () => {
  it("picks the newest [Hotfix] PR created after notBeforeMs", async () => {
    vi.spyOn(githubClient, "getAuthenticatedLogin").mockResolvedValue("alice");
    vi.spyOn(githubClient, "searchAuthorPullRequests").mockResolvedValue([
      {
        number: 1,
        title: "Regular change",
        state: "open",
        html_url: "https://github.com/acme/service/pull/1",
        created_at: "2026-05-28T10:00:00Z",
      },
      {
        number: 2,
        title: "[Hotfix] Fix prod",
        state: "open",
        html_url: "https://github.com/acme/service/pull/2",
        created_at: "2026-05-28T10:05:00Z",
      },
      {
        number: 3,
        title: "[Hotfix] Older",
        state: "open",
        html_url: "https://github.com/acme/service/pull/3",
        created_at: "2026-05-28T09:00:00Z",
      },
    ]);

    const found = await discoverHotfixPullRequest({
      token: "t",
      owner: "acme",
      repo: "service",
      notBeforeMs: Date.parse("2026-05-28T09:30:00Z"),
      log: () => {},
    });

    expect(found).toEqual({ owner: "acme", repo: "service", prNumber: 2 });
  });
});

describe("waitForHotfixPullRequest", () => {
  it("returns on first successful discovery", async () => {
    vi.spyOn(githubClient, "getAuthenticatedLogin").mockResolvedValue("alice");
    vi.spyOn(githubClient, "searchAuthorPullRequests").mockResolvedValue([
      {
        number: 9,
        title: "[Hotfix] Found",
        state: "open",
        html_url: "https://github.com/acme/service/pull/9",
        created_at: "2026-05-28T12:00:00Z",
      },
    ]);

    const found = await waitForHotfixPullRequest({
      token: "t",
      owner: "acme",
      repo: "service",
      pollIntervalMs: 1,
      timeoutMs: 50,
      notBeforeMs: Date.parse("2026-05-28T11:00:00Z"),
      log: () => {},
    });

    expect(found).toEqual({ owner: "acme", repo: "service", prNumber: 9 });
  });
});
