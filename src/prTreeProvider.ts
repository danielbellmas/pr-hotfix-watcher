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
};

export class PrTreeProvider {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    PrRow | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private rows: PrRow[] = [];
  private selected = new Set<number>();

  private login: string | null = null;
  private loadError: string | null = null;
  private watching = false;
  private watchTarget: number[] = [];
  private watchEntries: WatchPanelEntry[] = [];
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private statusMessage = "";
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

  getViewState(): HotfixPrViewState {
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
        hotfixSummary: `Waiting on hotfix PR #${d.prNumber} to merge → then deploy ${this.hotfixCli.env}`,
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
      hotfixSummary: this.formatHotfixWatchSummary(this.hotfixCli),
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
    try {
      buildHotfixCommand(nums, this.hotfixCli);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(msg);
      return;
    }
    this.watchTarget = nums;
    this.watching = true;
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
    this._onDidChangeTreeData.fire();
  }

  private async pollOnce(): Promise<void> {
    if (!this.watching || this.watchTarget.length === 0) {
      return;
    }
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
      const mergedNumbers = [...this.watchTarget];
      const deploy = this.hotfixCli.deploy;
      const env = this.hotfixCli.env;
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

      const cmd = buildHotfixCommand(mergedNumbers, this.hotfixCli);
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
  }

  private async handleDeployAfterFcli(params: {
    runResult: HotfixShellRunResult;
    env: HotfixCliOptions["env"];
    cwd: string;
  }): Promise<void> {
    const { runResult, env, cwd } = params;
    if (runResult.exitCode !== undefined && runResult.exitCode !== 0) {
      this.stopWatch();
      void vscode.window.showErrorMessage(
        `Hotfix CLI failed — skipping deploy phase.`
      );
      return;
    }

    const parsed = await this.resolveHotfixPrForDeploy(runResult.hotfixPrUrl);
    if (!parsed) {
      this.stopWatch();
      return;
    }

    const token = await resolveGitHubToken(this.context);
    if (!token) {
      this.stopWatch();
      void vscode.window.showErrorMessage(
        "GitHub token missing; cannot watch the hotfix PR for deploy."
      );
      return;
    }

    const abort = { aborted: false };
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

    const watchResult = await watchHotfixPrMerge({
      token,
      owner: parsed.owner,
      repo: parsed.repo,
      prNumber: parsed.prNumber,
      intervalMs: getHotfixPrPollIntervalMs(),
      signal: abort,
      onPhase: (phase) => {
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
          this.statusMessage = `Waiting on hotfix PR #${parsed.prNumber} to merge…`;
        } else if (phase.kind === "error") {
          this.statusMessage = `Hotfix PR poll error — retrying… (${phase.message})`;
        }
        this._onDidChangeTreeData.fire();
      },
    });

    if (watchResult.kind === "aborted") {
      return;
    }
    if (watchResult.kind === "not_found") {
      this.stopWatch();
      void vscode.window.showErrorMessage(
        `Hotfix deploy aborted: PR #${parsed.prNumber} was not found in ${parsed.owner}/${parsed.repo}.`
      );
      return;
    }
    if (watchResult.kind === "closed") {
      this.stopWatch();
      void vscode.window.showWarningMessage(
        `Hotfix deploy aborted: PR #${parsed.prNumber} closed without merging.`
      );
      return;
    }
    if (watchResult.kind === "error") {
      this.stopWatch();
      void vscode.window.showErrorMessage(
        `Hotfix PR watch failed: ${watchResult.message}`
      );
      return;
    }

    // merged → dispatch workflows
    this.statusMessage = `Hotfix PR #${parsed.prNumber} merged. Dispatching ${env} workflow(s)…`;
    this._onDidChangeTreeData.fire();

    const wf = getWorkflowsRepoConfig();
    const targets = {
      repoSlug: `${wf.owner}/${wf.repo}`,
      preWorkflow: wf.preWorkflow,
      prodWorkflow: wf.prodWorkflow,
      ref: wf.ref,
    };
    void vscode.window.showInformationMessage(
      `Hotfix PR #${parsed.prNumber} merged. Dispatching ${describeEnv(env)}…`
    );
    const deployResult = await runHotfixDeploy({ env, targets, cwd });
    this.stopWatch();
    if (!deployResult.ok) {
      void vscode.window.showErrorMessage(
        `Hotfix deploy did not complete successfully (exit ${
          deployResult.exitCode ?? "unknown"
        }).`
      );
    }
  }

  private async resolveHotfixPrForDeploy(
    parsedUrl: string | undefined
  ): Promise<{ owner: string; repo: string; prNumber: number } | undefined> {
    if (parsedUrl) {
      const parsed = parseGithubPullUrl(parsedUrl);
      if (parsed) {
        return parsed;
      }
    }
    const { owner: fallbackOwner, repo: fallbackRepo } = getRepoConfig();
    const answer = await vscode.window.showInputBox({
      title: "Hotfix PR URL (for deploy)",
      prompt: `fcli did not emit HOTFIX_PR_URL=... Paste the created hotfix PR URL in ${fallbackOwner}/${fallbackRepo} to continue the deploy, or press Esc to cancel.`,
      placeHolder: `https://github.com/${fallbackOwner}/${fallbackRepo}/pull/123`,
      ignoreFocusOut: true,
      validateInput: (value) => {
        const v = value.trim();
        if (!v) return "Enter a GitHub PR URL";
        return parseGithubPullUrl(v) ? null : "Not a recognized GitHub PR URL";
      },
    });
    if (!answer) {
      return undefined;
    }
    return parseGithubPullUrl(answer.trim());
  }
}

function describeEnv(env: HotfixCliOptions["env"]): string {
  if (env === "pre") return "pre-hotfix.yml";
  if (env === "prod") return "production-hotfix.yml";
  return "pre-hotfix.yml → production-hotfix.yml";
}
