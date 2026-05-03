import { describe, expect, it } from "vitest";
import { type HotfixCliEnv } from "../src/hotfixCli";
import {
  buildDeployShellScript,
  buildGhRunListSnapshotLatestId,
  buildGhWaitForNewAndCompleteRun,
  buildGhWorkflowRunCommand,
  shellQuote,
  type DeployTargets,
} from "../src/deployWorkflow";

const targets: DeployTargets = {
  repoSlug: "arnac-io/workflows",
  preWorkflow: "pre-hotfix.yml",
  prodWorkflow: "production-hotfix.yml",
  ref: "main",
};

describe("shellQuote", () => {
  it("wraps simple strings in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });
});

describe("buildGhWorkflowRunCommand", () => {
  it("emits a `gh workflow run` invocation with quoted args", () => {
    expect(
      buildGhWorkflowRunCommand({
        repoSlug: "arnac-io/workflows",
        workflow: "pre-hotfix.yml",
        ref: "main",
      })
    ).toBe("gh workflow run 'pre-hotfix.yml' --repo 'arnac-io/workflows' --ref 'main'");
  });
});

describe("buildGhRunListSnapshotLatestId", () => {
  it("captures the newest databaseId before dispatch (falls back to 0)", () => {
    const s = buildGhRunListSnapshotLatestId({
      repoSlug: "arnac-io/workflows",
      workflow: "pre-hotfix.yml",
      prevIdVar: "__hf_prev",
    });
    expect(s).toContain(
      "gh run list --repo 'arnac-io/workflows' --workflow 'pre-hotfix.yml' --limit 5 --json databaseId"
    );
    expect(s).toContain("| max // 0");
    expect(s).toMatch(/^__hf_prev=/);
  });
});

describe("buildGhWaitForNewAndCompleteRun", () => {
  const cmd = buildGhWaitForNewAndCompleteRun({
    repoSlug: "arnac-io/workflows",
    workflow: "pre-hotfix.yml",
    prevIdVar: "__hf_prev",
    runIdVar: "__hf_id",
  });

  it("waits for a databaseId strictly greater than the snapshot", () => {
    expect(cmd).toContain("select(. > $__hf_prev)");
  });

  it("uses `gh run view` with per-field -q to avoid multi-line JSON parsing", () => {
    expect(cmd).toContain(
      `gh run view "$__hf_id" --repo 'arnac-io/workflows' --json status -q '.status'`
    );
    expect(cmd).toContain(
      `gh run view "$__hf_id" --repo 'arnac-io/workflows' --json conclusion -q '.conclusion'`
    );
  });

  it("checks completion and fails on non-success conclusion", () => {
    expect(cmd).toContain(`if [ "$__hf_status" = "completed" ]; then`);
    expect(cmd).toContain(`if [ "$__hf_conclusion" = "success" ]; then`);
    expect(cmd).toContain("exit 1");
  });

  it("honors poll/timeout overrides", () => {
    const custom = buildGhWaitForNewAndCompleteRun({
      repoSlug: "o/r",
      workflow: "wf.yml",
      prevIdVar: "PREV",
      runIdVar: "ID",
      pollSeconds: 4,
      newRunTimeoutSeconds: 120,
      completionTimeoutSeconds: 900,
    });
    expect(custom).toContain("sleep 4");
    expect(custom).toContain("-ge 120");
    expect(custom).toContain("-ge 900");
  });
});

describe("buildDeployShellScript", () => {
  it("pre: only dispatches pre-hotfix.yml, never prod", () => {
    const s = buildDeployShellScript("pre", targets);
    expect(s).toContain(
      "gh workflow run 'pre-hotfix.yml' --repo 'arnac-io/workflows' --ref 'main'"
    );
    expect(s).not.toContain("production-hotfix.yml");
    expect(s).not.toMatch(/gh workflow run 'production/);
    expect(s.startsWith("set -e\n")).toBe(true);
  });

  it("prod: only dispatches production-hotfix.yml, never pre", () => {
    const s = buildDeployShellScript("prod", targets);
    expect(s).toContain(
      "gh workflow run 'production-hotfix.yml' --repo 'arnac-io/workflows' --ref 'main'"
    );
    expect(s).not.toContain("pre-hotfix.yml");
    expect(s).not.toMatch(/gh workflow run 'pre-/);
    expect(s.startsWith("set -e\n")).toBe(true);
  });

  it("throws on unknown env (exhaustive guard)", () => {
    expect(() => buildDeployShellScript("staging" as unknown as HotfixCliEnv, targets)).toThrow(
      /unsupported env/
    );
  });

  it("both: snapshots pre id BEFORE dispatch, waits for the new run, then prod", () => {
    const s = buildDeployShellScript("both", targets);
    const snapshotIdx = s.indexOf("__hf_prev=$(gh run list");
    const preDispatchIdx = s.indexOf(
      "gh workflow run 'pre-hotfix.yml' --repo 'arnac-io/workflows' --ref 'main'"
    );
    const waitIdx = s.indexOf("waiting for new pre-hotfix.yml run to appear");
    const prodDispatchIdx = s.indexOf(
      "gh workflow run 'production-hotfix.yml' --repo 'arnac-io/workflows' --ref 'main'"
    );
    expect(snapshotIdx).toBeGreaterThanOrEqual(0);
    expect(preDispatchIdx).toBeGreaterThan(snapshotIdx);
    expect(waitIdx).toBeGreaterThan(preDispatchIdx);
    expect(prodDispatchIdx).toBeGreaterThan(waitIdx);
    expect(s).toContain(`if [ "$__hf_conclusion" = "success" ]; then`);
    expect(s).toContain("select(. > $__hf_prev)");
  });
});
