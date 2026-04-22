import type { DeployRunResult } from "./deployRun";
import type { DeployTargets } from "./deployWorkflow";
import type { HotfixCliEnv } from "./hotfixCli";
import type {
  HotfixMergePhase,
  HotfixPrMergeWatchOptions,
  HotfixPrMergeWatchResult,
} from "./hotfixPrMergeWatch";
import type { HotfixShellRunResult } from "./hotfixRun";
import { parseGithubPullUrl, type ParsedPrUrl } from "./hotfixRunHelpers";

/**
 * Pure orchestration of the post-fcli deploy flow. Separated from
 * {@link PrTreeProvider} so it can be unit-tested with injected doubles for
 * all side effects (token resolution, PR watch, deploy run, UI prompts).
 */
export type DeployOrchestratorHooks = {
  /** Called once the hotfix PR is resolved (from fcli output or user prompt). */
  onResolvedPr?: (parsed: ParsedPrUrl) => void;
  /** Called on every merge-watch phase update (waiting / error / merged / closed). */
  onWatchPhase?: (phase: HotfixMergePhase) => void;
  /** Called right before `runDeploy` is awaited (UI should mark Stop as disabled). */
  onDeployDispatchStart?: (env: HotfixCliEnv) => void;
  /** Called after `runDeploy` resolves, regardless of outcome. */
  onDeployDispatchEnd?: (result: DeployRunResult) => void;
};

export type DeployOrchestratorDeps = {
  resolveToken: () => Promise<string | undefined>;
  watchPr: (
    opts: HotfixPrMergeWatchOptions
  ) => Promise<HotfixPrMergeWatchResult>;
  runDeploy: (opts: {
    env: HotfixCliEnv;
    targets: DeployTargets;
    cwd: string;
  }) => Promise<DeployRunResult>;
  /** Prompt the user for a hotfix PR URL when fcli did not emit one. Return `undefined` on cancel. */
  askForHotfixUrl: (fallback: {
    owner: string;
    repo: string;
  }) => Promise<string | undefined>;
  pollIntervalMs: number;
  workflowsTargets: DeployTargets;
  /** Shared abort flag. `stopWatch` flips `aborted = true` to cancel the merge-watch loop. */
  abort: { aborted: boolean };
  hooks?: DeployOrchestratorHooks;
};

/**
 * Terminal state of the deploy orchestration. The caller maps these to toasts
 * and the final `stopWatch()` call. Keeping this pure makes every branch easy
 * to unit-test.
 */
export type DeployOrchestratorResult =
  | { kind: "fcli_failed"; exitCode: number }
  | { kind: "cancelled_no_url" }
  | { kind: "no_token" }
  | { kind: "aborted" }
  | { kind: "pr_not_found"; owner: string; repo: string; prNumber: number }
  | { kind: "pr_closed_without_merge"; prNumber: number }
  | { kind: "watch_error"; message: string }
  | { kind: "deploy_failed"; exitCode: number | undefined }
  | { kind: "deploy_succeeded" };

export type OrchestrateDeployParams = {
  runResult: HotfixShellRunResult;
  env: HotfixCliEnv;
  cwd: string;
  fallbackRepo: { owner: string; repo: string };
  deps: DeployOrchestratorDeps;
};

/**
 * A `{ exitCode: undefined }` fcli result is treated as "best effort proceed"
 * because the shell-integration fallback path legitimately cannot report an
 * exit code — the user still gets the URL prompt as a confirmation gate.
 */
export async function orchestrateDeployAfterFcli(
  params: OrchestrateDeployParams
): Promise<DeployOrchestratorResult> {
  const { runResult, env, cwd, fallbackRepo, deps } = params;
  const hooks = deps.hooks ?? {};

  if (runResult.exitCode !== undefined && runResult.exitCode !== 0) {
    return { kind: "fcli_failed", exitCode: runResult.exitCode };
  }

  const parsed = await resolveHotfixPr(
    runResult.hotfixPrUrl,
    fallbackRepo,
    deps.askForHotfixUrl
  );
  if (!parsed) {
    return { kind: "cancelled_no_url" };
  }
  hooks.onResolvedPr?.(parsed);

  const token = await deps.resolveToken();
  if (!token) {
    return { kind: "no_token" };
  }

  const watchResult = await deps.watchPr({
    token,
    owner: parsed.owner,
    repo: parsed.repo,
    prNumber: parsed.prNumber,
    intervalMs: deps.pollIntervalMs,
    signal: deps.abort,
    onPhase: (phase) => hooks.onWatchPhase?.(phase),
  });

  if (watchResult.kind === "aborted") {
    return { kind: "aborted" };
  }
  if (watchResult.kind === "not_found") {
    return {
      kind: "pr_not_found",
      owner: parsed.owner,
      repo: parsed.repo,
      prNumber: parsed.prNumber,
    };
  }
  if (watchResult.kind === "closed") {
    return {
      kind: "pr_closed_without_merge",
      prNumber: parsed.prNumber,
    };
  }
  if (watchResult.kind === "error") {
    return { kind: "watch_error", message: watchResult.message };
  }

  hooks.onDeployDispatchStart?.(env);
  const deployResult = await deps.runDeploy({
    env,
    targets: deps.workflowsTargets,
    cwd,
  });
  hooks.onDeployDispatchEnd?.(deployResult);
  if (deployResult.ok) {
    return { kind: "deploy_succeeded" };
  }
  return { kind: "deploy_failed", exitCode: deployResult.exitCode };
}

async function resolveHotfixPr(
  parsedUrl: string | undefined,
  fallback: { owner: string; repo: string },
  ask: (fallback: {
    owner: string;
    repo: string;
  }) => Promise<string | undefined>
): Promise<ParsedPrUrl | undefined> {
  if (parsedUrl) {
    const parsed = parseGithubPullUrl(parsedUrl);
    if (parsed) {
      return parsed;
    }
  }
  const answer = await ask(fallback);
  if (!answer) {
    return undefined;
  }
  return parseGithubPullUrl(answer.trim());
}
