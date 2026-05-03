import * as vscode from "vscode";
import {
  buildHotfixCommand,
  getHotfixPrPollIntervalMs,
  getPollIntervalMs,
  getGhPath,
  getRepoConfig,
  getRepoRoot,
  getWorkflowsRepoConfig,
  getWorktreePostCreateCommand,
} from "./config";
import { describeDeployOutcome, orchestrateDeployAfterFcli } from "./deployOrchestrator";
import { runHotfixDeploy } from "./deployRun";
import { getPullRequest } from "./githubClient";
import { buildHotfixCliSuffix, type HotfixCliOptions } from "./hotfixCli";
import { watchHotfixPrMerge } from "./hotfixPrMergeWatch";
import { runHotfixShellCommandAfterMerge, type HotfixShellRunResult } from "./hotfixRun";
import { parseGithubPullUrl } from "./hotfixRunHelpers";
import { killActiveChild } from "./runRegistry";
import { phaseFromSettledPulls } from "./watchPoll";
import { MergeHandoffGate } from "./watchPollGuard";
import { ensureHotfixWorktree } from "./worktreeManager";

/**
 * Owns the watch lifecycle: pre-fcli upstream-PR poll, fcli execution, and
 * the post-fcli hotfix-PR poll + deploy. Centralizing keeps the invariants
 * (re-entrancy gate, frozen cli snapshot, "Stop is a no-op while deploying",
 * `deployRunning` mirrored to a context key) in one place. `PrListController`
 * keeps the PR catalog and delegates everything watch-related here.
 */

export type WatchPanelEntry = {
  number: number;
  title: string;
  state: string;
  merged: boolean;
};

export type WatchPanelState = {
  targets: number[];
  entries: WatchPanelEntry[];
  /** e.g. "Waiting on #12…" */
  statusLine: string;
  hotfixSummary: string;
};

/** Host side effects, inverted so tests can drive the session without `vscode`. */
export type WatchSessionUi = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  askHotfixUrl: (fb: { owner: string; repo: string }) => Promise<string | undefined>;
  /** Mirror `deployRunning` to a context key so the view-title Stop button
   *  hides itself once a deploy is dispatched. */
  setDeployRunningContext: (running: boolean) => void;
};

export type WatchSessionDeps = {
  ui: WatchSessionUi;
  onChange: () => void;
  resolveToken: () => Promise<string | undefined>;
  /** Gates the one-time "touch your YubiKey" worktree toast. `undefined` → no gate. */
  globalState:
    | {
        get<T>(key: string, fallback?: T): T | undefined;
        update(key: string, value: unknown): Thenable<void> | Promise<void>;
      }
    | undefined;
};

export type StartWatchOptions = {
  prNumbers: number[];
  cli: HotfixCliOptions;
  initialEntries: WatchPanelEntry[];
};

type DeployPhase = {
  prNumber: number;
  title: string;
  state: string;
  merged: boolean;
  owner: string;
  repo: string;
  abort: { aborted: boolean };
};

/** Toast at most once per N consecutive transient poll errors so a flaky network
 *  doesn't spam the user. The status line in the live-watch banner still
 *  updates every poll. */
const POLL_ERROR_TOAST_EVERY = 5;

export class WatchSession {
  private watching = false;
  private watchTarget: number[] = [];
  private watchEntries: WatchPanelEntry[] = [];
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private readonly pollGate = new MergeHandoffGate();
  /** Frozen at `start()` so toggling env / deploy mid-watch can't alter the
   *  in-flight session. */
  private watchCtx: { cli: HotfixCliOptions; prNumbers: number[] } | null = null;
  private deployRunning = false;
  private deployPhase: DeployPhase | null = null;
  private statusMessage = "";
  private lastDeployRunningContext = false;
  private consecutivePollErrors = 0;
  /**
   * Sticky abort flag flipped by `stop()`. Read by `handleAllMerged` /
   * `handleDeployAfterFcli` after every await so a Stop pressed mid-fcli or
   * mid-deploy short-circuits everything downstream — orchestrator hooks
   * already look at `abortFlag.aborted`, this mirror lets us bail before we
   * ever reach the orchestrator.
   */
  private aborted = false;
  /** Reference shared with the active orchestrator so abort signals reach
   *  the in-flight `watchHotfixPrMerge` loop too. */
  private currentDeployAbort: { aborted: boolean } | null = null;

  constructor(private readonly deps: WatchSessionDeps) {}

  isWatching(): boolean {
    return this.watching;
  }

  isDeployRunning(): boolean {
    return this.deployRunning;
  }

  getStatusMessage(): string {
    return this.statusMessage;
  }

