import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { getGhPath, getRepoConfig, getRepoRoot, getWorktreePostCreateCommand } from "./config";
import { GITHUB_PAT_SECRET_KEY } from "./tokenResolver";
import { computeWorktreePath, HOTFIX_WORKTREE_BRANCH } from "./worktreeManager";

const execFileAsync = promisify(cp.execFile);

/**
 * Diagnostic command run by another developer right after they install the
 * extension on a fresh machine. Prints a single annotated report into the
 * "Fordefi Hotfix Doctor" output channel covering the moving parts that
 * commonly differ between machines: VS Code/OS, `gh` auth, token resolution
 * chain, git + worktree state, ssh key file mode, `osascript` (macOS notify)
 * and `direnv`. Token values are NEVER printed — only their source.
 */
export async function runDoctor(context: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel("Fordefi Hotfix Doctor");
  channel.show(true);
  const log = (line: string) => channel.appendLine(line);
  const checks: { ok: boolean; line: string }[] = [];
  const record = (ok: boolean, line: string) => {
    checks.push({ ok, line });
    log(`${ok ? "[ ok ]" : "[fail]"} ${line}`);
  };
  const info = (line: string) => log(`[info] ${line}`);

  log(`Fordefi Hotfix Doctor — ${new Date().toISOString()}`);
  log(`VS Code: ${vscode.version}`);
  log(`Platform: ${process.platform} ${os.release()} (${os.arch()})`);
  log(`Node: ${process.version}`);
  log("");

  await checkGh(record, info);
  await checkToken(context, record, info);
  await checkGit(record, info);
  await checkOsNotify(record);
  await checkDirenv(record, info);

  log("");
  const failed = checks.filter((c) => !c.ok).length;
  if (failed === 0) {
    log(`Doctor: all ${checks.length} checks passed.`);
    void vscode.window.showInformationMessage(`Hotfix Doctor: all ${checks.length} checks passed.`);
  } else {
    log(`Doctor: ${failed}/${checks.length} checks failed (see output above).`);
    void vscode.window.showWarningMessage(
      `Hotfix Doctor: ${failed} check(s) failed — see "Fordefi Hotfix Doctor" output.`
    );
  }
}

