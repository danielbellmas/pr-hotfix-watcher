import type { DeployRunResult } from "./deployRun";
import type { DeployTracer } from "./deployTrace";
import type { DeployTargets } from "./deployWorkflow";
import { waitForHotfixPullRequest } from "./hotfixPrDiscovery";
import type { HotfixCliEnv } from "./hotfixCli";
import type {
  HotfixMergePhase,
  HotfixPrMergeWatchOptions,
  HotfixPrMergeWatchResult,
} from "./hotfixPrMergeWatch";
import type { HotfixShellRunResult } from "./hotfixRun";
import { parseGithubPullUrl, type HotfixPrEntry, type ParsedPrUrl } from "./hotfixRunHelpers";

/**
 * Pure orchestration of the post-fcli deploy flow. Separated from
 * {@link PrListController} so it can be unit-tested with injected doubles for
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
  watchPr: (opts: HotfixPrMergeWatchOptions) => Promise<HotfixPrMergeWatchResult>;
  runDeploy: (opts: {
    env: HotfixCliEnv;
    targets: DeployTargets;
    cwd: string;
    /** Rendered into the deploy-finished OS notification body so a stale
     *  ping can be traced back to its run. No other behavioural impact. */
    sourcePrNumbers?: readonly number[];
  }) => Promise<DeployRunResult>;
  /** Prompt the user for a hotfix PR URL when fcli did not emit one. Return `undefined` on cancel. */
  askForHotfixUrl: (fallback: { owner: string; repo: string }) => Promise<string | undefined>;
  /**
   * Poll GitHub for a newly created hotfix PR when fcli output has no URL.
   * Override in tests to avoid network; defaults to {@link waitForHotfixPullRequest}.
   */
  waitForHotfixPr?: (opts: {
    token: string;
    owner: string;
    repo: string;
    sourcePrNumbers?: readonly number[];
    notBeforeMs?: number;
    signal?: { aborted: boolean };
    log: (msg: string) => void;
  }) => Promise<ParsedPrUrl | undefined>;
  pollIntervalMs: number;
  /** Max ms to poll GitHub for a new hotfix PR when fcli output has no URL. */
  discoveryTimeoutMs?: number;
  workflowsTargets: DeployTargets;
  /** Shared abort flag. `stopWatch` flips `aborted = true` to cancel the merge-watch loop. */
  abort: { aborted: boolean };
  /** Structured deploy-phase logging. */
  trace?: DeployTracer;
  hooks?: DeployOrchestratorHooks;
};

/**
 * Terminal state of the deploy orchestration. The caller maps these to toasts
 * and the final `stopWatch()` call. Keeping this pure makes every branch easy
 * to unit-test.
 *
 * For multi-step deploys (env=both with JSON-parsed PRs), the failing step's
 * tag is returned as-is — callers don't need to know whether step 1/2 of N
 * failed, only that the overall flow stopped on this kind of failure.
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
  /** The env the user requested in the sidebar; used as the deploy env when fcli
   *  did not emit a JSON payload (legacy regex / manual prompt path). */
  env: HotfixCliEnv;
  cwd: string;
  fallbackRepo: { owner: string; repo: string };
  /** Forwarded to {@link DeployOrchestratorDeps.runDeploy}. */
  sourcePrNumbers?: readonly number[];
  /** Epoch ms when the fcli run started — bounds GitHub hotfix PR discovery. */
  runStartedAtMs?: number;
  deps: DeployOrchestratorDeps;
};

/** A single (PR → deploy env) pairing in the post-fcli queue. */
type DeployStep = {
  pr: ParsedPrUrl;
  env: HotfixCliEnv;
};

/**
 * A `{ exitCode: undefined }` fcli result is treated as "best effort proceed"
 * because the shell-integration fallback path legitimately cannot report an
 * exit code — the user still gets the URL prompt as a confirmation gate.
 */
