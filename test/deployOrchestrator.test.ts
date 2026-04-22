import { describe, expect, it, vi } from "vitest";
import {
  orchestrateDeployAfterFcli,
  type DeployOrchestratorDeps,
  type DeployOrchestratorResult,
} from "../src/deployOrchestrator";
import type { DeployRunResult } from "../src/deployRun";
import type { DeployTargets } from "../src/deployWorkflow";
import type {
  HotfixMergePhase,
  HotfixPrMergeWatchOptions,
  HotfixPrMergeWatchResult,
} from "../src/hotfixPrMergeWatch";
import type { GitHubPull } from "../src/githubClient";
import type { HotfixShellRunResult } from "../src/hotfixRun";

const fakePull: GitHubPull = {
  number: 42,
  title: "Fix the thing",
  state: "closed",
  merged_at: "2026-04-22T12:00:00Z",
  html_url: "https://github.com/acme/service/pull/42",
  created_at: "2026-04-22T11:00:00Z",
} as unknown as GitHubPull;

const workflowsTargets: DeployTargets = {
  repoSlug: "acme/workflows",
  preWorkflow: "pre.yml",
  prodWorkflow: "prod.yml",
  ref: "main",
};

/**
 * Mint a fresh {@link DeployOrchestratorDeps} with all side effects stubbed to
 * no-op successes. Individual tests override only the fields they care about,
 * keeping assertions focused.
 */
function makeDeps(
  overrides: Partial<DeployOrchestratorDeps> = {}
): DeployOrchestratorDeps {
  return {
    resolveToken: vi.fn(async () => "t0k3n"),
    watchPr: vi.fn(
      async (_opts: HotfixPrMergeWatchOptions): Promise<HotfixPrMergeWatchResult> => ({
        kind: "merged",
        pull: fakePull,
      })
    ),
    runDeploy: vi.fn(
      async (): Promise<DeployRunResult> => ({ exitCode: 0, ok: true })
    ),
    askForHotfixUrl: vi.fn(async () => undefined),
    pollIntervalMs: 1,
    workflowsTargets,
    abort: { aborted: false },
    ...overrides,
  } satisfies DeployOrchestratorDeps;
}

function runResultWith(
  overrides: Partial<HotfixShellRunResult>
): HotfixShellRunResult {
  return {
    exitCode: 0,
    strategy: "background" as const,
    logTail: "",
    hotfixPrUrl: "https://github.com/acme/service/pull/42",
    ...overrides,
  };
}

async function run(
  deps: DeployOrchestratorDeps,
  runResultOverrides: Partial<HotfixShellRunResult> = {}
): Promise<DeployOrchestratorResult> {
  return orchestrateDeployAfterFcli({
    runResult: runResultWith(runResultOverrides),
    env: "pre",
    cwd: "/repo",
    fallbackRepo: { owner: "acme", repo: "service" },
    deps,
  });
}

