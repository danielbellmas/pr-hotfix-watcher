import { describe, expect, it } from "vitest";
import {
  formatPrLabels,
  parseGithubPullUrl,
  parseHotfixCliJson,
  parseHotfixPrUrl,
  parseHotfixRunMode,
  truncateRunLogTail,
} from "../src/hotfixRunHelpers";

describe("parseHotfixRunMode", () => {
  it("maps background and defaults everything else to integratedTerminal", () => {
    expect(parseHotfixRunMode("background")).toBe("background");
    expect(parseHotfixRunMode("integratedTerminal")).toBe("integratedTerminal");
    expect(parseHotfixRunMode(undefined)).toBe("integratedTerminal");
    expect(parseHotfixRunMode("")).toBe("integratedTerminal");
    expect(parseHotfixRunMode("nope")).toBe("integratedTerminal");
  });
});

describe("formatPrLabels", () => {
  it("formats PR numbers", () => {
    expect(formatPrLabels([1, 22])).toBe("#1, #22");
  });
});

describe("truncateRunLogTail", () => {
  it("returns short text unchanged (normalized whitespace)", () => {
    expect(truncateRunLogTail("  hello\nworld  ", 100)).toBe("hello world");
  });

  it("truncates from the left with ellipsis", () => {
    const long = "x".repeat(400);
    const out = truncateRunLogTail(long, 50);
    expect(out.length).toBeLessThanOrEqual(51);
    expect(out.startsWith("…")).toBe(true);
  });
});

describe("parseHotfixPrUrl", () => {
  it("returns undefined for empty or missing marker", () => {
    expect(parseHotfixPrUrl("")).toBeUndefined();
    expect(parseHotfixPrUrl("nothing relevant here")).toBeUndefined();
  });

  it("extracts a HOTFIX_PR_URL= line from fcli output", () => {
    const out = [
      "fcli: creating branch…",
      "fcli: opening pull request…",
      "HOTFIX_PR_URL=https://github.com/arnac-io/arnac/pull/12345",
      "fcli: done.",
    ].join("\n");
    expect(parseHotfixPrUrl(out)).toBe(
      "https://github.com/arnac-io/arnac/pull/12345"
    );
  });

  it("tolerates surrounding whitespace and CRLF", () => {
    const out =
      "prefix\r\n   HOTFIX_PR_URL = https://github.com/arnac-io/arnac/pull/7 \r\nsuffix";
    expect(parseHotfixPrUrl(out)).toBe(
      "https://github.com/arnac-io/arnac/pull/7"
    );
  });

  it("strips ANSI color codes before matching", () => {
    const out = `\u001b[32mHOTFIX_PR_URL=\u001b[0m\u001b[1mhttps://github.com/arnac-io/arnac/pull/42\u001b[0m`;
    expect(parseHotfixPrUrl(out)).toBe(
      "https://github.com/arnac-io/arnac/pull/42"
    );
  });

  it("returns the last match when multiple are present", () => {
    const out = [
      "HOTFIX_PR_URL=https://github.com/arnac-io/arnac/pull/1",
      "HOTFIX_PR_URL=https://github.com/arnac-io/arnac/pull/2",
    ].join("\n");
    expect(parseHotfixPrUrl(out)).toBe(
      "https://github.com/arnac-io/arnac/pull/2"
    );
  });
});

