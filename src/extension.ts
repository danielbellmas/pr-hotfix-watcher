import * as vscode from "vscode";
import { clearStoredGithubToken, getRepoRoot, storeGitHubToken } from "./config";
import { parseGitHubRepoFromRemote, readOriginRemote } from "./gitRemote";
import { registerHotfixCliOutputChannel } from "./hotfixRun";
import { HotfixPrWebviewProvider } from "./hotfixPrWebview";
import { PrTreeProvider } from "./prTreeProvider";

export function activate(context: vscode.ExtensionContext): void {
  registerHotfixCliOutputChannel(context);
  const provider = new PrTreeProvider(context);
  const webviewProvider = new HotfixPrWebviewProvider(provider);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => webviewProvider.notifyThemeChanged()),
    vscode.window.registerWebviewViewProvider(HotfixPrWebviewProvider.viewType, webviewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    { dispose: () => provider.stopWatch() },
    vscode.commands.registerCommand("fordefiHotfix.setToken", async () => {
      const token = await vscode.window.showInputBox({
        title: "GitHub personal access token (override)",
        prompt:
          "Normally the extension uses `gh auth token` (GitHub CLI). Use this only to override — stored in Secret Storage (repo scope for private repos).",
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
        "Stored GitHub token removed. Extension will use `gh auth token` when available.",
      );
      await provider.refresh();
    }),
    vscode.commands.registerCommand("fordefiHotfix.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("fordefiHotfix.startWatch", () => provider.startWatch()),
    vscode.commands.registerCommand("fordefiHotfix.stopWatch", () => provider.stopWatch()),
    vscode.commands.registerCommand("fordefiHotfix.syncRepoFromGit", async () => {
      const root = getRepoRoot();
      if (!root) {
        void vscode.window.showErrorMessage("Open a workspace folder or set fordefiHotfix.repoRoot.");
        return;
      }
      const remote = readOriginRemote(root);
      if (!remote) {
        void vscode.window.showErrorMessage(`Could not read git remote origin under ${root}`);
        return;
      }
      const parsed = parseGitHubRepoFromRemote(remote);
      if (!parsed) {
        void vscode.window.showErrorMessage(`Unrecognized remote URL: ${remote}`);
        return;
      }
      const cfg = vscode.workspace.getConfiguration("fordefiHotfix");
      await cfg.update("owner", parsed.owner, vscode.ConfigurationTarget.Workspace);
      await cfg.update("repo", parsed.repo, vscode.ConfigurationTarget.Workspace);
      void vscode.window.showInformationMessage(`Set repo to ${parsed.owner}/${parsed.repo}`);
      await provider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("fordefiHotfix")) {
        void provider.refresh();
      }
    }),
  );
}

export function deactivate(): void {}