export async function orchestrateDeployAfterFcli(
  params: OrchestrateDeployParams
): Promise<DeployOrchestratorResult> {
  const { runResult, env, cwd, fallbackRepo, sourcePrNumbers, runStartedAtMs, deps } = params;
  const hooks = deps.hooks ?? {};
  const trace = deps.trace;

  trace?.info("orchestrateDeployAfterFcli: begin");
  trace?.detail("requestedEnv", env);
  trace?.detail("cwd", cwd);
  trace?.detail("fcliExitCode", runResult.exitCode);
  trace?.detail("fcliOk", runResult.ok);
  trace?.detail("hotfixPrUrl", runResult.hotfixPrUrl);
  trace?.detail("hotfixPrsCount", runResult.hotfixPrs?.length ?? 0);
  trace?.detail("fcliOutputBytes", runResult.output.length);
  trace?.detail("sourcePrNumbers", sourcePrNumbers?.length ? sourcePrNumbers.join(",") : undefined);

  if (runResult.exitCode !== undefined && runResult.exitCode !== 0) {
    trace?.info(`orchestrateDeployAfterFcli: fcli failed exit ${runResult.exitCode}`);
    return { kind: "fcli_failed", exitCode: runResult.exitCode };
  }

  const steps = await buildDeploySteps({
    runResult,
    requestedEnv: env,
    fallbackRepo,
    askForHotfixUrl: deps.askForHotfixUrl,
    sourcePrNumbers,
    runStartedAtMs,
    resolveToken: deps.resolveToken,
    abort: deps.abort,
    pollIntervalMs: deps.pollIntervalMs,
    discoveryTimeoutMs: deps.discoveryTimeoutMs,
    waitForHotfixPr: deps.waitForHotfixPr,
    trace,
  });
  if (!steps) {
    trace?.info("orchestrateDeployAfterFcli: no hotfix PR resolved (cancelled)");
    return { kind: "cancelled_no_url" };
  }

  trace?.info(`orchestrateDeployAfterFcli: ${steps.length} deploy step(s) queued`);
  for (const [i, step] of steps.entries()) {
    trace?.info(
      `  step ${i + 1}: env=${step.env} pr=#${step.pr.prNumber} ${step.pr.owner}/${step.pr.repo}`
    );
  }

  const token = await deps.resolveToken();
  if (!token) {
    trace?.info("orchestrateDeployAfterFcli: GitHub token missing");
    return { kind: "no_token" };
  }

  for (const step of steps) {
    trace?.info(`runSingleDeployStep: watch PR #${step.pr.prNumber} then deploy env=${step.env}`);
    const stepResult = await runSingleDeployStep({
      step,
      token,
      cwd,
      sourcePrNumbers,
      deps,
      hooks,
    });
    trace?.info(`runSingleDeployStep: result=${stepResult.kind}`);
    if (stepResult.kind !== "deploy_succeeded") {
      return stepResult;
    }
  }
  trace?.info("orchestrateDeployAfterFcli: deploy_succeeded");
  return { kind: "deploy_succeeded" };
}

/**
 * Build the queue of `(PR, deploy env)` pairs from the fcli result. Three
 * input shapes, in priority order:
 *
 *   1. `runResult.hotfixPrs` (parsed JSON payload, `-o json` opt-in) — one
 *      step per env with the JSON-mapped env, so the user gets pre→deploy then
 *      prod→deploy when they asked for both.
 *   2. `runResult.hotfixPrUrl` (legacy `HOTFIX_PR_URL=` line) — single step
 *      using the user-requested `env` (which may be `both`; the deploy script
 *      handles the chained pre→prod dispatch in that case).
 *   3. Neither emitted — prompt the user; treated like the legacy case.
 *
 * Returns `undefined` only when the user cancels the URL prompt; an empty
 * JSON `prs` array also falls back to the prompt rather than returning
 * "succeeded with nothing to do".
 */
