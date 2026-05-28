import * as vscode from "vscode";
import {
  clearStoredGithubToken,
  getRepoRoot,
  invalidateGhTokenCache,
  isDebugTerminalEnabled,
  setDebugTerminalEnabled,
  storeGitHubToken,
} from "./config";
import { registerHotfixDeployOutputChannel } from "./deployRun";
import { runDoctor } from "./doctorRun";
import { parseGitHubRepoFromRemote, readOriginRemote } from "./gitRemote";
import { setAuthFailureHandler } from "./githubClient";
import { registerHotfixCliOutputChannel } from "./hotfixRun";
import { HotfixPrWebviewProvider } from "./hotfixPrWebview";
import { PrListController } from "./prListController";

/**
 * Settings that, when changed, actually change the PR list. Everything else
 * (terminal name, auto-confirm text, workflow file names, env defaults, etc.)
 * must not blow away the search box or spin the list loader.
 */
const LIST_AFFECTING_KEYS = [
  "fordefiHotfix.owner",
  "fordefiHotfix.repo",
  "fordefiHotfix.recentPrCount",
  "fordefiHotfix.ghPath",
  "fordefiHotfix.githubPat",
];

const TOKEN_AFFECTING_KEYS = ["fordefiHotfix.ghPath", "fordefiHotfix.githubPat"];

const DEBUG_TERMINAL_KEY = "fordefiHotfix.debugTerminal";
const RUN_MODE_MIGRATION_DONE_KEY = "fordefiHotfix.hotfixRunModeMigrationDoneV1";

