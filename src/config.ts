import * as cp from "node:child_process";
import * as vscode from "vscode";
import { buildHotfixCliSuffix, type HotfixCliOptions } from "./hotfixCli";
import { expandHotfixCommandTemplate } from "./hotfixCommandTemplate";
import { parseHotfixRunMode, type HotfixRunMode } from "./hotfixRunHelpers";

const SECRET_KEY = "fordefiHotfix.githubPat";

/**
 * Cache a successful/failed `gh auth token` lookup for a short window so the
 * watch-poll loop doesn't block the extension host with an 8-second sync spawn
 * on every tick. Invalidated explicitly on token-affecting user actions (see
 * {@link invalidateGhTokenCache}) and on any 401 response from the GitHub API
 * (wired in {@link ./extension.ts}).
 */
const GH_TOKEN_TTL_MS = 30_000;
type GhTokenCacheEntry = {
  executable: string;
  value: string | undefined;
  at: number;
};
let ghTokenCache: GhTokenCacheEntry | undefined;

export function invalidateGhTokenCache(): void {
  ghTokenCache = undefined;
}

/**
 * Same idea as Fordefi CLI: use the token from `gh auth login` when available.
 * VS Code’s environment often lacks a login shell, so `gh` must be on `PATH`.
 */
export function tokenFromGhCli(executable: string = "gh"): string | undefined {
  const now = Date.now();
  if (
    ghTokenCache &&
    ghTokenCache.executable === executable &&
    now - ghTokenCache.at < GH_TOKEN_TTL_MS
  ) {
    return ghTokenCache.value;
  }
  try {
    const out = cp.execFileSync(executable, ["auth", "token"], {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const t = out.trim() || undefined;
    ghTokenCache = { executable, value: t, at: now };
    return t;
  } catch {
    ghTokenCache = { executable, value: undefined, at: now };
    return undefined;
  }
}

export async function resolveGitHubToken(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  const ghExecutable =
    vscode.workspace
      .getConfiguration("fordefiHotfix")
      .get<string>("ghPath", "")
      ?.trim() || "gh";
  const fromGh = tokenFromGhCli(ghExecutable);
  if (fromGh) {
    return fromGh;
  }
  const fromSecret = await context.secrets.get(SECRET_KEY);
  if (fromSecret?.trim()) {
    return fromSecret.trim();
  }
  const cfgPat = vscode.workspace
    .getConfiguration("fordefiHotfix")
    .get<string>("githubPat");
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
  token: string
): Promise<void> {
  await context.secrets.store(SECRET_KEY, token.trim());
  invalidateGhTokenCache();
}

export async function clearStoredGithubToken(
  context: vscode.ExtensionContext
): Promise<void> {
  await context.secrets.delete(SECRET_KEY);
  invalidateGhTokenCache();
}

export function getRepoConfig(): { owner: string; repo: string } {
  const c = vscode.workspace.getConfiguration("fordefiHotfix");
  return {
    owner: c.get<string>("owner", "arnac-io").trim(),
    repo: c.get<string>("repo", "arnac").trim(),
  };
}

export function getRecentPrCount(): number {
  return vscode.workspace
    .getConfiguration("fordefiHotfix")
    .get<number>("recentPrCount", 20);
}

export function getPollIntervalMs(): number {
  const sec = vscode.workspace
    .getConfiguration("fordefiHotfix")
    .get<number>("pollIntervalSeconds", 60);
  return Math.max(5, sec) * 1000;
}

export function getRepoRoot(): string {
  const configured = vscode.workspace
    .getConfiguration("fordefiHotfix")
    .get<string>("repoRoot", "")
    ?.trim();
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
      "cd {repoRoot} && ./fcli workflows hotfix create-pull-request {prNumbers} {hotfixSuffix}"
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
    criticalFastTrack: Boolean(
      c.get<boolean>("hotfixCriticalFastTrack", false)
    ),
    deploy: Boolean(c.get<boolean>("hotfixDeploy", false)),
  };
}

export type WorkflowsRepoConfig = {
  owner: string;
  repo: string;
  preWorkflow: string;
  prodWorkflow: string;
  ref: string;
};

export function getWorkflowsRepoConfig(): WorkflowsRepoConfig {
  const c = vscode.workspace.getConfiguration("fordefiHotfix");
  return {
    owner: c.get<string>("workflowsOwner", "arnac-io").trim() || "arnac-io",
    repo: c.get<string>("workflowsRepo", "workflows").trim() || "workflows",
    preWorkflow:
      c.get<string>("preHotfixWorkflow", "pre-hotfix.yml").trim() ||
      "pre-hotfix.yml",
    prodWorkflow:
      c.get<string>("productionHotfixWorkflow", "production-hotfix.yml").trim() ||
      "production-hotfix.yml",
    ref: c.get<string>("workflowRef", "main").trim() || "main",
  };
}

/** Seconds between hotfix-PR merge checks during the deploy phase. Falls back to the main poll interval. */
export function getHotfixPrPollIntervalMs(): number {
  return getPollIntervalMs();
}

export function buildHotfixCommand(
  prNumbers: number[],
  hotfixCli: HotfixCliOptions,
  repoRootOverride?: string
): string {
  const { owner, repo } = getRepoConfig();
  const repoRoot = repoRootOverride ?? getRepoRoot();
  const template = getCommandTemplate();
  const hotfixSuffix = buildHotfixCliSuffix(hotfixCli);
  return expandHotfixCommandTemplate(template, {
    repoRoot,
    owner,
    repo,
    prNumbers,
    hotfixSuffix,
  });
}

/** Integrated terminal only: best-effort first prompt (no fcli `--yes` required). */
export function getHotfixTerminalAutoFirstConfirm(): boolean {
  return Boolean(
    vscode.workspace
      .getConfiguration("fordefiHotfix")
      .get<boolean>("hotfixTerminalAutoFirstConfirm", true)
  );
}

export function getHotfixTerminalAutoFirstConfirmText(): string {
  const raw =
    vscode.workspace
      .getConfiguration("fordefiHotfix")
      .get<string>("hotfixTerminalAutoFirstConfirmText", "y") ?? "y";
  const t = raw.trim();
  return t.length > 0 ? t : "y";
}

export function getHotfixTerminalAutoFirstConfirmDelayMs(): number {
  const n = vscode.workspace
    .getConfiguration("fordefiHotfix")
    .get<number>("hotfixTerminalAutoFirstConfirmDelayMs", 600);
  const v = typeof n === "number" && Number.isFinite(n) ? n : 600;
  return Math.min(30_000, Math.max(100, Math.round(v)));
}

export type { HotfixRunMode };

export function getHotfixRunMode(): HotfixRunMode {
  const raw = vscode.workspace
    .getConfiguration("fordefiHotfix")
    .get<string>("hotfixRunMode", "integratedTerminal");
  return parseHotfixRunMode(raw);
}

export function getHotfixTerminalName(): string {
  const name = vscode.workspace
    .getConfiguration("fordefiHotfix")
    .get<string>("hotfixTerminalName", "Hotfix CLI")
    ?.trim();
  return name || "Hotfix CLI";
}