async function execText(
  file: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number }
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  try {
    const { stdout } = await execFileAsync(file, args, {
      cwd: opts?.cwd,
      encoding: "utf8",
      timeout: opts?.timeoutMs ?? 8_000,
      windowsHide: true,
    });
    return { ok: true, stdout: stdout.toString() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

async function checkGh(
  record: (ok: boolean, line: string) => void,
  info: (line: string) => void
): Promise<void> {
  const ghBin = getGhPath().trim() || "gh";
  info(`gh executable: ${ghBin}${ghBin === "gh" ? " (resolved via PATH)" : ""}`);
  const ver = await execText(ghBin, ["--version"]);
  if (!ver.ok) {
    record(
      false,
      `gh not runnable — ${ver.error.trim()}. Install GitHub CLI or set fordefiHotfix.ghPath.`
    );
    return;
  }
  record(true, `gh runnable: ${ver.stdout.split("\n")[0]?.trim()}`);
  const status = await execText(ghBin, ["auth", "status"]);
  if (!status.ok) {
    record(false, `gh auth status failed — run "gh auth login". Detail: ${status.error.trim()}`);
    return;
  }
  record(true, "gh auth status OK");
}

async function checkToken(
  context: vscode.ExtensionContext,
  record: (ok: boolean, line: string) => void,
  info: (line: string) => void
): Promise<void> {
  const ghBin = getGhPath().trim() || "gh";
  const ghTok = await execText(ghBin, ["auth", "token"]);
  const fromGh = ghTok.ok && ghTok.stdout.trim().length > 0;
  const fromSecret = Boolean((await context.secrets.get(GITHUB_PAT_SECRET_KEY))?.trim());
  const fromCfg = Boolean(
    vscode.workspace.getConfiguration("fordefiHotfix").get<string>("githubPat", "")?.trim()
  );
  const fromEnv = Boolean(process.env.GITHUB_ACCESS_TOKEN?.trim());

  let source: string | undefined;
  if (fromGh) source = "gh auth token";
  else if (fromSecret) source = "VS Code Secret Storage";
  else if (fromCfg) source = "fordefiHotfix.githubPat setting";
  else if (fromEnv) source = "GITHUB_ACCESS_TOKEN env";

  info(`Token sources available: gh=${fromGh} secret=${fromSecret} cfg=${fromCfg} env=${fromEnv}`);
  if (source) {
    record(true, `GitHub token resolves via: ${source}`);
  } else {
    record(
      false,
      `No GitHub token from any source. Run "gh auth login" or "Hotfix: Set GitHub token".`
    );
  }
}

async function checkGit(
  record: (ok: boolean, line: string) => void,
  info: (line: string) => void
): Promise<void> {
  const gitVer = await execText("git", ["--version"]);
  if (!gitVer.ok) {
    record(false, `git not runnable — ${gitVer.error.trim()}`);
    return;
  }
  record(true, `git runnable: ${gitVer.stdout.trim()}`);

  const repoRoot = getRepoRoot();
  if (!repoRoot) {
    record(false, "repoRoot empty and no workspace folder open. Set fordefiHotfix.repoRoot.");
    return;
  }
  info(`repoRoot: ${repoRoot}`);

  if (!fs.existsSync(repoRoot)) {
    record(false, `repoRoot does not exist on disk: ${repoRoot}`);
    return;
  }

  const inside = await execText("git", ["-C", repoRoot, "rev-parse", "--is-inside-work-tree"], {
    cwd: repoRoot,
  });
  if (!inside.ok || inside.stdout.trim() !== "true") {
    record(false, `repoRoot is not a git repository: ${repoRoot}`);
    return;
  }
  record(true, "repoRoot is a git work tree");

  const remote = await execText("git", ["-C", repoRoot, "remote", "get-url", "origin"], {
    cwd: repoRoot,
  });
  if (remote.ok) {
    info(`origin: ${remote.stdout.trim()}`);
  } else {
    info(`origin remote unreadable: ${remote.error.trim()}`);
  }
  const cfg = getRepoConfig();
  info(`Configured owner/repo: ${cfg.owner}/${cfg.repo}`);

  const wtPath = computeWorktreePath(repoRoot);
  if (fs.existsSync(wtPath)) {
    info(`Worktree present: ${wtPath}`);
    const head = await execText("git", ["-C", wtPath, "rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: wtPath,
    });
    if (head.ok) {
      const branch = head.stdout.trim();
      if (branch === HOTFIX_WORKTREE_BRANCH) {
        record(true, `Worktree HEAD on expected branch: ${branch}`);
      } else {
        record(
          false,
          `Worktree HEAD on '${branch}' (expected '${HOTFIX_WORKTREE_BRANCH}'). Fix once: git -C ${wtPath} checkout -B ${HOTFIX_WORKTREE_BRANCH}`
        );
      }
    } else {
      record(false, `Cannot read worktree HEAD — ${head.error.trim()}`);
    }
    const insteadOf = await execText(
      "git",
      ["-C", wtPath, "config", "--worktree", "--get-all", "url.https://github.com/.insteadOf"],
      { cwd: wtPath }
    );
    if (insteadOf.ok && insteadOf.stdout.includes("git@github.com:")) {
      record(true, "Worktree https-rewrite present (skips YubiKey on push/pull)");
    } else {
      info("Worktree https-rewrite not yet applied — gets created on next watcher run.");
    }
  } else {
    info(`Worktree not yet created: ${wtPath} (extension will create on first run)`);
  }

  const sshKey = (
    vscode.workspace.getConfiguration("fordefiHotfix").get<string>("worktreeSshKey", "") ?? ""
  ).trim();
  if (sshKey) {
    const expanded = sshKey.startsWith("~") ? path.join(os.homedir(), sshKey.slice(1)) : sshKey;
    info(`worktreeSshKey: ${expanded}`);
    if (!fs.existsSync(expanded)) {
      record(false, `worktreeSshKey file missing: ${expanded}`);
    } else {
      try {
        const stat = fs.statSync(expanded);
        const mode = stat.mode & 0o777;
        if (process.platform !== "win32" && (mode & 0o077) !== 0) {
          record(
            false,
            `worktreeSshKey perms ${mode.toString(8)} too open — chmod 600 ${expanded}`
          );
        } else {
          record(true, `worktreeSshKey readable, perms ${mode.toString(8)}`);
        }
      } catch (e) {
        record(false, `worktreeSshKey stat failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } else {
    info("worktreeSshKey not set (default — relies on https-rewrite for no-tap pulls).");
  }

  const postCreate = getWorktreePostCreateCommand();
  if (postCreate) {
    info(`Worktree post-create command: ${postCreate}`);
  }
}

async function checkOsNotify(record: (ok: boolean, line: string) => void): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }
  const r = await execText("osascript", ["-e", "return 1"]);
  if (r.ok) {
    record(true, "osascript runnable (deploy-finished notifications)");
  } else {
    record(false, `osascript not runnable — ${r.error.trim()}`);
  }
}

async function checkDirenv(
  record: (ok: boolean, line: string) => void,
  info: (line: string) => void
): Promise<void> {
  const r = await execText("direnv", ["--version"]);
  if (!r.ok) {
    info(`direnv not on PATH — only relevant if your fcli wrapper needs it.`);
    return;
  }
  record(true, `direnv runnable: ${r.stdout.trim()}`);
  const repoRoot = getRepoRoot();
  if (!repoRoot) return;
  const wtPath = computeWorktreePath(repoRoot);
  if (!fs.existsSync(path.join(wtPath, ".envrc"))) {
    info(`No .envrc inside ${wtPath} (skipped — direnv check not applicable).`);
    return;
  }
  const status = await execText("direnv", ["status"], { cwd: wtPath });
  if (!status.ok) {
    record(false, `direnv status failed in worktree — ${status.error.trim()}`);
    return;
  }
  if (/Found RC allowed (true|0)/.test(status.stdout)) {
    record(true, "direnv .envrc allowed inside worktree");
  } else {
    record(false, `direnv .envrc NOT allowed inside worktree. Run: cd ${wtPath} && direnv allow`);
  }
}
