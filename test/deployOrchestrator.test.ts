import { describe, expect, it, vi } from "vitest";
import {
  describeDeployOutcome,
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
function makeDeps(overrides: Partial<DeployOrchestratorDeps> = {}): DeployOrchestratorDeps {
  return {
    resolveToken: vi.fn(async () => "t0k3n"),
    watchPr: vi.fn(
      async (_opts: HotfixPrMergeWatchOptions): Promise<HotfixPrMergeWatchResult> => ({
        kind: "merged",
        pull: fakePull,
      })
    ),
    runDeploy: vi.fn(async (): Promise<DeployRunResult> => ({ exitCode: 0, ok: true })),
    askForHotfixUrl: vi.fn(async () => undefined),
    pollIntervalMs: 1,
    workflowsTargets,
    abort: { aborted: false },
    ...overrides,
  } satisfies DeployOrchestratorDeps;
}

function runResultWith(overrides: Partial<HotfixShellRunResult>): HotfixShellRunResult {
  return {
    exitCode: 0,
    ok: true,
    output: "",
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
    const runDeploy = vi.fn(
      async (): Promise<DeployRunResult> => ({
        exitCode: 0,
        ok: true,
      })
    );
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
    const watchPr = vi.fn(async (_opts: HotfixPrMergeWatchOptions) => ({
      kind: "merged" as const,
      pull: fakePull,
    }));
    const runDeploy = vi.fn(
      async (): Promise<DeployRunResult> => ({
        exitCode: 0,
        ok: true,
      })
    );
    const askForHotfixUrl = vi.fn(async () => "https://github.com/acme/service/pull/99");
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
    const runDeploy = vi.fn(
      async (): Promise<DeployRunResult> => ({
        exitCode: 0,
        ok: true,
      })
    );
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
    const runDeploy = vi.fn(
      async (): Promise<DeployRunResult> => ({
        exitCode: 7,
        ok: false,
      })
    );
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

  // Direct proof of the "deploy gated on the hotfix PR merge" invariant:
  // runDeploy must not fire while the hotfix-PR watch is still pending.
  it("holds runDeploy until watchPr resolves with merged", async () => {
    let resolveWatch!: (r: HotfixPrMergeWatchResult) => void;
    const pendingWatch = new Promise<HotfixPrMergeWatchResult>((res) => {
      resolveWatch = res;
    });
    const runDeploy = vi.fn(async (): Promise<DeployRunResult> => ({ exitCode: 0, ok: true }));
    const deps = makeDeps({
      watchPr: vi.fn(() => pendingWatch),
      runDeploy,
    });
    const runP = run(deps);
    await new Promise((r) => setTimeout(r, 5));
    expect(runDeploy).not.toHaveBeenCalled();
    resolveWatch({ kind: "merged", pull: fakePull });
    const result = await runP;
    expect(result).toEqual({ kind: "deploy_succeeded" });
    expect(runDeploy).toHaveBeenCalledOnce();
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
      runDeploy: vi.fn(
        async (): Promise<DeployRunResult> => ({
          exitCode: 0,
          ok: true,
        })
      ),
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
    expect(order).toEqual(["resolved", "phase", "phase", "deploy_start", "deploy_end"]);
  });

  it("falls back to the prompt when fcli emitted a non-GitHub URL", async () => {
    const askForHotfixUrl = vi.fn(async () => undefined);
    const deps = makeDeps({ askForHotfixUrl });
    const result = await run(deps, { hotfixPrUrl: "not a url" });
    expect(result).toEqual({ kind: "cancelled_no_url" });
    expect(askForHotfixUrl).toHaveBeenCalledOnce();
  });

  describe("with -o json payload (sequenced multi-env)", () => {
    const prePr: GitHubPull = {
      ...fakePull,
      number: 11,
      html_url: "https://github.com/acme/service/pull/11",
    };
    const prodPr: GitHubPull = {
      ...fakePull,
      number: 22,
      html_url: "https://github.com/acme/service/pull/22",
    };

    function jsonRun(overrides?: Partial<HotfixShellRunResult>) {
      return runResultWith({
        // Legacy fallback string is ignored when hotfixPrs is set; assert that
        // explicitly by pointing it at a different PR than the JSON entries.
        hotfixPrUrl: "https://github.com/acme/service/pull/999",
        hotfixPrs: [
          {
            env: "pre",
            prNumber: 11,
            htmlUrl: "https://github.com/acme/service/pull/11",
          },
          {
            env: "prod",
            prNumber: 22,
            htmlUrl: "https://github.com/acme/service/pull/22",
          },
        ],
        ...overrides,
      });
    }

    it("watches and deploys pre, then watches and deploys prod, in order", async () => {
      const calls: Array<{ stage: string; detail: string }> = [];
      const watchPr = vi.fn(async (opts: HotfixPrMergeWatchOptions) => {
        calls.push({ stage: "watch", detail: `#${opts.prNumber}` });
        return {
          kind: "merged" as const,
          pull: opts.prNumber === 11 ? prePr : prodPr,
        };
      });
      const runDeploy = vi.fn(
        async ({
          env: dispatchEnv,
        }: {
          env: "pre" | "prod" | "both";
        }): Promise<DeployRunResult> => {
          calls.push({ stage: "deploy", detail: dispatchEnv });
          return { exitCode: 0, ok: true };
        }
      );
      const deps = makeDeps({ watchPr, runDeploy });
      const result = await orchestrateDeployAfterFcli({
        runResult: jsonRun(),
        env: "both",
        cwd: "/repo",
        fallbackRepo: { owner: "acme", repo: "service" },
        deps,
      });
      expect(result).toEqual({ kind: "deploy_succeeded" });
      expect(calls).toEqual([
        { stage: "watch", detail: "#11" },
        { stage: "deploy", detail: "pre" },
        { stage: "watch", detail: "#22" },
        { stage: "deploy", detail: "prod" },
      ]);
      expect(runDeploy).toHaveBeenCalledTimes(2);
    });

    it("dispatches per-env (not the chained 'both' script) when JSON drives the flow", async () => {
      const runDeploy = vi.fn(
        async (_opts: { env: string }): Promise<DeployRunResult> => ({ exitCode: 0, ok: true })
      );
      const deps = makeDeps({ runDeploy });
      await orchestrateDeployAfterFcli({
        runResult: jsonRun(),
        env: "both",
        cwd: "/repo",
        fallbackRepo: { owner: "acme", repo: "service" },
        deps,
      });
      const envs = runDeploy.mock.calls.map((c) => c[0].env);
      expect(envs).toEqual(["pre", "prod"]);
    });

    it("stops on first failure and never starts the second deploy", async () => {
      const watchPr = vi.fn(async (opts: HotfixPrMergeWatchOptions) => {
        if (opts.prNumber === 11) {
          return { kind: "closed" as const, pull: prePr };
        }
        return { kind: "merged" as const, pull: prodPr };
      });
      const runDeploy = vi.fn();
      const deps = makeDeps({ watchPr, runDeploy });
      const result = await orchestrateDeployAfterFcli({
        runResult: jsonRun(),
        env: "both",
        cwd: "/repo",
        fallbackRepo: { owner: "acme", repo: "service" },
        deps,
      });
      expect(result).toEqual({
        kind: "pr_closed_without_merge",
        prNumber: 11,
      });
      expect(runDeploy).not.toHaveBeenCalled();
    });

    it("reorders prod-before-pre payloads into pre→prod for deploy", async () => {
      const runDeploy = vi.fn(
        async (_opts: { env: string }): Promise<DeployRunResult> => ({ exitCode: 0, ok: true })
      );
      const deps = makeDeps({ runDeploy });
      await orchestrateDeployAfterFcli({
        runResult: runResultWith({
          hotfixPrUrl: undefined,
          hotfixPrs: [
            {
              env: "prod",
              prNumber: 22,
              htmlUrl: "https://github.com/acme/service/pull/22",
            },
            {
              env: "pre",
              prNumber: 11,
              htmlUrl: "https://github.com/acme/service/pull/11",
            },
          ],
        }),
        env: "both",
        cwd: "/repo",
        fallbackRepo: { owner: "acme", repo: "service" },
        deps,
      });
      expect(runDeploy.mock.calls.map((c) => c[0].env)).toEqual(["pre", "prod"]);
    });

    it("fires onResolvedPr once per step, with the right PR each time", async () => {
      const onResolvedPr = vi.fn();
      const watchPr = vi.fn(async (opts: HotfixPrMergeWatchOptions) => ({
        kind: "merged" as const,
        pull: opts.prNumber === 11 ? prePr : prodPr,
      }));
      const deps = makeDeps({
        watchPr,
        runDeploy: vi.fn(async (): Promise<DeployRunResult> => ({ exitCode: 0, ok: true })),
        hooks: { onResolvedPr },
      });
      await orchestrateDeployAfterFcli({
        runResult: jsonRun(),
        env: "both",
        cwd: "/repo",
        fallbackRepo: { owner: "acme", repo: "service" },
        deps,
      });
      expect(onResolvedPr).toHaveBeenCalledTimes(2);
      expect(onResolvedPr.mock.calls[0][0].prNumber).toBe(11);
      expect(onResolvedPr.mock.calls[1][0].prNumber).toBe(22);
    });

    it("ignores hotfixPrUrl when hotfixPrs is present", async () => {
      const watchPr = vi.fn(async (opts: HotfixPrMergeWatchOptions) => ({
        kind: "merged" as const,
        pull: opts.prNumber === 11 ? prePr : prodPr,
      }));
      const deps = makeDeps({
        watchPr,
        runDeploy: vi.fn(async (): Promise<DeployRunResult> => ({ exitCode: 0, ok: true })),
      });
      await orchestrateDeployAfterFcli({
        runResult: jsonRun({
          hotfixPrUrl: "https://github.com/acme/service/pull/999",
        }),
        env: "both",
        cwd: "/repo",
        fallbackRepo: { owner: "acme", repo: "service" },
        deps,
      });
      const watchedPrs = watchPr.mock.calls.map((c) => c[0].prNumber);
      expect(watchedPrs).toEqual([11, 22]);
      expect(watchedPrs).not.toContain(999);
    });

    it("falls back to the regex URL path when hotfixPrs is empty", async () => {
      const runDeploy = vi.fn(
        async (_opts: { env: string }): Promise<DeployRunResult> => ({ exitCode: 0, ok: true })
      );
      const deps = makeDeps({ runDeploy });
      const result = await orchestrateDeployAfterFcli({
        runResult: runResultWith({
          hotfixPrs: [],
          hotfixPrUrl: "https://github.com/acme/service/pull/42",
        }),
        env: "both",
        cwd: "/repo",
        fallbackRepo: { owner: "acme", repo: "service" },
        deps,
      });
      expect(result).toEqual({ kind: "deploy_succeeded" });
      expect(runDeploy).toHaveBeenCalledTimes(1);
      // Legacy path passes the user-requested env straight through; the
      // chained "both" deploy script handles pre→prod inside `runDeploy`.
      expect(runDeploy.mock.calls[0][0].env).toBe("both");
    });
  });
});

describe("describeDeployOutcome", () => {
  it("fcli_failed → error toast, stops watch, deploy not ended", () => {
    const desc = describeDeployOutcome({ kind: "fcli_failed", exitCode: 2 });
    expect(desc).toEqual({
      severity: "error",
      message: "Hotfix CLI failed — skipping deploy phase.",
      stopsWatch: true,
      deployEnded: false,
    });
  });

  it("cancelled_no_url → silent stop", () => {
    expect(describeDeployOutcome({ kind: "cancelled_no_url" })).toEqual({
      severity: null,
      stopsWatch: true,
      deployEnded: false,
    });
  });

  it("no_token → error toast, stops watch", () => {
    const desc = describeDeployOutcome({ kind: "no_token" });
    expect(desc.severity).toBe("error");
    expect(desc.message).toMatch(/token missing/i);
    expect(desc.stopsWatch).toBe(true);
  });

  it("aborted → silent and does NOT stop (caller already stopped)", () => {
    expect(describeDeployOutcome({ kind: "aborted" })).toEqual({
      severity: null,
      stopsWatch: false,
      deployEnded: false,
    });
  });

  it("pr_not_found → error includes owner/repo/number", () => {
    const desc = describeDeployOutcome({
      kind: "pr_not_found",
      owner: "acme",
      repo: "service",
      prNumber: 99,
    });
    expect(desc.severity).toBe("error");
    expect(desc.message).toContain("#99");
    expect(desc.message).toContain("acme/service");
    expect(desc.stopsWatch).toBe(true);
  });

  it("pr_closed_without_merge → warn (not error)", () => {
    const desc = describeDeployOutcome({
      kind: "pr_closed_without_merge",
      prNumber: 7,
    });
    expect(desc.severity).toBe("warn");
    expect(desc.message).toContain("#7");
    expect(desc.stopsWatch).toBe(true);
  });

  it("watch_error → error includes message", () => {
    const desc = describeDeployOutcome({
      kind: "watch_error",
      message: "EAI_AGAIN",
    });
    expect(desc.severity).toBe("error");
    expect(desc.message).toContain("EAI_AGAIN");
  });

  it("deploy_failed → error, deployEnded=true, exit code in message", () => {
    const desc = describeDeployOutcome({
      kind: "deploy_failed",
      exitCode: 17,
    });
    expect(desc.severity).toBe("error");
    expect(desc.message).toContain("17");
    expect(desc.deployEnded).toBe(true);
    expect(desc.stopsWatch).toBe(true);
  });

  it("deploy_failed with undefined exitCode says 'unknown'", () => {
    const desc = describeDeployOutcome({
      kind: "deploy_failed",
      exitCode: undefined,
    });
    expect(desc.message).toContain("unknown");
  });

  it("deploy_succeeded → silent, deployEnded=true, stops watch", () => {
    expect(describeDeployOutcome({ kind: "deploy_succeeded" })).toEqual({
      severity: null,
      stopsWatch: true,
      deployEnded: true,
    });
  });
});