  start(options: StartWatchOptions): void {
    const { prNumbers, cli, initialEntries } = options;
    this.watchCtx = { cli: { ...cli }, prNumbers: [...prNumbers] };
    this.watchTarget = [...prNumbers];
    this.watching = true;
    this.aborted = false;
    this.pollGate.reset();
    this.deployRunning = false;
    this.watchEntries = initialEntries.map((e) => ({ ...e }));
    this.statusMessage = `Waiting on #${prNumbers.join(", #")}…`;
    this.deps.onChange();
    void this.pollOnce();
    this.pollTimer = setInterval(() => void this.pollOnce(), getPollIntervalMs());
  }

  /**
   * Phase-aware abort. Always cancels the current state regardless of which
   * phase the session is in:
   *   - merge-watching: clears the poll timer
   *   - fcli running: SIGTERM the fcli child via the run registry
   *   - hotfix-PR watching: flips the orchestrator's abort flag
   *   - deploy running: SIGTERM the deploy child (the `gh workflow run` script
   *     itself), and flip the orchestrator abort so it doesn't loop into the
   *     next env
   *
   * The dispatched GitHub Actions run is left alone — cancelling it requires
   * the run id which the bash dispatch script doesn't surface back to us, and
   * silently cancelling the wrong run id would be worse than leaving the user
   * to do it via `gh run list` / the GitHub UI. The notification path makes
   * that clear.
   */
  stop(): void {
    this.aborted = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    // Kill any registered children (no-op when nothing is running).
    killActiveChild("fcli");
    killActiveChild("deploy");
    if (this.deployPhase) {
      this.deployPhase.abort.aborted = true;
    }
    if (this.currentDeployAbort) {
      this.currentDeployAbort.aborted = true;
    }
    if (this.deployRunning) {
      this.deps.ui.warn(
        "Stop pressed during deploy: local script terminated. The dispatched workflow run on GitHub is NOT cancelled — use `gh run list` / the Actions UI if you need to stop it remotely."
      );
    }
    this.watching = false;
    this.watchTarget = [];
    this.watchEntries = [];
    this.statusMessage = "";
    this.deployPhase = null;
    this.watchCtx = null;
    this.deployRunning = false;
    this.pollGate.reset();
    this.deps.onChange();
  }

  /** Returns `null` when idle. Prefers the frozen `cli` snapshot over
   *  `liveCli` so the banner can't disagree with the in-flight run. */
  buildPanelState(
    liveCli: HotfixCliOptions,
    lookupRow: (n: number) => { title: string; state: string; merged: boolean } | undefined
  ): WatchPanelState | null {
    if (!this.watching) {
      return null;
    }
    const cli = this.watchCtx?.cli ?? liveCli;
    if (this.deployPhase) {
      const d = this.deployPhase;
      return {
        targets: [d.prNumber],
        entries: [
          {
            number: d.prNumber,
            title: d.title,
            state: d.state,
            merged: d.merged,
          },
        ],
        statusLine: this.statusMessage,
        hotfixSummary: `Waiting on hotfix PR #${d.prNumber} to merge → then deploy ${describeEnvShort(cli.env)}`,
      };
    }
    if (this.watchTarget.length === 0) {
      return null;
    }
    const entries =
      this.watchEntries.length === this.watchTarget.length
        ? this.watchEntries.map((e) => ({ ...e }))
        : this.watchTarget.map((n) => {
            const row = lookupRow(n);
            return {
              number: n,
              title: row?.title ?? `PR #${n}`,
              state: row?.state ?? "open",
              merged: Boolean(row?.merged),
            };
          });
    return {
      targets: [...this.watchTarget],
      entries,
      statusLine: this.statusMessage,
      hotfixSummary: formatHotfixWatchSummary(cli),
    };
  }

  /** Idempotent — only pushes when the flag actually changed. */
  syncDeployRunningContext(): void {
    if (this.lastDeployRunningContext === this.deployRunning) {
      return;
    }
    this.lastDeployRunningContext = this.deployRunning;
    this.deps.ui.setDeployRunningContext(this.deployRunning);
  }

