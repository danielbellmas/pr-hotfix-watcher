import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as vscode from "vscode";
import type { PrListController } from "./prListController";
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
  | { command: "deployEnv"; env?: string }
  | { command: "prListView"; statusFilter?: string; sortMode?: string };

export type GithubPrColorScheme = "light" | "dark";

export function activeGithubColorScheme(): GithubPrColorScheme {
  const k = vscode.window.activeColorTheme.kind;
  if (k === vscode.ColorThemeKind.Light || k === vscode.ColorThemeKind.HighContrastLight) {
    return "light";
  }
  return "dark";
}

export class HotfixPrWebviewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "fordefiHotfix.prList";

  private view: vscode.WebviewView | undefined;
  private treeListenerSub: vscode.Disposable | undefined;
  private htmlTemplateCache: string | undefined;

  constructor(
    private readonly prs: PrListController,
    private readonly extensionUri: vscode.Uri
  ) {
    this.treeListenerSub = this.prs.onDidChangeTreeData(() => this.pushState());
  }

  dispose(): void {
    this.treeListenerSub?.dispose();
    this.treeListenerSub = undefined;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, "media");
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview, activeGithubColorScheme());
    const subscriptions: vscode.Disposable[] = [];
    subscriptions.push(
      webviewView.webview.onDidReceiveMessage((msg: FromWebview) => {
        this.handleMessage(msg);
      })
    );
    const fetchPrsIfVisible = (): void => {
      if (webviewView.visible) {
        if (this.prs.hasCompletedInitialListFetch()) {
          void this.prs.refresh({ showListLoading: false, resetSearch: false });
        } else {
          void this.prs.refresh();
        }
      }
    };
    subscriptions.push(webviewView.onDidChangeVisibility(fetchPrsIfVisible));
    webviewView.onDidDispose(() => {
      for (const s of subscriptions) {
        s.dispose();
      }
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });
    fetchPrsIfVisible();
  }

  notifyThemeChanged(): void {
    this.pushState();
  }

  private handleMessage(msg: FromWebview): void {
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
    if (msg.command === "deployEnv") {
      if (msg.env === "pre" || msg.env === "prod") {
        void this.prs.deployEnv(msg.env);
      }
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

  private renderHtml(webview: vscode.Webview, initialGithubScheme: GithubPrColorScheme): string {
    const nonce = generateNonce();
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "webview.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "webview.js")
    );
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
    ].join("; ");
    const template = this.loadHtmlTemplate();
    return template
      .replaceAll("{{CSP}}", csp)
      .replaceAll("{{STYLE_URI}}", styleUri.toString())
      .replaceAll("{{SCRIPT_URI}}", scriptUri.toString())
      .replaceAll("{{NONCE}}", nonce)
      .replaceAll("{{GH_SCHEME}}", initialGithubScheme);
  }

  private loadHtmlTemplate(): string {
    if (this.htmlTemplateCache !== undefined) {
      return this.htmlTemplateCache;
    }
    const path = vscode.Uri.joinPath(this.extensionUri, "media", "webview.html").fsPath;
    this.htmlTemplateCache = fs.readFileSync(path, "utf8");
    return this.htmlTemplateCache;
  }
}

/** Crypto-strong base64-url nonce, 22 chars (128 bits). */
function generateNonce(): string {
  return crypto.randomBytes(16).toString("base64url");
}
