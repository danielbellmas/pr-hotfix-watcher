import * as vscode from "vscode";
import type { PrTreeProvider } from "./prTreeProvider";
import type { PrSortMode, PrStatusFilter } from "./prListViewOptions";

type FromWebview =
  | { command: "toggle"; number: number }
  | { command: "open"; url: string }
  | { command: "ready" }
  | { command: "searchQuery"; query: string }
  | {
      command: "hotfixCli";
      env?: string;
      draft?: boolean;
      criticalFastTrack?: boolean;
      deploy?: boolean;
    }
  | { command: "prListView"; statusFilter?: string; sortMode?: string };

export type GithubPrColorScheme = "light" | "dark";

export function activeGithubColorScheme(): GithubPrColorScheme {
  const k = vscode.window.activeColorTheme.kind;
  if (
    k === vscode.ColorThemeKind.Light ||
    k === vscode.ColorThemeKind.HighContrastLight
  ) {
    return "light";
  }
  return "dark";
}

export class HotfixPrWebviewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "fordefiHotfix.prList";

  private view: vscode.WebviewView | undefined;

  constructor(private readonly prs: PrTreeProvider) {
    this.prs.onDidChangeTreeData(() => this.pushState());
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };
    const nonce = getNonce();
    webviewView.webview.html = getHtml(
      webviewView.webview,
      nonce,
      activeGithubColorScheme()
    );
    webviewView.webview.onDidReceiveMessage((msg: FromWebview) => {
      if (msg.command === "ready") {
        this.pushState();
        return;
      }
      if (msg.command === "open") {
        const raw = typeof msg.url === "string" ? msg.url.trim() : "";
        if (!raw) {
          return;
        }
        let uri: vscode.Uri;
        try {
          uri = vscode.Uri.parse(raw, true);
        } catch {
          return;
        }
        if (uri.scheme !== "https" && uri.scheme !== "http") {
          return;
        }
        void vscode.env.openExternal(uri);
        return;
      }
      if (msg.command === "toggle") {
        const n = msg.number;
        if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
          return;
        }
        const on = this.prs.getSelectedNumbers().includes(n);
        this.prs.setCheckboxState(n, !on);
        return;
      }
      if (msg.command === "searchQuery") {
        this.prs.setSearchQuery(typeof msg.query === "string" ? msg.query : "");
        return;
      }
      if (msg.command === "hotfixCli") {
        const p: {
          env?: "pre" | "prod" | "both";
          draft?: boolean;
          criticalFastTrack?: boolean;
          deploy?: boolean;
        } = {};
        if (msg.env === "pre" || msg.env === "prod" || msg.env === "both") {
          p.env = msg.env;
        }
        if (typeof msg.draft === "boolean") {
          p.draft = msg.draft;
        }
        if (typeof msg.criticalFastTrack === "boolean") {
          p.criticalFastTrack = msg.criticalFastTrack;
        }
        if (typeof msg.deploy === "boolean") {
          p.deploy = msg.deploy;
        }
        this.prs.setHotfixCliOptions(p);
        return;
      }
      if (msg.command === "prListView") {
        const p: { statusFilter?: PrStatusFilter; sortMode?: PrSortMode } = {};
        const sf = msg.statusFilter;
        if (sf === "all" || sf === "open" || sf === "merged") {
          p.statusFilter = sf;
        }
        const sm = msg.sortMode;
        if (sm === "status" || sm === "created") {
          p.sortMode = sm;
        }
        if (Object.keys(p).length > 0) {
          this.prs.setPrListViewOptions(p);
        }
        return;
      }
    });
    const fetchPrsIfVisible = (): void => {
      if (webviewView.visible) {
        if (this.prs.hasCompletedInitialListFetch()) {
          void this.prs.refresh({ showListLoading: false, resetSearch: false });
        } else {
          void this.prs.refresh();
        }
      }
    };
    webviewView.onDidChangeVisibility(fetchPrsIfVisible);
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });
    fetchPrsIfVisible();
  }

  notifyThemeChanged(): void {
    this.pushState();
  }

  private pushState(): void {
    if (!this.view) {
      return;
    }
    const s = this.prs.getViewState();
    void this.view.webview.postMessage({
      type: "state",
      state: s,
      githubScheme: activeGithubColorScheme(),
    });
  }
}

function getNonce(): string {
  let t = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    t += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return t;
}

