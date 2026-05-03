import { describe, expect, it } from "vitest";
import {
  buildDeployNotification,
  buildOsNotificationScript,
  type DeployNotificationInput,
} from "../src/osNotify";

const baseEnv = "pre" as const;

describe("buildDeployNotification", () => {
  it("renders success with env subtitle and PR list body", () => {
    const got = buildDeployNotification({
      outcome: { kind: "success" },
      env: baseEnv,
      sourcePrNumbers: [123, 124],
    });
    expect(got).toEqual({
      title: "Hotfix deploy succeeded",
      subtitle: "env: pre",
      body: "PRs: #123, #124",
    });
  });

  it("singularises body when one PR was batched", () => {
    const got = buildDeployNotification({
      outcome: { kind: "success" },
      env: "prod",
      sourcePrNumbers: [42],
    });
    expect(got.body).toBe("PR: #42");
  });

  it("sorts PR numbers ascending in the body", () => {
    const got = buildDeployNotification({
      outcome: { kind: "success" },
      env: "prod",
      sourcePrNumbers: [200, 5, 73],
    });
    expect(got.body).toBe("PRs: #5, #73, #200");
  });

  it("emits empty body when no PRs are known", () => {
    const got = buildDeployNotification({
      outcome: { kind: "success" },
      env: "both",
    });
    expect(got.body).toBe("");
  });

  it("renders failure with exit code in subtitle", () => {
    const got = buildDeployNotification({
      outcome: { kind: "failure", exitCode: 17 },
      env: "prod",
      sourcePrNumbers: [9],
    });
    expect(got).toEqual({
      title: "Hotfix deploy FAILED",
      subtitle: "env: prod — exit 17",
      body: "PR: #9",
    });
  });

  it("renders unknown-exit case (terminal mode without shell integration reporting)", () => {
    const got = buildDeployNotification({
      outcome: { kind: "unknown" },
      env: "pre",
      sourcePrNumbers: [1, 2],
    });
    expect(got).toEqual({
      title: "Hotfix deploy finished",
      subtitle: "env: pre — exit unknown",
      body: "PRs: #1, #2",
    });
  });

  it("renders signaled case with the signal name", () => {
    const got = buildDeployNotification({
      outcome: { kind: "signaled", signal: "SIGTERM" },
      env: "pre",
      sourcePrNumbers: [10],
    });
    expect(got).toEqual({
      title: "Hotfix deploy stopped",
      subtitle: "env: pre — signal SIGTERM",
      body: "PR: #10",
    });
  });

  it("renders spawn_error with the message in the body and PRs appended", () => {
    const got = buildDeployNotification({
      outcome: { kind: "spawn_error", message: "ENOENT: bash not found" },
      env: "pre",
      sourcePrNumbers: [55, 56],
    });
    expect(got.title).toBe("Hotfix deploy did not start");
    expect(got.subtitle).toBe("env: pre");
    expect(got.body).toBe("ENOENT: bash not found — PRs: #55, #56");
  });

  it("truncates long spawn_error messages at 120 chars with an ellipsis", () => {
    const long = "x".repeat(200);
    const got = buildDeployNotification({
      outcome: { kind: "spawn_error", message: long },
      env: "pre",
    });
    expect(got.body.length).toBeLessThanOrEqual(120);
    expect(got.body.endsWith("…")).toBe(true);
  });

  it("omits the dash separator when spawn_error has no PR list", () => {
    const got = buildDeployNotification({
      outcome: { kind: "spawn_error", message: "boom" },
      env: "pre",
    });
    expect(got.body).toBe("boom");
  });

  it("works for env=both (legacy regex / manual prompt path)", () => {
    const got = buildDeployNotification({
      outcome: { kind: "success" },
      env: "both",
      sourcePrNumbers: [7],
    });
    expect(got.subtitle).toBe("env: both");
  });

  type Case = {
    name: string;
    input: DeployNotificationInput;
    expectTitle: string;
  };

  const titleTable: Case[] = [
    {
      name: "success",
      input: { outcome: { kind: "success" }, env: "pre" },
      expectTitle: "Hotfix deploy succeeded",
    },
    {
      name: "failure",
      input: {
        outcome: { kind: "failure", exitCode: 1 },
        env: "pre",
      },
      expectTitle: "Hotfix deploy FAILED",
    },
    {
      name: "unknown",
      input: { outcome: { kind: "unknown" }, env: "pre" },
      expectTitle: "Hotfix deploy finished",
    },
    {
      name: "signaled",
      input: {
        outcome: { kind: "signaled", signal: "SIGINT" },
        env: "pre",
      },
      expectTitle: "Hotfix deploy stopped",
    },
    {
      name: "spawn_error",
      input: {
        outcome: { kind: "spawn_error", message: "boom" },
        env: "pre",
      },
      expectTitle: "Hotfix deploy did not start",
    },
  ];

  it.each(titleTable)("title for $name is glanceable", ({ input, expectTitle }) => {
    expect(buildDeployNotification(input).title).toBe(expectTitle);
  });
});

describe("buildOsNotificationScript", () => {
  it("emits a 3-field display notification when subtitle is present", () => {
    const got = buildOsNotificationScript({
      title: "Hotfix deploy succeeded",
      subtitle: "env: pre",
      body: "PR: #42",
    });
    expect(got).toBe(
      `display notification "PR: #42" with title "Hotfix deploy succeeded" subtitle "env: pre"`
    );
  });

  it("omits the subtitle clause when not provided", () => {
    const got = buildOsNotificationScript({
      title: "t",
      body: "b",
    });
    expect(got).toBe(`display notification "b" with title "t"`);
  });

  it("escapes embedded double-quotes in title/subtitle/body", () => {
    const got = buildOsNotificationScript({
      title: 'a"b',
      subtitle: 'c"d',
      body: 'e"f',
    });
    expect(got).toBe(`display notification "e\\"f" with title "a\\"b" subtitle "c\\"d"`);
  });

  it("escapes backslashes before quotes (order matters)", () => {
    // Input literal: backslash, quote (two chars). After escape: two
    // backslashes, then escaped quote — i.e. `\\\"` (four chars in JS,
    // rendered as `\\\"` inside the AppleScript source).
    const got = buildOsNotificationScript({
      title: "ok",
      body: '\\"',
    });
    expect(got).toBe(`display notification "\\\\\\"" with title "ok"`);
  });

  it("collapses CR/LF runs to a single space inside fields", () => {
    const got = buildOsNotificationScript({
      title: "line1\nline2",
      body: "a\r\n\r\nb",
    });
    expect(got).toBe(`display notification "a b" with title "line1 line2"`);
  });

  it("leaves non-ASCII (em dash, accents) untouched — osascript reads UTF-8", () => {
    const got = buildOsNotificationScript({
      title: "Hotfix deploy FAILED",
      subtitle: "env: pre — exit 17",
      body: "PRs: #123, #124",
    });
    expect(got).toContain("env: pre — exit 17");
    expect(got).toContain("PRs: #123, #124");
  });
});