  /** Public so tests can pump it without waiting on `setInterval`. */
  async pollOnce(): Promise<void> {
    if (!this.watching || this.watchTarget.length === 0) {
      return;
    }
    await this.pollGate.runPoll(async ({ claimMerge }) => {
      const token = await this.deps.resolveToken();
      if (!token) {
        this.stop();
        this.deps.ui.error(
          "GitHub token missing — stopped watching. Run `gh auth login` and try again."
        );
        return;
      }
      const { owner, repo } = getRepoConfig();
      try {
        const settled = await Promise.allSettled(
          this.watchTarget.map((n) => getPullRequest(token, owner, repo, n))
        );
        const allFulfilled = settled.every(
          (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof getPullRequest>>> =>
            r.status === "fulfilled"
        );
        if (allFulfilled) {
          this.watchEntries = settled.map((r, i) => {
            const p = r.value;
            return {
              number: this.watchTarget[i],
              title: p.title,
              state: p.state,
              merged: Boolean(p.merged_at),
            };
          });
        }
        const phase = phaseFromSettledPulls(this.watchTarget, settled);
        if (phase.kind === "stop_404") {
          this.stop();
          this.deps.ui.error(`Hotfix watch stopped: PR #${phase.prNumber} was not found.`);
          return;
        }
        if (phase.kind === "poll_error") {
          this.consecutivePollErrors++;
          this.statusMessage = `Hotfix watch poll failed — retrying… (${phase.message})`;
          this.deps.onChange();
          if (
            this.consecutivePollErrors === 1 ||
            this.consecutivePollErrors % POLL_ERROR_TOAST_EVERY === 0
          ) {
            this.deps.ui.error(`Hotfix watch poll failed: ${phase.message}`);
          }
          return;
        }
        this.consecutivePollErrors = 0;
        if (phase.kind === "stop_closed") {
          this.stop();
          const nums = phase.prNumbers.join(", #");
          this.deps.ui.warn(`Hotfix watch stopped: PR #${nums} closed without merging.`);
          return;
        }
        if (phase.kind === "continue") {
          this.statusMessage = `Waiting on #${phase.pendingNumbers.join(", #")}…`;
          this.deps.onChange();
          return;
        }

        // all_merged — claim handoff before any further await.
        if (!claimMerge()) {
          return;
        }
        await this.handleAllMerged();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.consecutivePollErrors++;
        if (
          this.consecutivePollErrors === 1 ||
          this.consecutivePollErrors % POLL_ERROR_TOAST_EVERY === 0
        ) {
          this.deps.ui.error(`Hotfix watch poll failed: ${msg}`);
        }
      }
    });
  }

  private async handleAllMerged(): Promise<void> {
    // Defensive: gate already ensures `start()` ran and `stop()` hasn't.
    if (!this.watchCtx) {
      return;
    }
    const ctx = this.watchCtx;
    const mergedNumbers = [...this.watchTarget];
    const deploy = ctx.cli.deploy;
    const env = ctx.cli.env;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.watchTarget = [];
    this.watchEntries = [];
    this.statusMessage = deploy ? "Running hotfix CLI, then watching hotfix PR to deploy…" : "";
    if (!deploy) {
      this.watching = false;
    }
    this.deps.onChange();

    const baseRoot = getRepoRoot();
    if (!baseRoot) {
      this.watching = false;
      this.deps.onChange();
      this.deps.ui.error(
        "No repo root configured. Set Hotfix › Repo root in settings, or open a workspace folder."
      );
      return;
    }
    const worktree = await ensureHotfixWorktree(baseRoot, undefined, {
      ghPath: getGhPath(),
      postCreateCommand: getWorktreePostCreateCommand(),
    });
    const cwd = worktree.path;
    const cmd = buildHotfixCommand(mergedNumbers, ctx.cli, cwd);
    const runResult = await runHotfixShellCommandAfterMerge({
      command: cmd,
      cwd,
      prNumbers: mergedNumbers,
      worktree: {
        created: worktree.created,
        fallback: worktree.fallback,
        fallbackDetail: worktree.fallbackDetail,
        notificationKey: `fordefiHotfix.worktree.${cwd}.notified`,
        context: this.deps.globalState ? { globalState: this.deps.globalState } : undefined,
      },
    });
    if (this.aborted) {
      // User pressed Stop during fcli; don't proceed into the deploy phase.
      return;
    }
    if (deploy) {
      await this.handleDeployAfterFcli({
        runResult,
        env,
        cwd,
        sourcePrNumbers: mergedNumbers,
      });
    }
  }

  private async handleDeployAfterFcli(params: {
    runResult: HotfixShellRunResult;
    env: HotfixCliOptions["env"];
    cwd: string;
    sourcePrNumbers: readonly number[];
  }): Promise<void> {
    const { runResult, env, cwd, sourcePrNumbers } = params;
    const abort = { aborted: this.aborted };
    this.currentDeployAbort = abort;
    const { owner: fallbackOwner, repo: fallbackRepo } = getRepoConfig();
    const wf = getWorkflowsRepoConfig();
    const workflowsTargets = {
      repoSlug: `${wf.owner}/${wf.repo}`,
      preWorkflow: wf.preWorkflow,
      prodWorkflow: wf.prodWorkflow,
      ref: wf.ref,
    };

    const result = await orchestrateDeployAfterFcli({
      runResult,
      env,
      cwd,
      fallbackRepo: { owner: fallbackOwner, repo: fallbackRepo },
      sourcePrNumbers,
      deps: {
        resolveToken: () => this.deps.resolveToken(),
        watchPr: watchHotfixPrMerge,
        runDeploy: runHotfixDeploy,
        askForHotfixUrl: (fb) => this.deps.ui.askHotfixUrl(fb),
        pollIntervalMs: getHotfixPrPollIntervalMs(),
        workflowsTargets,
        abort,
        hooks: {
          onResolvedPr: (parsed) => {
            this.watching = true;
            this.deployPhase = {
              prNumber: parsed.prNumber,
              title: `PR #${parsed.prNumber}`,
              state: "open",
              merged: false,
              owner: parsed.owner,
              repo: parsed.repo,
              abort,
            };
            this.statusMessage = `Waiting on hotfix PR #${parsed.prNumber} to merge…`;
            this.deps.onChange();
          },
          onWatchPhase: (phase) => {
            if (!this.deployPhase) {
              return;
            }
            if (phase.kind === "waiting" || phase.kind === "merged" || phase.kind === "closed") {
              const p = phase.pull;
              this.deployPhase.title = p.title;
              this.deployPhase.state = p.state;
              this.deployPhase.merged = Boolean(p.merged_at);
            }
            if (phase.kind === "waiting") {
              this.statusMessage = `Waiting on hotfix PR #${this.deployPhase.prNumber} to merge…`;
            } else if (phase.kind === "error") {
              this.statusMessage = `Hotfix PR poll error — retrying… (${phase.message})`;
            }
            this.deps.onChange();
          },
          onDeployDispatchStart: (dispatchEnv) => {
            this.deployRunning = true;
            // Phase-aware Stop now terminates the local dispatch script
            // mid-flight too — surface that fact in the live status line so
            // users don't think Stop is locked. The "Hotfix deploy started"
            // milestone notification is fired from the deploy runner itself
            // (transparent / debug); we deliberately don't double-fire here.
            this.statusMessage = `Hotfix PR merged. Dispatching ${describeEnvShort(
              dispatchEnv
            )} workflow(s) — press Stop to abort the local script.`;
            this.deps.onChange();
          },
          onDeployDispatchEnd: () => {
            this.deployRunning = false;
            this.deps.onChange();
          },
        },
      },
    });

    this.currentDeployAbort = null;
    this.applyDeployOutcome(result);
  }

  private applyDeployOutcome(result: Awaited<ReturnType<typeof orchestrateDeployAfterFcli>>): void {
    const desc = describeDeployOutcome(result);
    if (desc.deployEnded) {
      this.deployRunning = false;
    }
    if (desc.message) {
      if (desc.severity === "error") {
        this.deps.ui.error(desc.message);
      } else if (desc.severity === "warn") {
        this.deps.ui.warn(desc.message);
      } else if (desc.severity === "info") {
        this.deps.ui.info(desc.message);
      }
    }
    if (desc.stopsWatch) {
      this.stop();
    }
  }
}

function formatHotfixWatchSummary(cli: HotfixCliOptions): string {
  const flags = buildHotfixCliSuffix(cli).trim();
  const base = flags
    ? `When every PR is merged → run your command with ${flags}`
    : "When every PR is merged → run your command (no extra hotfix flags)";
  return cli.deploy
    ? `${base}, then watch the hotfix PR and deploy ${describeEnvShort(cli.env)}`
    : base;
}

/** User-facing label for an env. Returns short names ("pre", "prod",
 *  "pre → prod") rather than workflow filenames. The filename leak used to
 *  confuse non-developers reading the live-watch banner. */
function describeEnvShort(env: HotfixCliOptions["env"]): string {
  if (env === "pre") return "pre";
  if (env === "prod") return "prod";
  return "pre → prod";
}

/** Default UI sink wired to `vscode.window.*` + `setContext`. */
export function createDefaultWatchSessionUi(): WatchSessionUi {
  return {
    info: (msg) => void vscode.window.showInformationMessage(msg),
    warn: (msg) => void vscode.window.showWarningMessage(msg),
    error: (msg) => void vscode.window.showErrorMessage(msg),
    askHotfixUrl: (fb) => askForHotfixPrUrl(fb),
    setDeployRunningContext: (running) =>
      void vscode.commands.executeCommand("setContext", "fordefiHotfix.deployRunning", running),
  };
}

async function askForHotfixPrUrl(fallback: {
  owner: string;
  repo: string;
}): Promise<string | undefined> {
  const answer = await vscode.window.showInputBox({
    title: "Hotfix PR URL (for deploy)",
    prompt: `fcli did not emit a hotfix PR URL. Paste the created hotfix PR URL in ${fallback.owner}/${fallback.repo} to continue the deploy, or press Esc to cancel.`,
    placeHolder: `https://github.com/${fallback.owner}/${fallback.repo}/pull/123`,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const v = value.trim();
      if (!v) return "Enter a GitHub PR URL.";
      return parseGithubPullUrl(v) ? null : "Not a recognized GitHub PR URL.";
    },
  });
  return answer;
}