function getHtml(
  webview: vscode.Webview,
  nonce: string,
  initialGithubScheme: GithubPrColorScheme
): string {
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style>
    :root {
      --hf-radius: 12px;
      --hf-radius-sm: 8px;
      --hf-blur: 18px;
      /* PR status chips — GitHub light palette */
      --gh-open-fg: #1a7f37;
      --gh-open-bg: color-mix(in srgb, #1a7f37 14%, transparent);
      --gh-open-border: color-mix(in srgb, #1a7f37 40%, transparent);
      --gh-merged-fg: #8250df;
      --gh-merged-bg: color-mix(in srgb, #8250df 14%, transparent);
      --gh-merged-border: color-mix(in srgb, #8250df 38%, transparent);
      --gh-closed-fg: #d1242f;
      --gh-closed-bg: color-mix(in srgb, #d1242f 12%, transparent);
      --gh-closed-border: color-mix(in srgb, #d1242f 38%, transparent);
    }
    body[data-gh-scheme="dark"] {
      /* PR status chips — GitHub dark palette */
      --gh-open-fg: #3fb950;
      --gh-open-bg: color-mix(in srgb, #3fb950 16%, transparent);
      --gh-open-border: color-mix(in srgb, #3fb950 42%, transparent);
      --gh-merged-fg: #a371f7;
      --gh-merged-bg: color-mix(in srgb, #a371f7 18%, transparent);
      --gh-merged-border: color-mix(in srgb, #a371f7 40%, transparent);
      --gh-closed-fg: #f85149;
      --gh-closed-bg: color-mix(in srgb, #f85149 14%, transparent);
      --gh-closed-border: color-mix(in srgb, #f85149 40%, transparent);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 10px 10px 14px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: color-mix(in srgb, var(--vscode-sideBar-background) 92%, var(--vscode-sideBarTitle-foreground) 8%);
      min-height: 100%;
    }
    .hero {
      padding: 4px 2px 10px;
      margin-bottom: 12px;
      border-bottom: 1px solid color-mix(in srgb, var(--vscode-widget-border) 60%, transparent);
    }
    .hero-inner { }
    .hero-title {
      font-weight: 600;
      letter-spacing: 0.01em;
      font-size: calc(var(--vscode-font-size) + 4px);
      line-height: 1.2;
      color: var(--vscode-foreground);
      margin: 0 0 4px;
    }
    .hero-sub {
      margin-top: 6px;
      opacity: 0.92;
      font-size: calc(var(--vscode-font-size) - 1px);
      line-height: 1.35;
      word-break: break-word;
    }
    .watch-panel {
      display: block;
      margin-bottom: 12px;
      padding: 10px 12px;
      border-radius: var(--hf-radius-sm);
      border: 1px solid color-mix(in srgb, var(--vscode-testing-iconPassed) 38%, var(--vscode-widget-border));
      background: color-mix(in srgb, var(--vscode-testing-iconPassed) 10%, var(--vscode-sideBar-background));
    }
    .watch-panel[hidden] {
      display: none !important;
    }
    .watch-panel-title {
      font-weight: 800;
      font-size: calc(var(--vscode-font-size) - 0px);
      letter-spacing: 0.03em;
      text-transform: uppercase;
      color: var(--vscode-testing-iconPassed);
      margin-bottom: 6px;
    }
    .watch-headline {
      font-size: calc(var(--vscode-font-size) - 1px);
      font-weight: 600;
      color: var(--vscode-foreground);
      margin-bottom: 4px;
      line-height: 1.35;
    }
    .watch-hotfix {
      font-size: calc(var(--vscode-font-size) - 2px);
      color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
      margin-bottom: 10px;
      line-height: 1.4;
      word-break: break-word;
    }
    .watch-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .watch-line {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 6px 8px;
      border-radius: 6px;
      border: 1px solid color-mix(in srgb, var(--vscode-widget-border) 65%, transparent);
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 85%, transparent);
    }
    .watch-num {
      flex: 0 0 auto;
      font-weight: 800;
      font-variant-numeric: tabular-nums;
      color: var(--vscode-descriptionForeground);
      font-size: calc(var(--vscode-font-size) - 1px);
    }
    .watch-title {
      flex: 1;
      min-width: 0;
      font-size: calc(var(--vscode-font-size) - 1px);
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--vscode-foreground);
    }
    .pill-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 999px;
      font-size: calc(var(--vscode-font-size) - 2px);
      font-weight: 600;
      border: 1px solid color-mix(in srgb, var(--vscode-contrastBorder) 35%, transparent);
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 75%, transparent);
      backdrop-filter: blur(var(--hf-blur));
    }
    .pill.live {
      animation: hf-pulse 1.6s ease-in-out infinite;
      border-color: color-mix(in srgb, var(--vscode-testing-iconPassed) 55%, transparent);
      color: var(--vscode-testing-iconPassed);
    }
    .pill.err { color: var(--vscode-errorForeground); border-color: color-mix(in srgb, var(--vscode-errorForeground) 45%, transparent); }
    @keyframes hf-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.82; transform: scale(0.985); }
    }
    .list { display: flex; flex-direction: column; gap: 8px; }
    .card {
      display: flex;
      align-items: stretch;
      gap: 10px;
      padding: 8px 10px;
      border-radius: var(--hf-radius-sm);
      border: 1px solid color-mix(in srgb, var(--vscode-widget-border) 70%, transparent);
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 88%, var(--vscode-sideBar-background));
      box-shadow: 0 2px 10px color-mix(in srgb, var(--vscode-widget-shadow) 25%, transparent);
      transition: border-color 0.15s ease, transform 0.12s ease;
    }
    .card:hover {
      border-color: color-mix(in srgb, var(--vscode-focusBorder) 55%, var(--vscode-widget-border));
      transform: translateY(-1px);
    }
    .pick {
      display: flex;
      align-items: flex-start;
      padding-top: 2px;
    }
    .pick input { transform: scale(1.08); cursor: pointer; accent-color: var(--vscode-button-background); }
    .main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
    .topline {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex-wrap: wrap;
    }
    .num {
      flex: 0 0 auto;
      font-variant-numeric: tabular-nums;
      font-weight: 700;
      color: var(--vscode-descriptionForeground);
      font-size: calc(var(--vscode-font-size) - 1px);
    }
    .titleline { min-width: 0; width: 100%; }
    .title {
      display: block;
      width: 100%;
      min-width: 0;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      cursor: pointer;
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    .title:hover { text-decoration: underline; }
    .badge {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: calc(var(--vscode-font-size) - 3px);
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .badge .ico { font-size: 1.05em; line-height: 1; }
    .badge.merged {
      color: var(--gh-merged-fg);
      background: var(--gh-merged-bg);
      border: 1px solid var(--gh-merged-border);
    }
    .badge.open {
      color: var(--gh-open-fg);
      background: var(--gh-open-bg);
      border: 1px solid var(--gh-open-border);
    }
    .badge.closed {
      color: var(--gh-closed-fg);
      background: var(--gh-closed-bg);
      border: 1px solid var(--gh-closed-border);
    }
    .open-hint {
      margin-top: 10px;
      padding: 14px;
      border-radius: var(--hf-radius-sm);
      border: 1px dashed color-mix(in srgb, var(--vscode-widget-border) 80%, transparent);
      color: var(--vscode-descriptionForeground);
      text-align: center;
      line-height: 1.45;
    }
    .search-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }
    .search-input {
      flex: 1;
      min-width: 0;
      padding: 7px 10px;
      border-radius: var(--hf-radius-sm);
      border: 1px solid color-mix(in srgb, var(--vscode-widget-border) 75%, transparent);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font: inherit;
      outline: none;
    }
    .search-input:focus {
      border-color: var(--vscode-focusBorder);
    }
    .search-input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    .search-status {
      flex: 0 0 auto;
      max-width: 42%;
      font-size: calc(var(--vscode-font-size) - 2px);
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .search-status.err { color: var(--vscode-errorForeground); }
    .search-row.is-disabled {
      opacity: 0.55;
      pointer-events: none;
    }
    .list-loader {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 140px;
      gap: 14px;
      padding: 24px 12px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
    }
    .list-loader-spinner {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      border: 2px solid color-mix(in srgb, var(--vscode-foreground) 18%, transparent);
      border-top-color: var(--vscode-button-background);
      animation: hf-spin 0.75s linear infinite;
    }
    .list-loader-label {
      font-size: calc(var(--vscode-font-size) - 1px);
      max-width: 260px;
      line-height: 1.4;
    }
    @keyframes hf-spin {
      to {
        transform: rotate(360deg);
      }
    }
    .cli-panel {
      margin-bottom: 12px;
      padding: 8px 10px;
      border-radius: var(--hf-radius-sm);
      border: 1px solid color-mix(in srgb, var(--vscode-widget-border) 72%, transparent);
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 70%, var(--vscode-sideBar-background));
      text-align: center;
    }
    .panel-caption {
      font-size: calc(var(--vscode-font-size) - 3px);
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      opacity: 0.85;
      margin-bottom: 4px;
    }
    .cli-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: center;
      column-gap: 0;
      row-gap: 6px;
      font-size: calc(var(--vscode-font-size) - 1px);
      color: var(--vscode-descriptionForeground);
    }
    .cli-sep {
      padding: 0 10px;
      user-select: none;
      opacity: 0.55;
      font-weight: 300;
    }
    /* Hide separator when it wraps to start of a new line (prevents orphan "|"). */
    .cli-row > .cli-sep:first-child,
    .cli-row > .cli-sep:last-child {
      display: none;
    }
    .cli-select {
      min-width: 108px;
      padding: 4px 8px;
      border-radius: 6px;
      border: 1px solid color-mix(in srgb, var(--vscode-widget-border) 80%, transparent);
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      font: inherit;
    }
    .cli-check {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }
    .cli-check input {
      cursor: pointer;
      accent-color: var(--vscode-button-background);
    }
    .filter-row {
      flex-wrap: wrap;
      justify-content: center;
      gap: 0;
    }
  </style>
</head>
<body data-gh-scheme="${initialGithubScheme}">
  <div class="hero">
    <div class="hero-inner">
      <div class="hero-title">Hotfix PRs</div>
      <div class="hero-sub" id="meta"></div>
      <div class="pill-row" id="pills"></div>
    </div>
  </div>
  <div class="watch-panel" id="watchPanel" hidden aria-live="polite">
    <div class="watch-panel-title">Live watch</div>
    <div class="watch-headline" id="watchHeadline"></div>
    <div class="watch-hotfix" id="watchHotfix"></div>
    <div class="watch-list" id="watchList"></div>
  </div>
  <div class="search-row" id="searchRow">
    <input
      type="search"
      class="search-input"
      id="search"
      placeholder="Search PRs by title or #number…"
      spellcheck="false"
      autocomplete="off"
    />
    <span class="search-status" id="searchStatus" aria-live="polite"></span>
  </div>
  <div class="cli-panel" id="cliPanel">
    <div class="panel-caption">Hotfix CLI flags</div>
    <div class="cli-row">
      <select id="hotfixEnvSel" class="cli-select" aria-label="Environment: pre, prod, or both" title="fcli --env target. Choose 'pre and prod' to run both in sequence (pre first; prod gated on pre success).">
        <option value="pre">pre</option>
        <option value="prod">prod</option>
        <option value="both">pre and prod</option>
      </select>
      <span class="cli-sep" aria-hidden="true">|</span>
      <label class="cli-check" title="Open the hotfix PR as draft (passes --draft to fcli).">
        <input type="checkbox" id="hotfixDraftCb" aria-label="draft" />
        draft
      </label>
      <span class="cli-sep" aria-hidden="true">|</span>
      <label class="cli-check" title="Skip E2E in CI for the hotfix (passes --critical-fast-track to fcli).">
        <input type="checkbox" id="hotfixFtCb" aria-label="critical fast track" />
        critical fast track
      </label>
      <span class="cli-sep" aria-hidden="true">|</span>
      <label class="cli-check" title="After the created hotfix PR is merged, dispatch the matching workflow(s) in arnac-io/workflows.">
        <input type="checkbox" id="hotfixDeployCb" aria-label="deploy" />
        deploy
      </label>
    </div>
  </div>
  <div class="cli-panel" id="filterPanel">
    <div class="panel-caption">Show</div>
    <div class="cli-row filter-row">
      <select id="prStatusFilterSel" class="cli-select" aria-label="Filter by PR status">
        <option value="all">All</option>
        <option value="open">Open</option>
        <option value="merged">Merged</option>
      </select>
      <span class="cli-sep" aria-hidden="true">|</span>
      <select
        id="prSortSel"
        class="cli-select"
        aria-label="Sort: open first, or by creation time"
        title="Open first: open PRs then merged. Newest: by PR created date."
      >
        <option value="status">Open first</option>
        <option value="created">Newest</option>
      </select>
    </div>
  </div>
  <div class="list" id="list"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    function esc(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function badge(row) {
      const merged = Boolean(row.mergedAt);
      if (merged) {
        return '<span class="badge merged"><span class="ico">✓</span>Merged</span>';
      }
      if (row.state === "open") {
        return '<span class="badge open"><span class="ico">●</span>Open</span>';
      }
      return '<span class="badge closed"><span class="ico">○</span>Closed</span>';
    }

    function watchEntryBadge(e) {
      if (e.merged) {
        return '<span class="badge merged"><span class="ico">✓</span>Merged</span>';
      }
      if (e.state === "open") {
        return '<span class="badge open"><span class="ico">●</span>Open</span>';
      }
      return '<span class="badge closed"><span class="ico">○</span>Closed</span>';
    }

    const searchEl = document.getElementById("search");
    const searchStatus = document.getElementById("searchStatus");
    if (searchEl) {
      searchEl.addEventListener("input", () => {
        vscode.postMessage({ command: "searchQuery", query: searchEl.value });
      });
    }

    const envSel = document.getElementById("hotfixEnvSel");
    const draftCb = document.getElementById("hotfixDraftCb");
    const ftCb = document.getElementById("hotfixFtCb");
    const deployCb = document.getElementById("hotfixDeployCb");
    function postHotfixCli() {
      if (!envSel || !draftCb || !ftCb || !deployCb) return;
      vscode.postMessage({
        command: "hotfixCli",
        env: envSel.value,
        draft: draftCb.checked,
        criticalFastTrack: ftCb.checked,
        deploy: deployCb.checked,
      });
    }
    if (envSel) envSel.addEventListener("change", postHotfixCli);
    if (draftCb) draftCb.addEventListener("change", postHotfixCli);
    if (ftCb) ftCb.addEventListener("change", postHotfixCli);
    if (deployCb) deployCb.addEventListener("change", postHotfixCli);

    const statusSel = document.getElementById("prStatusFilterSel");
    const sortSel = document.getElementById("prSortSel");
    function postPrListView() {
      if (!statusSel || !sortSel) return;
      vscode.postMessage({
        command: "prListView",
        statusFilter: statusSel.value,
        sortMode: sortSel.value,
      });
    }
    if (statusSel) statusSel.addEventListener("change", postPrListView);
    if (sortSel) sortSel.addEventListener("change", postPrListView);

    function render(state) {
      const meta = document.getElementById("meta");
      const pills = document.getElementById("pills");
      const list = document.getElementById("list");
      if (searchEl && document.activeElement !== searchEl && state.searchQuery !== undefined) {
        if (searchEl.value !== state.searchQuery) {
          searchEl.value = state.searchQuery;
        }
      }
      if (searchStatus) {
        searchStatus.classList.remove("err");
        let st = "";
        if (state.searchRemoteLoading) {
          st = "Searching GitHub…";
        } else if (state.searchRemoteError) {
          st = state.searchRemoteError;
          searchStatus.classList.add("err");
        }
        searchStatus.textContent = st;
      }
      if (state.hotfixCli && envSel && draftCb && ftCb && deployCb) {
        if (envSel.value !== state.hotfixCli.env) {
          envSel.value = state.hotfixCli.env;
        }
        if (draftCb.checked !== state.hotfixCli.draft) {
          draftCb.checked = state.hotfixCli.draft;
        }
        if (ftCb.checked !== state.hotfixCli.criticalFastTrack) {
          ftCb.checked = state.hotfixCli.criticalFastTrack;
        }
        if (deployCb.checked !== Boolean(state.hotfixCli.deploy)) {
          deployCb.checked = Boolean(state.hotfixCli.deploy);
        }
      }
      if (state.prListView && statusSel && sortSel) {
        if (statusSel.value !== state.prListView.statusFilter) {
          statusSel.value = state.prListView.statusFilter;
        }
        if (sortSel.value !== state.prListView.sortMode) {
          sortSel.value = state.prListView.sortMode;
        }
      }

      const watchPanel = document.getElementById("watchPanel");
      const watchHeadline = document.getElementById("watchHeadline");
      const watchHotfix = document.getElementById("watchHotfix");
      const watchList = document.getElementById("watchList");
      if (watchPanel && watchHeadline && watchHotfix && watchList) {
        const wp = state.watchPanel;
        if (wp && state.watching) {
          watchPanel.hidden = false;
          watchHeadline.textContent = wp.statusLine || "";
          watchHotfix.textContent = wp.hotfixSummary || "";
          watchList.innerHTML = wp.entries
            .map(
              (e) =>
                '<div class="watch-line">' +
                watchEntryBadge(e) +
                '<span class="watch-num">#' +
                e.number +
                "</span>" +
                '<span class="watch-title" title="' +
                esc(e.title) +
                '">' +
                esc(e.title) +
                "</span>" +
                "</div>",
            )
            .join("");
        } else {
          watchPanel.hidden = true;
          watchHeadline.textContent = "";
          watchHotfix.textContent = "";
          watchList.innerHTML = "";
        }
      }

      const parts = [];
      if (state.login) parts.push("Signed in as <strong>@" + esc(state.login) + "</strong>");
      if (!state.login && !state.loadError && !state.listLoading) {
        parts.push('Sign in: run <code>gh auth login</code>, or use <strong>"Hotfix: Set GitHub token"</strong>.');
      }
      meta.innerHTML = parts.join(" · ") || "Pick PRs below, then Start watching.";

      const pillHtml = [];
      if (state.deployRunning) {
        pillHtml.push(
          '<span class="pill live" title="Workflow has been dispatched on GitHub — Stop is disabled to avoid orphaning the run.">🚀 Deploy running · Stop disabled</span>'
        );
      } else if (state.watching) {
        pillHtml.push('<span class="pill live">👀 Live watch</span>');
      }
      if (state.loadError) {
        pillHtml.push('<span class="pill err">⚠ ' + esc(state.loadError) + "</span>");
      }
      pills.innerHTML = pillHtml.join("") || '<span class="pill">Pick PRs → Start watching</span>';

      const searchRow = document.getElementById("searchRow");
      if (searchRow) {
        searchRow.classList.toggle("is-disabled", Boolean(state.listLoading));
      }

      const sel = new Set(state.selected);
      const src = typeof state.sourceRowCount === "number" ? state.sourceRowCount : 0;

      if (state.listLoading) {
        list.innerHTML =
          '<div class="list-loader" role="status" aria-busy="true">' +
          '<div class="list-loader-spinner"></div>' +
          '<div class="list-loader-label">Loading pull requests…</div>' +
          "</div>";
        return;
      }

      if (src === 0) {
        list.innerHTML =
          '<div class="open-hint">No PRs yet.<br/>Sign in with <code>gh auth login</code>, check <strong>Hotfix › Owner</strong> / <strong>Repo</strong> in settings, then hit <strong>Refresh</strong>.</div>';
        return;
      }
      if (!state.rows.length) {
        const q = (state.searchQuery || "").trim();
        const pv = state.prListView;
        const statusOnly = pv && pv.statusFilter !== "all";
        if (q) {
          list.innerHTML =
            '<div class="open-hint">No PRs match <strong>' +
            esc(q) +
            "</strong>. Try different keywords — checked PRs stay visible when they match your list.</div>";
        } else if (statusOnly) {
          list.innerHTML =
            '<div class="open-hint">No PRs match this <strong>status</strong> filter. Try <strong>All</strong> or pick another option.</div>';
        } else {
          list.innerHTML =
            '<div class="open-hint">Nothing to show. Adjust search or filters — checked PRs stay listed when they are in your refresh set.</div>';
        }
        return;
      }
      list.innerHTML = state.rows
        .map((row) => {
          const checked = sel.has(row.number) ? "checked" : "";
          return (
            '<div class="card" data-num="' +
            row.number +
            '">' +
            '<label class="pick"><input type="checkbox" data-role="cb" data-num="' +
            row.number +
            '" ' +
            checked +
            " /></label>" +
            '<div class="main">' +
            '<div class="topline">' +
            badge(row) +
            '<span class="num">#' +
            row.number +
            "</span>" +
            "</div>" +
            '<div class="titleline"><a class="title" href="#" data-url="' +
            esc(row.htmlUrl) +
            '" title="' +
            esc(row.title) +
            '">' +
            esc(row.title) +
            "</a></div>" +
            "</div>" +
            "</div>"
          );
        })
        .join("");

      list.querySelectorAll('input[data-role="cb"]').forEach((el) => {
        el.addEventListener("change", (ev) => {
          const t = ev.target;
          const n = Number(t.getAttribute("data-num"));
          vscode.postMessage({ command: "toggle", number: n });
        });
      });
      list.querySelectorAll("a.title").forEach((a) => {
        a.addEventListener("click", (ev) => {
          ev.preventDefault();
          const url = a.getAttribute("data-url");
          if (url) vscode.postMessage({ command: "open", url });
        });
      });
    }

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg && msg.type === "state" && msg.state) {
        if (msg.githubScheme === "light" || msg.githubScheme === "dark") {
          document.body.setAttribute("data-gh-scheme", msg.githubScheme);
        }
        render(msg.state);
      }
    });
    vscode.postMessage({ command: "ready" });
  </script>
</body>
</html>`;
}
