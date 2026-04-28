import * as cp from "node:child_process";
import * as vscode from "vscode";
import { buildHotfixCliSuffix, type HotfixCliOptions } from "./hotfixCli";
import { expandHotfixCommandTemplate } from "./hotfixCommandTemplate";
import { parseHotfixRunMode, type HotfixRunMode } from "./hotfixRunHelpers";
import { TokenResolver } from "./tokenResolver";

// Lazy singleton: built on first use, kept across calls so the resolver's
// internal `gh auth token` cache actually amortizes across watch-poll ticks.
let _resolver: TokenResolver | undefined;
function getTokenResolver(context: vscode.ExtensionContext): TokenResolver {
  if (!_resolver) {
    _resolver = new TokenResolver({
      exec: (file, args, timeoutMs) => {
        try {
          return cp.execFileSync(file, args, {
            encoding: "utf8",
            timeout: timeoutMs,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          });
        } catch {
          return undefined;
        }
      },
      secrets: {
        get: (k) => Promise.resolve(context.secrets.get(k)),
        store: (k, v) => Promise.resolve(context.secrets.store(k, v)),
        delete: (k) => Promise.resolve(context.secrets.delete(k)),
      },
      config: {
        ghPath: () =>
          vscode.workspace
            .getConfiguration("fordefiHotfix")
            .get<string>("ghPath", "") ?? "",
        githubPat: () =>
          vscode.workspace
            .getConfiguration("fordefiHotfix")
            .get<string>("githubPat", "") ?? "",
      },
      envToken: () => process.env.GITHUB_ACCESS_TOKEN,
      now: () => Date.now(),
    });
  }
  return _resolver;
}

export function invalidateGhTokenCache(): void {
  _resolver?.invalidate();
}

export function resolveGitHubToken(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  return getTokenResolver(context).resolve();
}

export function storeGitHubToken(
  context: vscode.ExtensionContext,
  token: string
): Promise<void> {
  return getTokenResolver(context).store(token);
}

export function clearStoredGithubToken(
  context: vscode.ExtensionContext
): Promise<void> {
  return getTokenResolver(context).clear();
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

export function getGhPath(): string {
  return (
    vscode.workspace
      .getConfiguration("fordefiHotfix")
      .get<string>("ghPath", "")
      ?.trim() ?? ""
  );
}

/**
 * One-shot shell command run inside the hotfix worktree right after
 * `git worktree add`. Default `./atool prepare-codeenv` regenerates the python
 * codeenv so fcli doesn't crash on stale protobufs (e.g.
 * `BytesEqualsArgumentCondition` missing). Empty disables the step.
 */
export function getWorktreePostCreateCommand(): string {
  return (
    vscode.workspace
      .getConfiguration("fordefiHotfix")
      .get<string>("worktreePostCreateCommand", "./atool prepare-codeenv")
      ?.trim() ?? ""
  );
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