async function buildDeploySteps(args: {
  runResult: HotfixShellRunResult;
  requestedEnv: HotfixCliEnv;
  fallbackRepo: { owner: string; repo: string };
  askForHotfixUrl: (fallback: { owner: string; repo: string }) => Promise<string | undefined>;
  sourcePrNumbers?: readonly number[];
  runStartedAtMs?: number;
  resolveToken: () => Promise<string | undefined>;
  abort: { aborted: boolean };
  pollIntervalMs: number;
  discoveryTimeoutMs?: number;
  waitForHotfixPr?: DeployOrchestratorDeps["waitForHotfixPr"];
  trace?: DeployTracer;
}): Promise<DeployStep[] | undefined> {
  const {
    runResult,
    requestedEnv,
    fallbackRepo,
    askForHotfixUrl,
    sourcePrNumbers,
    runStartedAtMs,
    resolveToken,
    abort,
    pollIntervalMs,
    discoveryTimeoutMs,
    trace,
  } = args;

  const fromJson = stepsFromJsonPayload(runResult.hotfixPrs);
  if (fromJson.length > 0) {
    trace?.info(`buildDeploySteps: using JSON payload (${fromJson.length} step(s))`);
    return fromJson;
  }

  if (runResult.hotfixPrUrl) {
    const parsed = parseGithubPullUrl(runResult.hotfixPrUrl);
    if (parsed) {
      trace?.info(`buildDeploySteps: using HOTFIX_PR_URL #${parsed.prNumber}`);
      return [{ pr: parsed, env: requestedEnv }];
    }
    trace?.info(
      `buildDeploySteps: HOTFIX_PR_URL present but unparseable: ${runResult.hotfixPrUrl}`
    );
  } else {
    trace?.info("buildDeploySteps: no HOTFIX_PR_URL in fcli output");
  }

  const token = await resolveToken();
  if (token) {
    const notBeforeMs = (runStartedAtMs ?? Date.now()) - 5 * 60 * 1000;
    trace?.info("buildDeploySteps: waiting for hotfix PR on GitHub (fcli may still be running)…");
    const waitForHotfixPr =
      args.waitForHotfixPr ??
      ((opts) =>
        waitForHotfixPullRequest({
          token: opts.token,
          owner: opts.owner,
          repo: opts.repo,
          sourcePrNumbers: opts.sourcePrNumbers,
          notBeforeMs: opts.notBeforeMs,
          signal: opts.signal,
          pollIntervalMs,
          timeoutMs: discoveryTimeoutMs,
          log: opts.log,
        }));
    const discovered = await waitForHotfixPr({
      token,
      owner: fallbackRepo.owner,
      repo: fallbackRepo.repo,
      sourcePrNumbers,
      notBeforeMs,
      signal: abort,
      log: (msg) => trace?.info(msg),
    });
    if (discovered) {
      trace?.info(`buildDeploySteps: discovered hotfix PR #${discovered.prNumber}`);
      return [{ pr: discovered, env: requestedEnv }];
    }
    trace?.info("buildDeploySteps: GitHub discovery timed out with no hotfix PR");
  } else {
    trace?.info("buildDeploySteps: skipping GitHub discovery — no token");
  }

  trace?.info("buildDeploySteps: prompting user for hotfix PR URL");
  const parsed = await resolveHotfixPr(runResult.hotfixPrUrl, fallbackRepo, askForHotfixUrl);
  if (!parsed) {
    trace?.info("buildDeploySteps: user cancelled URL prompt");
    return undefined;
  }
  trace?.info(`buildDeploySteps: using user-provided PR #${parsed.prNumber}`);
  return [{ pr: parsed, env: requestedEnv }];
}

function stepsFromJsonPayload(prs: HotfixPrEntry[] | undefined): DeployStep[] {
  if (!prs || prs.length === 0) {
    return [];
  }
  // Order: "pre" first then "prod", regardless of how fcli emitted them, so
  // the deploy chain is always the natural pre→prod sequence even if fcli
  // reorders the JSON entries in a future version.
  const sorted = [...prs].sort((a, b) => orderRank(a.env) - orderRank(b.env));
  const out: DeployStep[] = [];
  for (const entry of sorted) {
    const parsed = parseGithubPullUrl(entry.htmlUrl);
    if (!parsed) {
      continue;
    }
    out.push({ pr: parsed, env: entry.env });
  }
  return out;
}

function orderRank(env: HotfixPrEntry["env"]): number {
  return env === "pre" ? 0 : 1;
}