describe("orchestrateDeployAfterFcli", () => {
  it("short-circuits when fcli exited non-zero and never dispatches deploy", async () => {
    const runDeploy = vi.fn();
    const deps = makeDeps({ runDeploy });
    const result = await run(deps, { exitCode: 2 });
    expect(result).toEqual({ kind: "fcli_failed", exitCode: 2 });
    expect(runDeploy).not.toHaveBeenCalled();
  });

  it("treats exitCode=undefined as proceed (shell-integration fallback path)", async () => {
    const runDeploy = vi.fn(async (): Promise<DeployRunResult> => ({
      exitCode: 0,
      ok: true,
    }));
    const deps = makeDeps({ runDeploy });
    const result = await run(deps, { exitCode: undefined });
    expect(result).toEqual({ kind: "deploy_succeeded" });
    expect(runDeploy).toHaveBeenCalledOnce();
  });

  it("prompts for URL and bails on cancel — no watch, no deploy", async () => {
    const watchPr = vi.fn(async () => ({ kind: "merged" as const, pull: fakePull }));
    const runDeploy = vi.fn();
    const askForHotfixUrl = vi.fn(async () => undefined);
    const deps = makeDeps({ watchPr, runDeploy, askForHotfixUrl });
    const result = await run(deps, { hotfixPrUrl: undefined });
    expect(result).toEqual({ kind: "cancelled_no_url" });
    expect(askForHotfixUrl).toHaveBeenCalledOnce();
    expect(watchPr).not.toHaveBeenCalled();
    expect(runDeploy).not.toHaveBeenCalled();
  });

  it("accepts a user-typed URL from the prompt when fcli did not emit one", async () => {
    const watchPr = vi.fn(async () => ({ kind: "merged" as const, pull: fakePull }));
    const runDeploy = vi.fn(async (): Promise<DeployRunResult> => ({
      exitCode: 0,
      ok: true,
    }));
    const askForHotfixUrl = vi.fn(
      async () => "https://github.com/acme/service/pull/99"
    );
    const deps = makeDeps({ watchPr, runDeploy, askForHotfixUrl });
    const result = await run(deps, { hotfixPrUrl: undefined });
    expect(result).toEqual({ kind: "deploy_succeeded" });
    const watchArgs = watchPr.mock.calls[0]?.[0];
    expect(watchArgs?.prNumber).toBe(99);
    expect(watchArgs?.owner).toBe("acme");
    expect(watchArgs?.repo).toBe("service");
  });

  it("returns no_token when token resolution fails and never polls or deploys", async () => {
    const watchPr = vi.fn();
    const runDeploy = vi.fn();
    const deps = makeDeps({
      resolveToken: vi.fn(async () => undefined),
      watchPr,
      runDeploy,
    });
    const result = await run(deps);
    expect(result).toEqual({ kind: "no_token" });
    expect(watchPr).not.toHaveBeenCalled();
    expect(runDeploy).not.toHaveBeenCalled();
  });

  it("dispatches deploy with the resolved PR and workflows targets on merge", async () => {
    const runDeploy = vi.fn(async (): Promise<DeployRunResult> => ({
      exitCode: 0,
      ok: true,
    }));
    const deps = makeDeps({ runDeploy });
    const result = await run(deps);
    expect(result).toEqual({ kind: "deploy_succeeded" });
    expect(runDeploy).toHaveBeenCalledWith({
      env: "pre",
      targets: workflowsTargets,
      cwd: "/repo",
    });
  });

  it("propagates non-zero deploy exit as deploy_failed", async () => {
    const runDeploy = vi.fn(async (): Promise<DeployRunResult> => ({
      exitCode: 7,
      ok: false,
    }));
    const deps = makeDeps({ runDeploy });
    const result = await run(deps);
    expect(result).toEqual({ kind: "deploy_failed", exitCode: 7 });
  });

  it("returns pr_closed_without_merge when the watcher reports a closed PR", async () => {
    const runDeploy = vi.fn();
    const deps = makeDeps({
      watchPr: vi.fn(async () => ({ kind: "closed" as const, pull: fakePull })),
      runDeploy,
    });
    const result = await run(deps);
    expect(result).toEqual({ kind: "pr_closed_without_merge", prNumber: 42 });
    expect(runDeploy).not.toHaveBeenCalled();
  });

  it("returns pr_not_found when the watcher 404s", async () => {
    const runDeploy = vi.fn();
    const deps = makeDeps({
      watchPr: vi.fn(async () => ({ kind: "not_found" as const })),
      runDeploy,
    });
    const result = await run(deps);
    expect(result).toEqual({
      kind: "pr_not_found",
      owner: "acme",
      repo: "service",
      prNumber: 42,
    });
    expect(runDeploy).not.toHaveBeenCalled();
  });

  it("bubbles up watcher errors without dispatching deploy", async () => {
    const runDeploy = vi.fn();
    const deps = makeDeps({
      watchPr: vi.fn(async () => ({
        kind: "error" as const,
        message: "ECONNRESET",
      })),
      runDeploy,
    });
    const result = await run(deps);
    expect(result).toEqual({ kind: "watch_error", message: "ECONNRESET" });
    expect(runDeploy).not.toHaveBeenCalled();
  });

  it("returns aborted when the user cancels mid-watch and never deploys", async () => {
    const runDeploy = vi.fn();
    const deps = makeDeps({
      watchPr: vi.fn(async () => ({ kind: "aborted" as const })),
      runDeploy,
    });
    const result = await run(deps);
    expect(result).toEqual({ kind: "aborted" });
    expect(runDeploy).not.toHaveBeenCalled();
  });

  it("fires hooks for resolved PR → watch phases → deploy start/end in order", async () => {
    const order: string[] = [];
    const onResolvedPr = vi.fn(() => {
      order.push("resolved");
    });
    const onWatchPhase = vi.fn((_phase: HotfixMergePhase) => {
      order.push("phase");
    });
    const onDeployDispatchStart = vi.fn(() => {
      order.push("deploy_start");
    });
    const onDeployDispatchEnd = vi.fn(() => {
      order.push("deploy_end");
    });

    const deps = makeDeps({
      watchPr: vi.fn(async (opts: HotfixPrMergeWatchOptions) => {
        opts.onPhase?.({ kind: "waiting", pull: fakePull });
        opts.onPhase?.({ kind: "merged", pull: fakePull });
        return { kind: "merged" as const, pull: fakePull };
      }),
      runDeploy: vi.fn(async (): Promise<DeployRunResult> => ({
        exitCode: 0,
        ok: true,
      })),
      hooks: {
        onResolvedPr,
        onWatchPhase,
        onDeployDispatchStart,
        onDeployDispatchEnd,
      },
    });
    await run(deps);
    expect(onResolvedPr).toHaveBeenCalledOnce();
    expect(onWatchPhase).toHaveBeenCalledTimes(2);
    expect(onDeployDispatchStart).toHaveBeenCalledOnce();
    expect(onDeployDispatchEnd).toHaveBeenCalledOnce();
    expect(order).toEqual([
      "resolved",
      "phase",
      "phase",
      "deploy_start",
      "deploy_end",
    ]);
  });

  it("falls back to the prompt when fcli emitted a non-GitHub URL", async () => {
    const askForHotfixUrl = vi.fn(async () => undefined);
    const deps = makeDeps({ askForHotfixUrl });
    const result = await run(deps, { hotfixPrUrl: "not a url" });
    expect(result).toEqual({ kind: "cancelled_no_url" });
    expect(askForHotfixUrl).toHaveBeenCalledOnce();
  });
});
