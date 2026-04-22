import * as vscode from "vscode";
import {
  getAuthenticatedLogin,
  getPullRequest,
  GitHubError,
  isOpenOrMergedPull,
  searchAuthorPullRequests,
  searchRepoPullRequests,
  type SearchIssueItem,
} from "./githubClient";
import {
  buildHotfixCommand,
  getHotfixCliOptionsFromConfig,
  getHotfixPrPollIntervalMs,
  getPollIntervalMs,
  getRecentPrCount,
  getRepoConfig,
  getRepoRoot,
  getWorkflowsRepoConfig,
  resolveGitHubToken,
} from "./config";
import { runHotfixDeploy } from "./deployRun";
import {
  orchestrateDeployAfterFcli,
  type DeployOrchestratorResult,
} from "./deployOrchestrator";
import {
  buildHotfixCliSuffix,
  normalizeHotfixCliOptions,
  type HotfixCliOptions,
} from "./hotfixCli";
import { watchHotfixPrMerge } from "./hotfixPrMergeWatch";
import {
  runHotfixShellCommandAfterMerge,
  type HotfixShellRunResult,
} from "./hotfixRun";
import { parseGithubPullUrl } from "./hotfixRunHelpers";
import {
  applyPrViewFilterSort,
  normalizePrListViewOptions,
  type PrListViewOptions,
} from "./prListViewOptions";
import { buildDisplayPrRows, filterPrRowsByQuery } from "./prSearch";
import { phaseFromSettledPulls } from "./watchPoll";
import { MergeHandoffGate } from "./watchPollGuard";

export type PrRow = {
  number: number;
  title: string;
  state: string;
  mergedAt: string | null;
  createdAt: string;
  htmlUrl: string;
};

/** One row in the “watch” banner (live PR status while merge-watching). */
export type WatchPanelEntry = {
  number: number;
  title: string;
  state: string;
  merged: boolean;
};

export type WatchPanelState = {
  targets: number[];
  entries: WatchPanelEntry[];
  /** e.g. Waiting on #12… */
  statusLine: string;
  /** Human-readable hotfix CLI flags for this watch session */
  hotfixSummary: string;
};

export type RefreshOptions = {
  /**
   * When `false`, keep showing the current list (no full-list loader) until this fetch finishes.
   * Use for refocus / visibility background refresh.
   */
  showListLoading?: boolean;
  /**
   * When `false`, keep the search box and remote search debounce state.
   * Use together with `showListLoading: false` for view refocus.
   */
  resetSearch?: boolean;
};

export type HotfixPrViewState = {
  rows: PrRow[];
  selected: number[];
  searchQuery: string;
  searchRemoteLoading: boolean;
  searchRemoteError: string | null;
  /** Unfiltered PR count from the last refresh (webview `rows` may be search-filtered). */
  sourceRowCount: number;
  watching: boolean;
  statusMessage: string;
  /** Populated while `watching`; detailed PR rows + hotfix summary for the webview banner. */
  watchPanel: WatchPanelState | null;
  login: string | null;
  loadError: string | null;
  listLoading: boolean;
  hotfixCli: HotfixCliOptions;
  prListView: PrListViewOptions;
  /**
   * True while `runHotfixDeploy` is awaiting (hotfix PR merged, deploy
   * workflows dispatching/running). Stop is a no-op in this window because
   * killing the shell would leave an orphan dispatched run on GitHub's side.
   */
  deployRunning: boolean;
};

export class PrTreeProvider {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    PrRow | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Last value we pushed to the `fordefiHotfix.deployRunning` context key. */
  private lastDeployRunningContext = false;

  private rows: PrRow[] = [];
  private selected = new Set<number>();

