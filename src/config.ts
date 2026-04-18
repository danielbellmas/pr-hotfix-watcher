import * as cp from "node:child_process";
import * as vscode from "vscode";
import { buildHotfixCliSuffix, type HotfixCliOptions } from "./hotfixCli";
import { expandHotfixCommandTemplate } from "./hotfixCommandTemplate";
import { parseHotfixRunMode, type HotfixRunMode } from "./hotfixRunHelpers";

const SECRET_KEY = "fordefiHotfix.githubPat";

/**
 * Same idea as Fordefi CLI: use the token from `gh auth login` when available.
 * VS Code’s environment often lacks a login shell, so `gh` must be on `PATH`.
 */
export function tokenFromGhCli(executable: string = "gh"): string | undefined {
  try {
    const out = cp.execFileSync(executable, ["auth", "token"], {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const t = out.trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

export async function resolveGitHubToken(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  const ghExecutable =
    vscode.workspace.getConfiguration("fordefiHotfix").get<string>("ghPath", "")?.trim() || "gh";
  const fromGh = tokenFromGhCli(ghExecutable);
  if (fromGh) {
    return fromGh;
  }
  const fromSecret = await context.secrets.get(SECRET_KEY);
  if (fromSecret?.trim()) {
    return fromSecret.trim();
  }
  const cfgPat = vscode.workspace.getConfiguration("fordefiHotfix").get<string>("githubPat");
  if (cfgPat?.trim()) {
    return cfgPat.trim();
  }
  const fromEnv = process.env.GITHUB_ACCESS_TOKEN?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return undefined;
}

export async function storeGitHubToken(
  context: vscode.ExtensionContext,
  token: string,
): Promise<void> {
  await context.secrets.store(SECRET_KEY, token.trim());
}

export async function clearStoredGithubToken(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SECRET_KEY);
}

export function getRepoConfig(): { owner: string; repo: string } {
  const c = vscode.workspace.getConfiguration("fordefiHotfix");
  return {
    owner: c.get<string>("owner", "arnac-io").trim(),
    repo: c.get<string>("repo", "arnac").trim(),
  };
}

export function getRecentPrCount(): number {
  return vscode.workspace.getConfiguration("fordefiHotfix").get<number>("recentPrCount", 20);
}

export function getPollIntervalMs(): number {
  const sec = vscode.workspace.getConfiguration("fordefiHotfix").get<number>("pollIntervalSeconds", 60);
  return Math.max(5, sec) * 1000;
}

export function getRepoRoot(): string {
  const configured = vscode.workspace.getConfiguration("fordefiHotfix").get<string>("repoRoot", "")?.trim();
  if (configured) {
    return configured;
  }
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return folder ?? "";
}

export function getCommandTemplate(): string {
  return vscode.workspace
    .getConfiguration("fordefiHotfix")
    .get<string>(
      "commandTemplate",
      "cd {repoRoot} && ./fcli workflows hotfix create-pull-request {prNumbers} {hotfixSuffix}",
    )
    .trim();
}

export function getHotfixCliOptionsFromConfig(): HotfixCliOptions {
  const c = vscode.workspace.getConfiguration("fordefiHotfix");
  const envRaw = c.get<string>("hotfixEnv", "pre");
  const env = envRaw === "prod" ? "prod" : envRaw === "both" ? "both" : "pre";
  return {
    env,
    draft: Boolean(c.get<boolean>("hotfixDraft", false)),
    criticalFastTrack: Boolean(c.get<boolean>("hotfixCriticalFastTrack", false)),
  };
}

export function buildHotfixCommand(prNumbers: number[], hotfixCli: HotfixCliOptions): string {
  const { owner, repo } = getRepoConfig();
  const repoRoot = getRepoRoot();
  const template = getCommandTemplate();
  const hotfixSuffix = buildHotfixCliSuffix(hotfixCli);
  return expandHotfixCommandTemplate(template, { repoRoot, owner, repo, prNumbers, hotfixSuffix });
}

export type { HotfixRunMode };

export function getHotfixRunMode(): HotfixRunMode {
  const raw = vscode.workspace.getConfiguration("fordefiHotfix").get<string>("hotfixRunMode", "integratedTerminal");
  return parseHotfixRunMode(raw);
}

export function getHotfixTerminalName(): string {
  const name = vscode.workspace.getConfiguration("fordefiHotfix").get<string>("hotfixTerminalName", "Hotfix CLI")?.trim();
  return name || "Hotfix CLI";
}