describe("parseHotfixCliJson", () => {
  const baseEntry = {
    environment: "pre",
    release_branch: "release/2024-04-22",
    hotfix_branch: "hotfix/release/2024-04-22/foo",
    pr_number: 123,
    html_url: "https://github.com/arnac-io/arnac/pull/123",
    draft: false,
  };

  it("returns undefined for empty/non-JSON output (caller falls back to regex)", () => {
    expect(parseHotfixCliJson("")).toBeUndefined();
    expect(parseHotfixCliJson("HOTFIX_PR_URL=…\n")).toBeUndefined();
    expect(parseHotfixCliJson("not json {nope}")).toBeUndefined();
  });

  it("parses a single-env (pre) payload", () => {
    const payload = JSON.stringify({
      prs: [baseEntry],
      source_pr_numbers: [42],
    });
    const out = `fcli noise…\n${payload}\n`;
    const got = parseHotfixCliJson(out);
    expect(got).toEqual([
      {
        env: "pre",
        prNumber: 123,
        htmlUrl: "https://github.com/arnac-io/arnac/pull/123",
        releaseBranch: "release/2024-04-22",
        hotfixBranch: "hotfix/release/2024-04-22/foo",
        draft: false,
      },
    ]);
  });

  it("parses both pre and prod entries preserving JSON order", () => {
    const payload = JSON.stringify({
      prs: [
        baseEntry,
        {
          ...baseEntry,
          environment: "prod",
          pr_number: 124,
          html_url: "https://github.com/arnac-io/arnac/pull/124",
        },
      ],
      source_pr_numbers: [42],
    });
    const got = parseHotfixCliJson(payload);
    expect(got?.map((e) => [e.env, e.prNumber])).toEqual([
      ["pre", 123],
      ["prod", 124],
    ]);
  });

  it("ignores trailing log noise and picks the JSON payload", () => {
    const payload = JSON.stringify({
      prs: [baseEntry],
      source_pr_numbers: [42],
    });
    const out = `${payload}\n[deploy] queued some other thing\nbye\n`;
    expect(parseHotfixCliJson(out)?.[0].prNumber).toBe(123);
  });

  it("strips ANSI before parsing the JSON line", () => {
    const payload = JSON.stringify({
      prs: [baseEntry],
      source_pr_numbers: [42],
    });
    const out = `\u001b[32m${payload}\u001b[0m\n`;
    expect(parseHotfixCliJson(out)?.[0].env).toBe("pre");
  });

  it("rejects entries with unknown environment values", () => {
    const payload = JSON.stringify({
      prs: [{ ...baseEntry, environment: "staging" }],
    });
    expect(parseHotfixCliJson(payload)).toBeUndefined();
  });

  it("rejects entries with missing pr_number or html_url", () => {
    expect(
      parseHotfixCliJson(
        JSON.stringify({ prs: [{ ...baseEntry, pr_number: null }] })
      )
    ).toBeUndefined();
    expect(
      parseHotfixCliJson(
        JSON.stringify({ prs: [{ ...baseEntry, html_url: "" }] })
      )
    ).toBeUndefined();
  });

  it("returns undefined when prs is missing or not an array", () => {
    expect(
      parseHotfixCliJson(JSON.stringify({ prs: "nope" }))
    ).toBeUndefined();
    expect(
      parseHotfixCliJson(JSON.stringify({ source_pr_numbers: [1] }))
    ).toBeUndefined();
  });
});

describe("parseGithubPullUrl", () => {
  it("parses owner/repo/number from a standard GitHub PR URL", () => {
    expect(
      parseGithubPullUrl("https://github.com/arnac-io/arnac/pull/123")
    ).toEqual({
      owner: "arnac-io",
      repo: "arnac",
      prNumber: 123,
    });
  });

  it("ignores trailing slashes and fragments", () => {
    expect(
      parseGithubPullUrl(
        "https://github.com/arnac-io/arnac/pull/123/files#diff-xyz"
      )
    ).toEqual({
      owner: "arnac-io",
      repo: "arnac",
      prNumber: 123,
    });
  });

  it("returns undefined for malformed URLs", () => {
    expect(parseGithubPullUrl("not a url")).toBeUndefined();
    expect(
      parseGithubPullUrl("https://github.com/arnac-io/arnac/issues/1")
    ).toBeUndefined();
    expect(
      parseGithubPullUrl("https://github.com/arnac-io/arnac/pull/abc")
    ).toBeUndefined();
  });
});