  private login: string | null = null;
  private loadError: string | null = null;
  private watching = false;
  private watchTarget: number[] = [];
  private watchEntries: WatchPanelEntry[] = [];
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private statusMessage = "";
  /**
   * Re-entrancy guard for {@link pollOnce}. Ensures the direct `void pollOnce()`
   * call from `startWatch` and the `setInterval` tick cannot both run the
   * body concurrently, and that the "all merged" handoff dispatches exactly
   * once per watch even when they briefly overlap.
   */
  private readonly pollGate = new MergeHandoffGate();
  /**
   * Frozen at `startWatch` time so a user toggling the env / deploy pills
   * mid-watch cannot retroactively alter the in-flight deploy. The panel
   * banner uses this snapshot so the displayed flags match what will actually
   * run.
   */
  private watchCtx: { cli: HotfixCliOptions; prNumbers: number[] } | null = null;
  private deployRunning = false;
  /** When set, the webview banner shows the hotfix-PR deploy-phase watch entry instead of the initial merge watch. */
  private deployPhase: {
    prNumber: number;
    title: string;
    state: string;
    merged: boolean;
    owner: string;
    repo: string;
    /** Set once to cancel the polling loop from outside. */
    abort: { aborted: boolean };
  } | null = null;

  private searchQuery = "";
  private remoteRows: PrRow[] = [];
  private searchRemoteLoading = false;
  private searchRemoteError: string | null = null;
  private remoteSearchGen = 0;
  private remoteDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  private listLoading = false;
  /** After the first `refresh()` run finishes (any outcome), visibility refetch skips the list loader. */
  private initialListFetchDone = false;

  private hotfixCli!: HotfixCliOptions;
  private prListView!: PrListViewOptions;

  constructor(private readonly context: vscode.ExtensionContext) {
    const saved = this.context.workspaceState.get<Partial<HotfixCliOptions>>(
      "fordefiHotfix.hotfixCliView"
    );
    this.hotfixCli = normalizeHotfixCliOptions(
      saved ?? undefined,
      getHotfixCliOptionsFromConfig()
    );
    const savedList = this.context.workspaceState.get<
      Partial<PrListViewOptions>
    >("fordefiHotfix.prListView");
    this.prListView = normalizePrListViewOptions(savedList ?? undefined);
  }

  getWatching(): boolean {
    return this.watching;
  }

  getStatusMessage(): string {
    return this.statusMessage;
  }

  getLoadError(): string | null {
    return this.loadError;
  }

  getLogin(): string | null {
    return this.login;
  }

  getSelectedNumbers(): number[] {
    return [...this.selected].sort((a, b) => a - b);
  }

  /** Used by the webview: first open shows the list loader; later refocus uses a silent background refetch. */
  hasCompletedInitialListFetch(): boolean {
    return this.initialListFetchDone;
  }

  fireChange(): void {
    this._onDidChangeTreeData.fire();
  }

  /**
   * Push `deployRunning` into a VS Code context key so the view-title Stop
   * button can hide itself via `when: !fordefiHotfix.deployRunning`. Called
   * from the state-change sites; guarded so we don't spam the context API.
   */
  private syncDeployRunningContext(): void {
    if (this.lastDeployRunningContext === this.deployRunning) {
      return;
    }
    this.lastDeployRunningContext = this.deployRunning;
    void vscode.commands.executeCommand(
      "setContext",
      "fordefiHotfix.deployRunning",
      this.deployRunning
    );
  }

  getViewState(): HotfixPrViewState {
    this.syncDeployRunningContext();
    return {
      rows: this.buildDisplayRows(),
      selected: this.getSelectedNumbers(),
      searchQuery: this.searchQuery,
      searchRemoteLoading: this.searchRemoteLoading,
      searchRemoteError: this.searchRemoteError,
      sourceRowCount: this.rows.length,
      watching: this.watching,
      statusMessage: this.statusMessage,
      watchPanel: this.buildWatchPanelState(),
      login: this.login,
      loadError: this.loadError,
      listLoading: this.listLoading,
      hotfixCli: { ...this.hotfixCli },
      prListView: { ...this.prListView },
      deployRunning: this.deployRunning,
    };
  }

