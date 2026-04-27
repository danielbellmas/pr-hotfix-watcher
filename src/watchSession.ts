import * as vscode from "vscode";
import {
  buildHotfixCommand,
  getHotfixPrPollIntervalMs,
  getPollIntervalMs,
  getRepoConfig,
  getRepoRoot,
  getWorkflowsRepoConfig,
} from "./config";
import {
  describeDeployOutcome,
  orchestrateDeployAfterFcli,
} from "./deployOrchestrator";
import { runHotfixDeploy } from "./deployRun";
import { getPullRequest } from "./githubClient";
import { buildHotfixCliSuffix, type HotfixCliOptions } from "./hotfixCli";
import { watchHotfixPrMerge } from "./hotfixPrMergeWatch";
import {
  runHotfixShellCommandAfterMerge,
  type HotfixShellRunResult,
} from "./hotfixRun";
import { parseGithubPullUrl } from "./hotfixRunHelpers";
import { phaseFromSettledPulls } from "./watchPoll";
import { MergeHandoffGate } from "./watchPollGuard";
import { ensureHotfixWorktree } from "./worktreeManager";

/**
 * Owns the watch lifecycle: pre-fcli upstream-PR poll, fcli execution, and
 * the post-fcli hotfix-PR poll + deploy. Centralizing keeps the invariants
 * (re-entrancy gate, frozen cli snapshot, "Stop is a no-op while deploying",
 * `deployRunning` mirrored to a context key) in one place. `PrTreeProvider`
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
  askHotfixUrl: (fb: {
    owner: string;
    repo: string;
  }) => Promise<string | undefined>;
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

export class WatchSession {
  private watching = false;
  private watchTarget: number[] = [];
  private watchEntries: WatchPanelEntry[] = [];
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private readonly pollGate = new MergeHandoffGate();
  /** Frozen at `start()` so toggling env / deploy mid-watch can't alter the
   *  in-flight session. */
  private watchCtx: { cli: HotfixCliOptions; prNumbers: number[] } | null =
    null;
  private deployRunning = false;
  private deployPhase: DeployPhase | null = null;
  private statusMessage = "";
  private lastDeployRunningContext = false;

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
    this.pollGate.reset();
    this.deployRunning = false;
    this.watchEntries = initialEntries.map((e) => ({ ...e }));
    this.statusMessage = `Waiting on #${prNumbers.join(", #")}…`;
    this.deps.onChange();
    void this.pollOnce();
    this.pollTimer = setInterval(
      () => void this.pollOnce(),
      getPollIntervalMs()
    );
  }

  /** No-op while `deployRunning` — the workflow run already exists on GitHub
   *  and there's nothing useful to cancel. */
  stop(): void {
    if (this.deployRunning) {
      console.info(
        "[fordefi-hotfix] Stop pressed during deploy phase — letting dispatched workflow finish."
      );
      return;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.deployPhase) {
      this.deployPhase.abort.aborted = true;
    }
    this.watching = false;
    this.watchTarget = [];
    this.watchEntries = [];
    this.statusMessage = "";
    this.deployPhase = null;
    this.watchCtx = null;
    this.pollGate.reset();
    this.deps.onChange();
  }

  /** Returns `null` when idle. Prefers the frozen `cli` snapshot over
   *  `liveCli` so the banner can't disagree with the in-flight run. */
  buildPanelState(
    liveCli: HotfixCliOptions,
    lookupRow: (
      n: number
    ) => { title: string; state: string; merged: boolean } | undefined
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
        hotfixSummary: `Waiting on hotfix PR #${d.prNumber} to merge → then deploy ${cli.env}`,
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
        this.deps.ui.error("GitHub token missing; stopped watch.");
        return;
      }
      const { owner, repo } = getRepoConfig();
      try {
        const settled = await Promise.allSettled(
          this.watchTarget.map((n) => getPullRequest(token, owner, repo, n))
        );
        const allFulfilled = settled.every(
          (
            r
          ): r is PromiseFulfilledResult<
            Awaited<ReturnType<typeof getPullRequest>>
          > => r.status === "fulfilled"
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
          this.deps.ui.error(
            `Hotfix watch stopped: PR #${phase.prNumber} was not found.`
          );
          return;
        }
        if (phase.kind === "poll_error") {
          this.deps.ui.error(`Hotfix watch poll failed: ${phase.message}`);
          return;
        }
        if (phase.kind === "stop_closed") {
          this.stop();
          const nums = phase.prNumbers.join(", #");
          this.deps.ui.warn(
            `Hotfix watch stopped: PR #${nums} closed without merging.`
          );
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
        this.deps.ui.error(`Hotfix watch poll failed: ${msg}`);
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
    this.statusMessage = deploy
      ? "Running hotfix CLI, then watching hotfix PR to deploy…"
      : "";
    if (!deploy) {
      this.watching = false;
    }
    this.deps.onChange();

    const baseRoot = getRepoRoot();
    if (!baseRoot) {
      this.watching = false;
      this.deps.onChange();
      this.deps.ui.error(
        "fordefiHotfix.repoRoot is empty and no workspace folder — set repo root in settings."
      );
      return;
    }
    const worktree = await ensureHotfixWorktree(baseRoot);
    const cwd = worktree.path;
    const cmd = buildHotfixCommand(mergedNumbers, ctx.cli, cwd);
    this.deps.ui.info(
      `All PRs merged. Running hotfix command for ${mergedNumbers
        .map((n) => `#${n}`)
        .join(", ")}…`
    );
    const runResult = await runHotfixShellCommandAfterMerge({
      command: cmd,
      cwd,
      prNumbers: mergedNumbers,
      worktree: {
        created: worktree.created,
        fallback: worktree.fallback,
        fallbackDetail: worktree.fallbackDetail,
        notificationKey: `fordefiHotfix.worktree.${cwd}.notified`,
        context: this.deps.globalState
          ? { globalState: this.deps.globalState }
          : undefined,
      },
    });
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
    const abort = { aborted: false };
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
            if (
              phase.kind === "waiting" ||
              phase.kind === "merged" ||
              phase.kind === "closed"
            ) {
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
            this.statusMessage = `Hotfix PR merged. Dispatching ${dispatchEnv} workflow(s) — Stop is disabled once dispatched.`;
            this.deps.onChange();
            this.deps.ui.info(
              `Hotfix PR merged. Dispatching ${describeEnv(dispatchEnv)}…`
            );
          },
          onDeployDispatchEnd: () => {
            this.deployRunning = false;
            this.deps.onChange();
          },
        },
      },
    });

    this.applyDeployOutcome(result);
  }

  private applyDeployOutcome(
    result: Awaited<ReturnType<typeof orchestrateDeployAfterFcli>>
  ): void {
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
    ? `${base}, then watch the hotfix PR and deploy ${describeEnv(cli.env)}`
    : base;
}

function describeEnv(env: HotfixCliOptions["env"]): string {
  if (env === "pre") return "pre-hotfix.yml";
  if (env === "prod") return "production-hotfix.yml";
  return "pre-hotfix.yml → production-hotfix.yml";
}

/** Default UI sink wired to `vscode.window.*` + `setContext`. */
export function createDefaultWatchSessionUi(): WatchSessionUi {
  return {
    info: (msg) => void vscode.window.showInformationMessage(msg),
    warn: (msg) => void vscode.window.showWarningMessage(msg),
    error: (msg) => void vscode.window.showErrorMessage(msg),
    askHotfixUrl: (fb) => askForHotfixPrUrl(fb),
    setDeployRunningContext: (running) =>
      void vscode.commands.executeCommand(
        "setContext",
        "fordefiHotfix.deployRunning",
        running
      ),
  };
}

async function askForHotfixPrUrl(fallback: {
  owner: string;
  repo: string;
}): Promise<string | undefined> {
  const answer = await vscode.window.showInputBox({
    title: "Hotfix PR URL (for deploy)",
    prompt: `fcli did not emit HOTFIX_PR_URL=... Paste the created hotfix PR URL in ${fallback.owner}/${fallback.repo} to continue the deploy, or press Esc to cancel.`,
    placeHolder: `https://github.com/${fallback.owner}/${fallback.repo}/pull/123`,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const v = value.trim();
      if (!v) return "Enter a GitHub PR URL";
      return parseGithubPullUrl(v) ? null : "Not a recognized GitHub PR URL";
    },
  });
  return answer;
}
