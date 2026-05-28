import * as vscode from "vscode";
import {
  getAuthenticatedLogin,
  getPullRequest,
  GitHubError,
  isHotfixTitle,
  isOpenOrMergedPull,
  searchAuthorPullRequests,
  searchRepoPullRequests,
  type SearchIssueItem,
} from "./githubClient";
import {
  buildHotfixCommand,
  getDisplayPrLimit,
  getHotfixCliOptionsFromConfig,
  getRecentPrCount,
  getRepoConfig,
  getRepoRoot,
  getWorkflowsRepoConfig,
  resolveGitHubToken,
} from "./config";
import { runHotfixDeploy, getHotfixDeployOutputChannel } from "./deployRun";
import { normalizeHotfixCliOptions, type HotfixCliEnv, type HotfixCliOptions } from "./hotfixCli";
import {
  applyPrViewFilterSort,
  normalizePrListViewOptions,
  type PrListViewOptions,
} from "./prListViewOptions";
import { buildDisplayPrRows, filterPrRowsByQuery } from "./prSearch";
import {
  createDefaultWatchSessionUi,
  WatchSession,
  type WatchPanelEntry,
  type WatchPanelState,
} from "./watchSession";

export type { WatchPanelEntry, WatchPanelState };

export type PrRow = {
  number: number;
  title: string;
  state: string;
  mergedAt: string | null;
  createdAt: string;
  htmlUrl: string;
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

const SELECTED_PRS_KEY = "fordefiHotfix.selectedPrs";

export class PrListController {
  private _onDidChangeTreeData = new vscode.EventEmitter<PrRow | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private rows: PrRow[] = [];
  private selected = new Set<number>();

  private login: string | null = null;
  private loadError: string | null = null;

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

  private readonly watchSession: WatchSession;
  private manualDeployRunning = false;
  private lastDeployRunningContext: boolean | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    const savedSelected = this.context.workspaceState.get<number[]>(SELECTED_PRS_KEY);
    if (savedSelected?.length) {
      for (const n of savedSelected) this.selected.add(n);
    }

    const saved = this.context.workspaceState.get<Partial<HotfixCliOptions>>(
      "fordefiHotfix.hotfixCliView"
    );
    this.hotfixCli = normalizeHotfixCliOptions(saved ?? undefined, getHotfixCliOptionsFromConfig());
    const savedList = this.context.workspaceState.get<Partial<PrListViewOptions>>(
      "fordefiHotfix.prListView"
    );
    this.prListView = normalizePrListViewOptions(savedList ?? undefined);
    this.watchSession = new WatchSession({
      ui: createDefaultWatchSessionUi(),
      onChange: () => this._onDidChangeTreeData.fire(undefined),
      resolveToken: () => resolveGitHubToken(this.context),
      globalState: this.context.globalState,
    });
  }

  private persistSelected(): void {
    void this.context.workspaceState.update(
      SELECTED_PRS_KEY,
      this.selected.size > 0 ? [...this.selected] : undefined
    );
  }

  getWatching(): boolean {
    return this.watchSession.isWatching();
  }

  getStatusMessage(): string {
    return this.watchSession.getStatusMessage();
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
    this._onDidChangeTreeData.fire(undefined);
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
      watching: this.watchSession.isWatching(),
      statusMessage: this.watchSession.getStatusMessage(),
      watchPanel: this.watchSession.buildPanelState(this.hotfixCli, (n) => {
        const row = this.rows.find((r) => r.number === n);
        if (!row) return undefined;
        return {
          title: row.title,
          state: row.state,
          merged: Boolean(row.mergedAt),
        };
      }),
      login: this.login,
      loadError: this.loadError,
      listLoading: this.listLoading,
      hotfixCli: { ...this.hotfixCli },
      prListView: { ...this.prListView },
      deployRunning: this.watchSession.isDeployRunning() || this.manualDeployRunning,
    };
  }

  private syncDeployRunningContext(): void {
    const running = this.watchSession.isDeployRunning() || this.manualDeployRunning;
    if (this.lastDeployRunningContext === running) {
      return;
    }
    this.lastDeployRunningContext = running;
    void vscode.commands.executeCommand("setContext", "fordefiHotfix.deployRunning", running);
  }

  setHotfixCliOptions(partial: Partial<HotfixCliOptions>): void {
    const merged = { ...this.hotfixCli, ...partial };
    this.hotfixCli = normalizeHotfixCliOptions(merged, getHotfixCliOptionsFromConfig());
    void this.context.workspaceState.update("fordefiHotfix.hotfixCliView", {
      ...this.hotfixCli,
    });
    this._onDidChangeTreeData.fire(undefined);
  }

  setPrListViewOptions(partial: Partial<PrListViewOptions>): void {
    this.prListView = normalizePrListViewOptions({
      ...this.prListView,
      ...partial,
    });
    void this.context.workspaceState.update("fordefiHotfix.prListView", {
      ...this.prListView,
    });
    this._onDidChangeTreeData.fire(undefined);
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
      this._onDidChangeTreeData.fire(undefined);
      return;
    }

    const local = filterPrRowsByQuery(this.rows, trimmed);
    if (local.length > 0) {
      this.bumpRemoteSearchGen();
      this.remoteRows = [];
      this.searchRemoteLoading = false;
      this.searchRemoteError = null;
      this._onDidChangeTreeData.fire(undefined);
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
      this._onDidChangeTreeData.fire(undefined);
      void this.runRepoSearch(trimmed, gen);
    }, 320);

    this._onDidChangeTreeData.fire(undefined);
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
    const sorted = applyPrViewFilterSort(
      merged,
      this.prListView.statusFilter,
      this.prListView.sortMode,
      this.selected
    );
    return capDisplayRows(sorted, getDisplayPrLimit(), this.selected);
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
      this.remoteRows = items
        .map((it) => this.rowFromSearchItem(it))
        .filter((row) => (row.state === "open" || row.mergedAt) && !isHotfixTitle(row.title));
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
        this._onDidChangeTreeData.fire(undefined);
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
    this.persistSelected();
    this._onDidChangeTreeData.fire(undefined);
  }

  async refresh(options?: RefreshOptions): Promise<void> {
    const showListLoading = options?.showListLoading !== false;
    const resetSearch = options?.resetSearch !== false;
    if (resetSearch) {
      this.resetSearchState();
    }
    if (showListLoading) {
      this.listLoading = true;
      this._onDidChangeTreeData.fire(undefined);
    }
    try {
      const token = await resolveGitHubToken(this.context);
      if (!token) {
        this.loadError =
          'No GitHub token. Run `gh auth login` in a terminal, or use "Hotfix: Set GitHub token" for a PAT override.';
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
          })
        );
        const nextRows: PrRow[] = [];
        for (let i = 0; i < numbers.length; i++) {
          const p = pulls[i];
          if (!p || !isOpenOrMergedPull(p) || isHotfixTitle(p.title)) {
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
        let pruned = false;
        for (const n of [...this.selected]) {
          if (!nextRows.some((r) => r.number === n)) {
            this.selected.delete(n);
            pruned = true;
          }
        }
        if (pruned) this.persistSelected();
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
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  startWatch(): void {
    if (this.watchSession.isWatching()) {
      void vscode.window.showWarningMessage("Already watching a hotfix batch.");
      return;
    }
    const nums = this.getSelectedNumbers();
    if (nums.length === 0) {
      void vscode.window.showWarningMessage("Select at least one PR to watch.");
      return;
    }
    const frozenCli: HotfixCliOptions = { ...this.hotfixCli };
    try {
      buildHotfixCommand(nums, frozenCli);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(msg);
      return;
    }
    const initialEntries = nums.map((n) => {
      const row = this.rows.find((r) => r.number === n);
      return {
        number: n,
        title: row?.title ?? `PR #${n}`,
        state: row?.state ?? "open",
        merged: Boolean(row?.mergedAt),
      };
    });

    this.selected.clear();
    this.persistSelected();

    this.watchSession.start({
      prNumbers: nums,
      cli: frozenCli,
      initialEntries,
    });
  }

  stopWatch(): void {
    this.watchSession.stop();
  }

  /** Dispatch pre or prod workflow(s) immediately — no watch / fcli required. */
  async deployEnv(env: Exclude<HotfixCliEnv, "both">): Promise<void> {
    if (this.watchSession.isDeployRunning() || this.manualDeployRunning) {
      void vscode.window.showWarningMessage("A hotfix deploy is already running.");
      return;
    }
    if (this.watchSession.isWatching()) {
      void vscode.window.showWarningMessage("Stop live watch before manual deploy.");
      return;
    }
    const cwd = getRepoRoot();
    if (!cwd) {
      void vscode.window.showErrorMessage(
        "Open a workspace folder, or set Hotfix › Repo root in settings."
      );
      return;
    }
    const wf = getWorkflowsRepoConfig();
    const targets = {
      repoSlug: `${wf.owner}/${wf.repo}`,
      preWorkflow: wf.preWorkflow,
      prodWorkflow: wf.prodWorkflow,
      ref: wf.ref,
    };
    const ch = getHotfixDeployOutputChannel();
    ch.show(true);
    ch.appendLine(`[deploy-trace] manual deploy env=${env} cwd=${cwd}`);

    this.manualDeployRunning = true;
    this.syncDeployRunningContext();
    this._onDidChangeTreeData.fire(undefined);
    try {
      await runHotfixDeploy({ env, targets, cwd });
    } finally {
      this.manualDeployRunning = false;
      this.syncDeployRunningContext();
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  /** @internal — exposed for integration tests. Not part of the public API. */
  pollOnce(): Promise<void> {
    return this.watchSession.pollOnce();
  }
}

/**
 * Cap visible PR rows at `limit` while keeping every selected PR visible.
 * Sort order is preserved; selected rows beyond the cap are appended in their
 * original relative order so the user never loses sight of a checked PR.
 */
export function capDisplayRows(
  rows: readonly PrRow[],
  limit: number,
  selected: ReadonlySet<number>
): PrRow[] {
  if (rows.length <= limit) {
    return [...rows];
  }
  const head = rows.slice(0, limit);
  if (selected.size === 0) {
    return head;
  }
  const inHead = new Set(head.map((r) => r.number));
  const extras = rows.slice(limit).filter((r) => selected.has(r.number) && !inHead.has(r.number));
  return [...head, ...extras];
}