export function activate(context: vscode.ExtensionContext): void {
  registerHotfixCliOutputChannel(context);
  registerHotfixDeployOutputChannel(context);
  setAuthFailureHandler(() => invalidateGhTokenCache());
  context.subscriptions.push({
    dispose: () => setAuthFailureHandler(undefined),
  });

  // One-shot migration: users who pinned the legacy
  // `fordefiHotfix.hotfixRunMode: "integratedTerminal"` get auto-flipped to
  // the new `debugTerminal: true` so transparent mode doesn't surprise them.
  void migrateLegacyRunMode(context);

  const provider = new PrListController(context);
  const webviewProvider = new HotfixPrWebviewProvider(provider, context.extensionUri);

  const debugStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  debugStatusBar.command = "fordefiHotfix.toggleDebugTerminal";
  debugStatusBar.tooltip =
    "Toggle Hotfix debug terminal mode (transparent ↔ visible terminal). When 'debug' is on, the hotfix command runs in a real integrated terminal so you can watch / intervene.";
  context.subscriptions.push(debugStatusBar);

  const refreshDebugStatusBar = (): void => {
    const enabled = isDebugTerminalEnabled();
    debugStatusBar.text = enabled ? "$(beaker) Hotfix: debug" : "$(eye-closed) Hotfix: transparent";
    debugStatusBar.show();
  };
  refreshDebugStatusBar();

  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => webviewProvider.notifyThemeChanged()),
    vscode.window.registerWebviewViewProvider(HotfixPrWebviewProvider.viewType, webviewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    { dispose: () => webviewProvider.dispose() },
    { dispose: () => provider.stopWatch() },
    vscode.commands.registerCommand("fordefiHotfix.setToken", async () => {
      const token = await vscode.window.showInputBox({
        title: "GitHub personal access token (override)",
        prompt:
          "Prefer `gh auth login` so the extension shares a token with the CLI. Use this only as an override; stored in Secret Storage (repo scope for private repos).",
        password: true,
        ignoreFocusOut: true,
      });
      if (!token?.trim()) {
        return;
      }
      await storeGitHubToken(context, token);
      void vscode.window.showInformationMessage("GitHub token saved.");
      await provider.refresh();
    }),
    vscode.commands.registerCommand("fordefiHotfix.clearStoredToken", async () => {
      await clearStoredGithubToken(context);
      void vscode.window.showInformationMessage(
        "Stored GitHub token removed. The extension will use `gh auth token` when available."
      );
      await provider.refresh();
    }),
    vscode.commands.registerCommand("fordefiHotfix.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("fordefiHotfix.startWatch", () => provider.startWatch()),
    vscode.commands.registerCommand("fordefiHotfix.stopWatch", () => provider.stopWatch()),
    vscode.commands.registerCommand("fordefiHotfix.deployPre", () => provider.deployEnv("pre")),
    vscode.commands.registerCommand("fordefiHotfix.deployProd", () => provider.deployEnv("prod")),
    vscode.commands.registerCommand("fordefiHotfix.doctor", () => runDoctor(context)),
    vscode.commands.registerCommand("fordefiHotfix.toggleDebugTerminal", async () => {
      const next = !isDebugTerminalEnabled();
      await setDebugTerminalEnabled(next);
      refreshDebugStatusBar();
      void vscode.window.showInformationMessage(
        next
          ? "Hotfix debug terminal mode: ON. Next run will use a visible integrated terminal."
          : "Hotfix transparent mode: ON. Next run will be silent — you'll only see notifications for actions and milestones."
      );
    }),
    vscode.commands.registerCommand("fordefiHotfix.openWorktreeTerminal", (cwdArg?: string) => {
      const cwd = typeof cwdArg === "string" && cwdArg.trim() ? cwdArg : getRepoRoot();
      if (!cwd) {
        void vscode.window.showErrorMessage(
          "No worktree path known yet. Start a hotfix run first."
        );
        return;
      }
      const term = vscode.window.createTerminal({
        name: "Hotfix worktree",
        cwd,
      });
      term.show(true);
    }),
    vscode.commands.registerCommand("fordefiHotfix.syncRepoFromGit", async () => {
      const root = getRepoRoot();
      if (!root) {
        void vscode.window.showErrorMessage(
          "Open a workspace folder, or set Hotfix › Repo root in settings."
        );
        return;
      }
      const remote = readOriginRemote(root);
      if (!remote) {
        void vscode.window.showErrorMessage(`Could not read git remote 'origin' under ${root}.`);
        return;
      }
      const parsed = parseGitHubRepoFromRemote(remote);
      if (!parsed) {
        void vscode.window.showErrorMessage(`Unrecognized GitHub remote URL: ${remote}`);
        return;
      }
      const cfg = vscode.workspace.getConfiguration("fordefiHotfix");
      await cfg.update("owner", parsed.owner, vscode.ConfigurationTarget.Workspace);
      await cfg.update("repo", parsed.repo, vscode.ConfigurationTarget.Workspace);
      void vscode.window.showInformationMessage(
        `Hotfix repo set to ${parsed.owner}/${parsed.repo}.`
      );
      await provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (TOKEN_AFFECTING_KEYS.some((k) => e.affectsConfiguration(k))) {
        invalidateGhTokenCache();
      }
      if (LIST_AFFECTING_KEYS.some((k) => e.affectsConfiguration(k))) {
        void provider.refresh();
      }
      if (e.affectsConfiguration(DEBUG_TERMINAL_KEY)) {
        refreshDebugStatusBar();
      }
    })
  );
}

/**
 * One-shot migration: users with the legacy `hotfixRunMode` setting pinned
 * to `"integratedTerminal"` have it equivalently expressed via the new
 * `debugTerminal: true` so they keep their visible-terminal flow on first
 * upgrade. Other values (`"background"`, `"transparent"`, missing) collapse
 * to transparent — which is the new default — and need no action.
 *
 * Gated by a globalState flag so the migration runs at most once per machine.
 */
async function migrateLegacyRunMode(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(RUN_MODE_MIGRATION_DONE_KEY) === true) {
    return;
  }
  const cfg = vscode.workspace.getConfiguration("fordefiHotfix");
  const inspected = cfg.inspect<string>("hotfixRunMode");
  const explicit =
    inspected?.workspaceValue ?? inspected?.workspaceFolderValue ?? inspected?.globalValue;
  if (explicit === "integratedTerminal") {
    try {
      await cfg.update("debugTerminal", true, vscode.ConfigurationTarget.Global);
    } catch {
      // Best-effort; users can flip the toggle by hand if this fails.
    }
  }
  await context.globalState.update(RUN_MODE_MIGRATION_DONE_KEY, true);
}

export function deactivate(): void {}