async function runSingleDeployStep(args: {
  step: DeployStep;
  token: string;
  cwd: string;
  sourcePrNumbers: readonly number[] | undefined;
  deps: DeployOrchestratorDeps;
  hooks: DeployOrchestratorHooks;
}): Promise<DeployOrchestratorResult> {
  const { step, token, cwd, sourcePrNumbers, deps, hooks } = args;
  const trace = deps.trace;
  hooks.onResolvedPr?.(step.pr);
  trace?.info(`watchHotfixPrMerge: start #${step.pr.prNumber} in ${step.pr.owner}/${step.pr.repo}`);

  const watchResult = await deps.watchPr({
    token,
    owner: step.pr.owner,
    repo: step.pr.repo,
    prNumber: step.pr.prNumber,
    intervalMs: deps.pollIntervalMs,
    signal: deps.abort,
    onPhase: (phase) => {
      trace?.info(`watchHotfixPrMerge: phase=${phase.kind}`);
      hooks.onWatchPhase?.(phase);
    },
  });

  trace?.info(`watchHotfixPrMerge: finished kind=${watchResult.kind}`);

  if (watchResult.kind === "aborted") {
    return { kind: "aborted" };
  }
  if (watchResult.kind === "not_found") {
    return {
      kind: "pr_not_found",
      owner: step.pr.owner,
      repo: step.pr.repo,
      prNumber: step.pr.prNumber,
    };
  }
  if (watchResult.kind === "closed") {
    return { kind: "pr_closed_without_merge", prNumber: step.pr.prNumber };
  }
  if (watchResult.kind === "error") {
    return { kind: "watch_error", message: watchResult.message };
  }

  hooks.onDeployDispatchStart?.(step.env);
  trace?.info(`runDeploy: dispatch env=${step.env}`);
  const deployResult = await deps.runDeploy({
    env: step.env,
    targets: deps.workflowsTargets,
    cwd,
    sourcePrNumbers,
  });
  hooks.onDeployDispatchEnd?.(deployResult);
  trace?.detail("runDeployExitCode", deployResult.exitCode);
  trace?.detail("runDeployOk", deployResult.ok);
  if (!deployResult.ok) {
    return { kind: "deploy_failed", exitCode: deployResult.exitCode };
  }
  return { kind: "deploy_succeeded" };
}

/**
 * UI mapping for {@link DeployOrchestratorResult}. Lives next to the union so
 * a new variant forces both changes in one file. `severity: null` → silent
 * (user-cancelled or user-pressed-Stop). `stopsWatch: false` only for
 * `aborted`, where `stopWatch` already ran.
 */
export type DeployOutcomeDescription = {
  severity: "info" | "warn" | "error" | null;
  message?: string;
  stopsWatch: boolean;
  deployEnded: boolean;
};

export function describeDeployOutcome(result: DeployOrchestratorResult): DeployOutcomeDescription {
  switch (result.kind) {
    case "fcli_failed":
      return {
        severity: "error",
        message: "Hotfix CLI failed — skipping deploy phase.",
        stopsWatch: true,
        deployEnded: false,
      };
    case "cancelled_no_url":
      return {
        severity: "warn",
        message:
          "Hotfix deploy cancelled: no hotfix PR URL from fcli, GitHub discovery timed out, and URL prompt was dismissed.",
        stopsWatch: true,
        deployEnded: false,
      };
    case "no_token":
      return {
        severity: "error",
        message:
          "GitHub token missing — cannot watch the hotfix PR for deploy. Run `gh auth login` and try again.",
        stopsWatch: true,
        deployEnded: false,
      };
    case "aborted":
      return { severity: null, stopsWatch: false, deployEnded: false };
    case "pr_not_found":
      return {
        severity: "error",
        message: `Hotfix deploy aborted: PR #${result.prNumber} was not found in ${result.owner}/${result.repo}.`,
        stopsWatch: true,
        deployEnded: false,
      };
    case "pr_closed_without_merge":
      return {
        severity: "warn",
        message: `Hotfix deploy aborted: PR #${result.prNumber} closed without merging.`,
        stopsWatch: true,
        deployEnded: false,
      };
    case "watch_error":
      return {
        severity: "error",
        message: `Hotfix PR watch failed: ${result.message}`,
        stopsWatch: true,
        deployEnded: false,
      };
    case "deploy_failed":
      return {
        severity: "error",
        message: `Hotfix deploy did not complete successfully (exit ${
          result.exitCode ?? "unknown"
        }).`,
        stopsWatch: true,
        deployEnded: true,
      };
    case "deploy_succeeded":
      return { severity: null, stopsWatch: true, deployEnded: true };
  }
}

async function resolveHotfixPr(
  parsedUrl: string | undefined,
  fallback: { owner: string; repo: string },
  ask: (fallback: { owner: string; repo: string }) => Promise<string | undefined>
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
