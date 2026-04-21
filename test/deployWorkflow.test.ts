import { describe, expect, it } from "vitest";
import {
  buildDeployShellScript,
  buildGhRunWaitCommand,
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
    ).toBe(
      "gh workflow run 'pre-hotfix.yml' --repo 'arnac-io/workflows' --ref 'main'"
    );
  });
});

describe("buildGhRunWaitCommand", () => {
  it("polls for the most recent run and exits non-zero on non-success", () => {
    const cmd = buildGhRunWaitCommand({
      repoSlug: "arnac-io/workflows",
      workflow: "pre-hotfix.yml",
    });
    expect(cmd).toContain(
      "gh run list --repo 'arnac-io/workflows' --workflow 'pre-hotfix.yml'"
    );
    expect(cmd).toContain(`if [ "$__hf_status" = "completed" ]; then`);
    expect(cmd).toContain(`if [ "$__hf_conclusion" = "success" ]; then`);
    expect(cmd).toContain("exit 1");
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
    expect(() =>
      // @ts-expect-error malformed persisted env
      buildDeployShellScript("staging", targets)
    ).toThrow(/unsupported env/);
  });

  it("both: dispatches pre, waits for success, then prod", () => {
    const s = buildDeployShellScript("both", targets);
    const preDispatchIdx = s.indexOf(
      "gh workflow run 'pre-hotfix.yml' --repo 'arnac-io/workflows' --ref 'main'"
    );
    const waitIdx = s.indexOf("[deploy] waiting for pre-hotfix.yml");
    const prodDispatchIdx = s.indexOf(
      "gh workflow run 'production-hotfix.yml' --repo 'arnac-io/workflows' --ref 'main'"
    );
    expect(preDispatchIdx).toBeGreaterThan(-1);
    expect(waitIdx).toBeGreaterThan(preDispatchIdx);
    expect(prodDispatchIdx).toBeGreaterThan(waitIdx);
    expect(s).toContain(`if [ "$__hf_conclusion" = "success" ]; then`);
  });
});
