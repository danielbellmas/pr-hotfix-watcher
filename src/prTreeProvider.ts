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
  getPollIntervalMs,
  getRecentPrCount,
  getRepoConfig,
  getRepoRoot,
  resolveGitHubToken,
} from "./config";
import { buildHotfixCliSuffix, normalizeHotfixCliOptions, type HotfixCliOptions } from "./hotfixCli";
import { runHotfixShellCommandAfterMerge } from "./hotfixRun";
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
  private _onDidChangeTreeData = new vscode.EventEmitter<PrRow | undefined | void>();
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
    const saved = this.context.workspaceState.get<Partial<HotfixCliOptions>>("fordefiHotfix.hotfixCliView");
    this.hotfixCli = normalizeHotfixCliOptions(saved ?? undefined, getHotfixCliOptionsFromConfig());
    const savedList = this.context.workspaceState.get<Partial<PrListViewOptions>>("fordefiHotfix.prListView");
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
    return flags
      ? `When every PR is merged → run your command with ${flags}`
      : "When every PR is merged → run your command (no extra hotfix flags)";
  }

  private buildWatchPanelState(): WatchPanelState | null {
    if (!this.watching || this.watchTarget.length === 0) {
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
    this.hotfixCli = normalizeHotfixCliOptions(merged, getHotfixCliOptionsFromConfig());
    void this.context.workspaceState.update("fordefiHotfix.hotfixCliView", { ...this.hotfixCli });
    this._onDidChangeTreeData.fire();
  }

  setPrListViewOptions(partial: Partial<PrListViewOptions>): void {
    this.prListView = normalizePrListViewOptions({ ...this.prListView, ...partial });
    void this.context.workspaceState.update("fordefiHotfix.prListView", { ...this.prListView });
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
    const merged = buildDisplayPrRows(this.rows, this.remoteRows, this.searchQuery, this.selected);
    return applyPrViewFilterSort(merged, this.prListView.statusFilter, this.prListView.sortMode, this.selected);
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
      const items = await searchRepoPullRequests(token, owner, repo, trimmed, 30);
      if (gen !== this.remoteSearchGen || trimmed !== this.searchQuery.trim()) {
        return;
      }
      this.remoteRows = items.map((it) => this.rowFromSearchItem(it)).filter((row) => row.state === "open" || row.mergedAt);
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
        this.loadError = "No GitHub token. Run command “Hotfix: Set GitHub token”.";
        this.rows = [];
        return;
      }
      this.loadError = null;
      const { owner, repo } = getRepoConfig();
      const limit = getRecentPrCount();
      try {
        this.login = await getAuthenticatedLogin(token);
        const searchItems = await searchAuthorPullRequests(token, owner, repo, this.login, limit);
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
          }),
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
      void vscode.window.showWarningMessage("Select at least one PR (checkbox) to watch.");
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
    this.pollTimer = setInterval(() => void this.pollOnce(), getPollIntervalMs());
  }

  stopWatch(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.watching = false;
    this.watchTarget = [];
    this.watchEntries = [];
    this.statusMessage = "";
    this._onDidChangeTreeData.fire();
  }

  private async pollOnce(): Promise<void> {
    if (!this.watching || this.watchTarget.length === 0) {
      return;
    }
    const token = await resolveGitHubToken(this.context);
    if (!token) {
      this.stopWatch();
      void vscode.window.showErrorMessage("GitHub token missing; stopped watch.");
      return;
    }
    const { owner, repo } = getRepoConfig();
    try {
      const settled = await Promise.allSettled(
        this.watchTarget.map((n) => getPullRequest(token, owner, repo, n)),
      );
      const allFulfilled = settled.every(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof getPullRequest>>> => r.status === "fulfilled",
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
        void vscode.window.showErrorMessage(`Hotfix watch stopped: PR #${phase.prNumber} was not found.`);
        return;
      }
      if (phase.kind === "poll_error") {
        void vscode.window.showErrorMessage(`Hotfix watch poll failed: ${phase.message}`);
        return;
      }
      if (phase.kind === "stop_closed") {
        this.stopWatch();
        const nums = phase.prNumbers.join(", #");
        void vscode.window.showWarningMessage(
          `Hotfix watch stopped: PR #${nums} closed without merging.`,
        );
        return;
      }
      if (phase.kind === "continue") {
        this.statusMessage = `Waiting on #${phase.pendingNumbers.join(", #")}…`;
        this._onDidChangeTreeData.fire();
        return;
      }
      const mergedNumbers = [...this.watchTarget];
      this.stopWatch();
      const cmd = buildHotfixCommand(mergedNumbers, this.hotfixCli);
      const cwd = getRepoRoot();
      if (!cwd) {
        void vscode.window.showErrorMessage(
          "fordefiHotfix.repoRoot is empty and no workspace folder — set repo root in settings.",
        );
        return;
      }
      void vscode.window.showInformationMessage(
        `All PRs merged. Running hotfix command for ${mergedNumbers.map((n) => `#${n}`).join(", ")}…`,
      );
      await runHotfixShellCommandAfterMerge({ command: cmd, cwd, prNumbers: mergedNumbers });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`Hotfix watch poll failed: ${msg}`);
    }
  }
}