  private formatHotfixWatchSummary(cli: HotfixCliOptions): string {
    const flags = buildHotfixCliSuffix(cli).trim();
    const base = flags
      ? `When every PR is merged → run your command with ${flags}`
      : "When every PR is merged → run your command (no extra hotfix flags)";
    return cli.deploy
      ? `${base}, then watch the hotfix PR and deploy ${describeEnv(cli.env)}`
      : base;
  }

  private buildWatchPanelState(): WatchPanelState | null {
    if (!this.watching) {
      return null;
    }
    // Prefer the frozen snapshot so banners never disagree with what will
    // actually run; fall back to the live settings only before startWatch has
    // had a chance to snapshot (defensive — shouldn't happen in practice).
    const cli = this.watchCtx?.cli ?? this.hotfixCli;
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
            const row = this.rows.find((r) => r.number === n);
            return {
              number: n,
              title: row?.title ?? `PR #${n}`,
              state: row?.state ?? "open",
              merged: Boolean(row?.mergedAt),
            };
          });
    return {
      targets: [...this.watchTarget],
      entries,
      statusLine: this.statusMessage,
      hotfixSummary: this.formatHotfixWatchSummary(cli),
    };
  }

  setHotfixCliOptions(partial: Partial<HotfixCliOptions>): void {
    const merged = { ...this.hotfixCli, ...partial };
    this.hotfixCli = normalizeHotfixCliOptions(
      merged,
      getHotfixCliOptionsFromConfig()
    );
    void this.context.workspaceState.update("fordefiHotfix.hotfixCliView", {
      ...this.hotfixCli,
    });
    this._onDidChangeTreeData.fire();
  }

  setPrListViewOptions(partial: Partial<PrListViewOptions>): void {
    this.prListView = normalizePrListViewOptions({
      ...this.prListView,
      ...partial,
    });
    void this.context.workspaceState.update("fordefiHotfix.prListView", {
      ...this.prListView,
    });
    this._onDidChangeTreeData.fire();
  }

  /** Local filter on cached PRs; if nothing matches, debounced `search/issues` for the repo. */
  setSearchQuery(query: string): void {
    this.searchQuery = query;
    if (this.remoteDebounceTimer !== undefined) {
      clearTimeout(this.remoteDebounceTimer);
      this.remoteDebounceTimer = undefined;
    }

    const trimmed = query.trim();
    if (!trimmed) {
      this.bumpRemoteSearchGen();
      this.remoteRows = [];
      this.searchRemoteLoading = false;
      this.searchRemoteError = null;
      this._onDidChangeTreeData.fire();
      return;
    }

    const local = filterPrRowsByQuery(this.rows, trimmed);
    if (local.length > 0) {
      this.bumpRemoteSearchGen();
      this.remoteRows = [];
      this.searchRemoteLoading = false;
      this.searchRemoteError = null;
      this._onDidChangeTreeData.fire();
      return;
    }

    this.bumpRemoteSearchGen();
    const gen = this.remoteSearchGen;
    this.remoteRows = [];
    this.searchRemoteError = null;
    this.searchRemoteLoading = false;

    this.remoteDebounceTimer = setTimeout(() => {
      this.remoteDebounceTimer = undefined;
      if (trimmed !== this.searchQuery.trim()) {
        return;
      }
      if (filterPrRowsByQuery(this.rows, trimmed).length > 0) {
        return;
      }
      this.searchRemoteLoading = true;
      this._onDidChangeTreeData.fire();
      void this.runRepoSearch(trimmed, gen);
    }, 320);

    this._onDidChangeTreeData.fire();
  }

  private bumpRemoteSearchGen(): void {
    this.remoteSearchGen++;
  }

  private rowFromSearchItem(it: SearchIssueItem): PrRow {
    return {
      number: it.number,
      title: it.title,
      state: it.state,
      mergedAt: it.pull_request?.merged_at ?? null,
      createdAt: it.created_at ?? "",
      htmlUrl: it.html_url,
    };
  }

  private buildDisplayRows(): PrRow[] {
    const merged = buildDisplayPrRows(
      this.rows,
      this.remoteRows,
      this.searchQuery,
      this.selected
    );
    return applyPrViewFilterSort(
      merged,
      this.prListView.statusFilter,
      this.prListView.sortMode,
      this.selected
    );
  }

  private async runRepoSearch(trimmed: string, gen: number): Promise<void> {
    try {
      const token = await resolveGitHubToken(this.context);
      if (gen !== this.remoteSearchGen || trimmed !== this.searchQuery.trim()) {
        return;
      }
      if (!token) {
        this.searchRemoteError = "No GitHub token";
        this.remoteRows = [];
        return;
      }
      const { owner, repo } = getRepoConfig();
      const items = await searchRepoPullRequests(
        token,
        owner,
        repo,
        trimmed,
        30
      );
      if (gen !== this.remoteSearchGen || trimmed !== this.searchQuery.trim()) {
        return;
      }
      this.remoteRows = items
        .map((it) => this.rowFromSearchItem(it))
        .filter((row) => row.state === "open" || row.mergedAt);
      this.searchRemoteError = null;
    } catch (e) {
      if (gen !== this.remoteSearchGen || trimmed !== this.searchQuery.trim()) {
        return;
      }
      this.remoteRows = [];
      this.searchRemoteError = e instanceof Error ? e.message : String(e);
    } finally {
      if (gen === this.remoteSearchGen && trimmed === this.searchQuery.trim()) {
        this.searchRemoteLoading = false;
        this._onDidChangeTreeData.fire();
      }
    }
  }

  private resetSearchState(): void {
    if (this.remoteDebounceTimer !== undefined) {
      clearTimeout(this.remoteDebounceTimer);
      this.remoteDebounceTimer = undefined;
    }
    this.bumpRemoteSearchGen();
    this.searchQuery = "";
    this.remoteRows = [];
    this.searchRemoteLoading = false;
    this.searchRemoteError = null;
  }

  setCheckboxState(prNumber: number, checked: boolean): void {
    if (checked) {
      this.selected.add(prNumber);
    } else {
      this.selected.delete(prNumber);
    }
    this._onDidChangeTreeData.fire();
  }

  async refresh(options?: RefreshOptions): Promise<void> {
    const showListLoading = options?.showListLoading !== false;
    const resetSearch = options?.resetSearch !== false;
    if (resetSearch) {
      this.resetSearchState();
    }
    if (showListLoading) {
      this.listLoading = true;
      this._onDidChangeTreeData.fire();
    }
    try {
      const token = await resolveGitHubToken(this.context);
      if (!token) {
        this.loadError =
          "No GitHub token. Run command “Hotfix: Set GitHub token”.";
        this.rows = [];
        return;
      }
      this.loadError = null;
      const { owner, repo } = getRepoConfig();
      const limit = getRecentPrCount();
      try {
        this.login = await getAuthenticatedLogin(token);
        const searchItems = await searchAuthorPullRequests(
          token,
          owner,
          repo,
          this.login,
          limit
        );
        const orderedNumbers: number[] = [];
        const seen = new Set<number>();
        for (const it of searchItems) {
          if (!seen.has(it.number)) {
            orderedNumbers.push(it.number);
            seen.add(it.number);
          }
        }
        const numbers = orderedNumbers;
        const pulls = await Promise.all(
          numbers.map(async (n) => {
            try {
              return await getPullRequest(token, owner, repo, n);
            } catch (e) {
              if (e instanceof GitHubError && e.status === 404) {
                return null;
              }
              throw e;
            }
          })
        );
        const nextRows: PrRow[] = [];
        for (let i = 0; i < numbers.length; i++) {
          const p = pulls[i];
          if (!p || !isOpenOrMergedPull(p)) {
            continue;
          }
          nextRows.push({
            number: p.number,
            title: p.title,
            state: p.state,
            mergedAt: p.merged_at,
            createdAt: p.created_at,
            htmlUrl: p.html_url,
          });
        }
        this.rows = nextRows;
        for (const n of [...this.selected]) {
          if (!nextRows.some((r) => r.number === n)) {
            this.selected.delete(n);
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.loadError = msg;
        if (showListLoading) {
          vscode.window.showErrorMessage(`Hotfix watcher: ${msg}`);
        }
      }
    } finally {
      this.listLoading = false;
      this.initialListFetchDone = true;
      this._onDidChangeTreeData.fire();
    }
  }

  startWatch(): void {
    if (this.watching) {
      void vscode.window.showWarningMessage("Already watching.");
      return;
    }
    const nums = this.getSelectedNumbers();
    if (nums.length === 0) {
      void vscode.window.showWarningMessage(
        "Select at least one PR (checkbox) to watch."
      );
      return;
    }
    // Deep-copy so subsequent `setHotfixCliOptions` calls (env/deploy toggles)
    // cannot mutate the in-flight watch.
    const frozenCli: HotfixCliOptions = { ...this.hotfixCli };
    try {
      buildHotfixCommand(nums, frozenCli);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(msg);
      return;
    }
    this.watchCtx = { cli: frozenCli, prNumbers: [...nums] };
    this.watchTarget = nums;
    this.watching = true;
    this.pollGate.reset();
    this.deployRunning = false;
    this.watchEntries = nums.map((n) => {
      const row = this.rows.find((r) => r.number === n);
      return {
        number: n,
        title: row?.title ?? `PR #${n}`,
        state: row?.state ?? "open",
        merged: Boolean(row?.mergedAt),
      };
    });
    this.statusMessage = `Waiting on #${nums.join(", #")}…`;
    this._onDidChangeTreeData.fire();
    void this.pollOnce();
    this.pollTimer = setInterval(
      () => void this.pollOnce(),
      getPollIntervalMs()
    );
  }

  stopWatch(): void {
    // UI-honest behavior: once `runHotfixDeploy` is in flight the dispatched
    // workflow lives on GitHub; the best thing the extension can do is leave
    // it alone. Log a hint and return without touching state so the banner
    // keeps showing "Deploying…".
    if (this.deployRunning) {
      console.info(
        "[fordefi-hotfix] Stop pressed during deploy phase — workflow already dispatched, letting it finish."
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
    this._onDidChangeTreeData.fire();
  }

  private async pollOnce(): Promise<void> {
    if (!this.watching || this.watchTarget.length === 0) {
      return;
    }
    await this.pollGate.runPoll(async ({ claimMerge }) => {
      const token = await resolveGitHubToken(this.context);
      if (!token) {
        this.stopWatch();
        void vscode.window.showErrorMessage(
          "GitHub token missing; stopped watch."
        );
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
          this.stopWatch();
          void vscode.window.showErrorMessage(
            `Hotfix watch stopped: PR #${phase.prNumber} was not found.`
          );
          return;
        }
        if (phase.kind === "poll_error") {
          void vscode.window.showErrorMessage(
            `Hotfix watch poll failed: ${phase.message}`
          );
          return;
        }
        if (phase.kind === "stop_closed") {
          this.stopWatch();
          const nums = phase.prNumbers.join(", #");
          void vscode.window.showWarningMessage(
            `Hotfix watch stopped: PR #${nums} closed without merging.`
          );
          return;
        }
        if (phase.kind === "continue") {
          this.statusMessage = `Waiting on #${phase.pendingNumbers.join(", #")}…`;
          this._onDidChangeTreeData.fire();
          return;
        }

        // Claim the merge handoff before any `await`. If another poll raced
        // past the gate's `pollInFlight` check and reached this branch too,
        // only one of them will own the claim and dispatch fcli + deploy.
        if (!claimMerge()) {
          return;
        }
        const ctx = this.watchCtx ?? {
          cli: { ...this.hotfixCli },
          prNumbers: [...this.watchTarget],
        };
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
        this._onDidChangeTreeData.fire();

        const cmd = buildHotfixCommand(mergedNumbers, ctx.cli);
        const cwd = getRepoRoot();
        if (!cwd) {
          this.watching = false;
          this._onDidChangeTreeData.fire();
          void vscode.window.showErrorMessage(
            "fordefiHotfix.repoRoot is empty and no workspace folder — set repo root in settings."
          );
          return;
        }
        void vscode.window.showInformationMessage(
          `All PRs merged. Running hotfix command for ${mergedNumbers
            .map((n) => `#${n}`)
            .join(", ")}…`
        );
        const runResult = await runHotfixShellCommandAfterMerge({
          command: cmd,
          cwd,
          prNumbers: mergedNumbers,
        });
        if (deploy) {
          await this.handleDeployAfterFcli({
            runResult,
            env,
            cwd,
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        void vscode.window.showErrorMessage(`Hotfix watch poll failed: ${msg}`);
      }
    });
  }

  private async handleDeployAfterFcli(params: {
    runResult: HotfixShellRunResult;
    env: HotfixCliOptions["env"];
    cwd: string;
  }): Promise<void> {
    const { runResult, env, cwd } = params;
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
      deps: {
        resolveToken: () => resolveGitHubToken(this.context),
        watchPr: watchHotfixPrMerge,
        runDeploy: runHotfixDeploy,
        askForHotfixUrl: (fb) => askForHotfixPrUrl(fb),
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
            this._onDidChangeTreeData.fire();
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
            this._onDidChangeTreeData.fire();
          },
          onDeployDispatchStart: (dispatchEnv) => {
            this.deployRunning = true;
            this.statusMessage = `Hotfix PR merged. Dispatching ${dispatchEnv} workflow(s) — Stop is disabled once dispatched.`;
            this._onDidChangeTreeData.fire();
            void vscode.window.showInformationMessage(
              `Hotfix PR merged. Dispatching ${describeEnv(dispatchEnv)}…`
            );
          },
          onDeployDispatchEnd: () => {
            this.deployRunning = false;
            this._onDidChangeTreeData.fire();
          },
        },
      },
    });

    this.applyDeployOrchestratorResult(result);
  }

  private applyDeployOrchestratorResult(
    result: DeployOrchestratorResult
  ): void {
    switch (result.kind) {
      case "fcli_failed":
        this.stopWatch();
        void vscode.window.showErrorMessage(
          `Hotfix CLI failed — skipping deploy phase.`
        );
        return;
      case "cancelled_no_url":
        this.stopWatch();
        return;
      case "no_token":
        this.stopWatch();
        void vscode.window.showErrorMessage(
          "GitHub token missing; cannot watch the hotfix PR for deploy."
        );
        return;
      case "aborted":
        // User pressed Stop before deploy kicked in — `stopWatch` already
        // cleared state. Don't call it again.
        return;
      case "pr_not_found":
        this.stopWatch();
        void vscode.window.showErrorMessage(
          `Hotfix deploy aborted: PR #${result.prNumber} was not found in ${result.owner}/${result.repo}.`
        );
        return;
      case "pr_closed_without_merge":
        this.stopWatch();
        void vscode.window.showWarningMessage(
          `Hotfix deploy aborted: PR #${result.prNumber} closed without merging.`
        );
        return;
      case "watch_error":
        this.stopWatch();
        void vscode.window.showErrorMessage(
          `Hotfix PR watch failed: ${result.message}`
        );
        return;
      case "deploy_failed":
        this.deployRunning = false;
        this.stopWatch();
        void vscode.window.showErrorMessage(
          `Hotfix deploy did not complete successfully (exit ${
            result.exitCode ?? "unknown"
          }).`
        );
        return;
      case "deploy_succeeded":
        this.deployRunning = false;
        this.stopWatch();
        return;
    }
  }
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

function describeEnv(env: HotfixCliOptions["env"]): string {
  if (env === "pre") return "pre-hotfix.yml";
  if (env === "prod") return "production-hotfix.yml";
  return "pre-hotfix.yml → production-hotfix.yml";
}
