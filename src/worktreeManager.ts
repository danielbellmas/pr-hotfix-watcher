import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type WorktreeFallbackReason = "empty-root" | "missing-git" | "not-a-repo" | "add-failed";

export type EnsureHotfixWorktreeResult = {
  /** Effective working directory for the hotfix command. */
  path: string;
  /** True only when this invocation performed `git worktree add`. */
  created: boolean;
  /** Present when we could not provision a worktree and fell back to {@link path}. */
  fallback?: WorktreeFallbackReason;
  /** Present only when `fallback` is set; human-readable reason. */
  fallbackDetail?: string;
};

/**
 * Minimal filesystem / process seam so tests can drive the module without
 * touching the real git or filesystem.
 */
export type WorktreeDeps = {
  exec: (file: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => ExecResult;
  existsSync: (p: string) => boolean;
  mkdirSync: (p: string, opts?: { recursive?: boolean }) => void;
  log?: (line: string) => void;
};

export type ExecResult =
  | { ok: true; stdout: string }
  | { ok: false; error: Error; stdout?: string };

const DEFAULT_BRANCH_FALLBACK = "main";
const GIT_TIMEOUT_MS = 15_000;
/**
 * Long enough for `./atool prepare-codeenv` to finish on a cold cache (docker
 * image pulls + protobuf codegen). Keeps the watcher blocked once, on the first
 * worktree creation only.
 */
const POST_CREATE_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Suffix appended to the normalized `repoRoot` to form the dedicated hotfix
 * worktree path. With `repoRoot = /Users/x/go/src/arnac` the worktree lives at
 * `/Users/x/go/src/arnac-hotfix-worktree` — a sibling, so direnv / the parent
 * `go/src` layout stay unaffected.
 */
export const HOTFIX_WORKTREE_SUFFIX = "-hotfix-worktree";

/**
 * Dedicated branch name the worktree's HEAD points at. Required because `fcli`
 * calls `repo.active_branch.name` (gitpython), which raises on detached HEAD;
 * a previous `--detach` strategy here broke `./fcli workflows hotfix
 * create-pull-request` with `TypeError: HEAD is a detached symbolic reference`.
 *
 * Picked to be unlikely to collide with a real working branch — the worktree
 * "owns" this branch and may reset it without warning.
 */
export const HOTFIX_WORKTREE_BRANCH = "hotfix-worktree";

export function createDefaultWorktreeDeps(log?: (line: string) => void): WorktreeDeps {
  return {
    exec: (file, args, opts) => {
      try {
        const stdout = cp.execFileSync(file, args, {
          cwd: opts?.cwd,
          encoding: "utf8",
          timeout: opts?.timeoutMs ?? GIT_TIMEOUT_MS,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        return { ok: true, stdout };
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        return { ok: false, error: err };
      }
    },
    existsSync: (p) => fs.existsSync(p),
    mkdirSync: (p, opts) => {
      fs.mkdirSync(p, { recursive: Boolean(opts?.recursive) });
    },
    log,
  };
}

/** Resolve the default branch name (without the `origin/` prefix). */
export function resolveDefaultBranch(repoRoot: string, deps: WorktreeDeps): string {
  const res = deps.exec(
    "git",
    ["-C", repoRoot, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    { cwd: repoRoot }
  );
  if (!res.ok) {
    return DEFAULT_BRANCH_FALLBACK;
  }
  const raw = res.stdout.trim();
  if (!raw) {
    return DEFAULT_BRANCH_FALLBACK;
  }
  const stripped = raw.startsWith("origin/") ? raw.slice("origin/".length) : raw;
  return stripped || DEFAULT_BRANCH_FALLBACK;
}

/** Dedicated hotfix worktree path: `<repoRoot>-hotfix-worktree` (trailing-slash-safe). */
export function computeWorktreePath(repoRoot: string): string {
  const normalized = repoRoot.replace(/[\\/]+$/, "");
  return `${normalized}${HOTFIX_WORKTREE_SUFFIX}`;
}

/**
 * Per-worktree URL rewrite + credential helper that routes fcli's
 * `git push/pull/fetch origin` through HTTPS + `gh auth git-credential`,
 * bypassing the SSH transport (and therefore the YubiKey tap) only inside
 * the hotfix worktree. Main repo `.git/config` and `~/.gitconfig` are
 * untouched. Idempotent — `--replace-all` / `--unset-all` keep the file
 * stable across watcher runs. Failures are logged and swallowed: this is a
 * convenience layer; if writes fail the worktree just falls back to today's
 * SSH-with-tap behavior, no regression.
 */
export function applyWorktreeHttpsRewrite(
  repoRoot: string,
  worktreePath: string,
  ghPath: string,
  deps: WorktreeDeps
): void {
  const enable = deps.exec("git", ["-C", repoRoot, "config", "extensions.worktreeConfig", "true"], {
    cwd: repoRoot,
  });
  if (!enable.ok) {
    deps.log?.(
      `[worktree] https-rewrite skipped: enable extensions.worktreeConfig failed — ${enable.error.message.trim()}`
    );
    return;
  }

  const insteadOf = deps.exec(
    "git",
    [
      "-C",
      worktreePath,
      "config",
      "--worktree",
      "--replace-all",
      "url.https://github.com/.insteadOf",
      "git@github.com:",
    ],
    { cwd: worktreePath }
  );
  if (!insteadOf.ok) {
    deps.log?.(
      `[worktree] https-rewrite skipped: set insteadOf failed — ${insteadOf.error.message.trim()}`
    );
    return;
  }

  // The empty helper resets any inherited chain (osxkeychain etc.) so the
  // worktree gets a deterministic gh-only credential lookup.
  deps.exec(
    "git",
    [
      "-C",
      worktreePath,
      "config",
      "--worktree",
      "--unset-all",
      "credential.https://github.com.helper",
    ],
    { cwd: worktreePath }
  );

  const resolvedGh = ghPath.trim() || "gh";
  const helperCmd = `!${resolvedGh} auth git-credential`;
  const addEmpty = deps.exec(
    "git",
    [
      "-C",
      worktreePath,
      "config",
      "--worktree",
      "--add",
      "credential.https://github.com.helper",
      "",
    ],
    { cwd: worktreePath }
  );
  if (!addEmpty.ok) {
    deps.log?.(
      `[worktree] https-rewrite partial: add empty helper failed — ${addEmpty.error.message.trim()}`
    );
    return;
  }
  const addGh = deps.exec(
    "git",
    [
      "-C",
      worktreePath,
      "config",
      "--worktree",
      "--add",
      "credential.https://github.com.helper",
      helperCmd,
    ],
    { cwd: worktreePath }
  );
  if (!addGh.ok) {
    deps.log?.(
      `[worktree] https-rewrite partial: add gh helper failed — ${addGh.error.message.trim()}`
    );
    return;
  }

  deps.log?.(
    `[worktree] https-rewrite applied: insteadOf git@github.com: → https://github.com/, credential helper "${helperCmd}"`
  );
}

function isInsideWorkTree(wtPath: string, deps: WorktreeDeps): boolean {
  const res = deps.exec("git", ["-C", wtPath, "rev-parse", "--is-inside-work-tree"], {
    cwd: wtPath,
  });
  if (!res.ok) {
    return false;
  }
  return res.stdout.trim() === "true";
}

function isGitRepo(repoRoot: string, deps: WorktreeDeps): boolean {
  const res = deps.exec("git", ["-C", repoRoot, "rev-parse", "--git-dir"], { cwd: repoRoot });
  return res.ok;
}

function isGitMissing(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return true;
  }
  const msg = error.message.toLowerCase();
  return msg.includes("enoent") && msg.includes("git");
}

function buildFallback(
  repoRoot: string,
  reason: WorktreeFallbackReason,
  detail: string,
  deps: WorktreeDeps
): EnsureHotfixWorktreeResult {
  deps.log?.(`[worktree] fallback: ${reason} (${detail})`);
  return {
    path: repoRoot,
    created: false,
    fallback: reason,
    fallbackDetail: detail,
  };
}

/**
 * Ensure a persistent, isolated git worktree exists at
 * `<repoRoot>-hotfix-worktree`. If it already exists it's reused as-is — no
 * fetch, no reset — matching the "create once, never auto-touch" policy. Any
 * unrecoverable failure returns a fallback pointing at the original `repoRoot`
 * so the run still proceeds instead of blocking the user.
 */
export type EnsureHotfixWorktreeOptions = {
  /** Path to `gh` for the per-worktree credential helper. Empty → falls back to "gh" on PATH. */
  ghPath?: string;
  /**
   * Shell command run **once**, in the worktree's cwd, immediately after a
   * successful `git worktree add`. Skipped on reuse. Empty / undefined → no-op.
   *
   * Intended for one-shot environment bootstrap (e.g. `./atool prepare-codeenv`)
   * so subsequent fcli runs don't hit stale protobuf / venv state. Failures are
   * logged and swallowed: the worktree is still considered created so the run
   * proceeds, and the user can re-run the command manually if needed.
   */
  postCreateCommand?: string;
};

export async function ensureHotfixWorktree(
  repoRoot: string,
  deps: WorktreeDeps = createDefaultWorktreeDeps(),
  options?: EnsureHotfixWorktreeOptions
): Promise<EnsureHotfixWorktreeResult> {
  if (!repoRoot || !repoRoot.trim()) {
    return buildFallback(repoRoot, "empty-root", "repoRoot is empty", deps);
  }

  const probe = deps.exec("git", ["--version"]);
  if (!probe.ok && isGitMissing(probe.error)) {
    return buildFallback(repoRoot, "missing-git", "`git` executable not found on PATH", deps);
  }

  if (!isGitRepo(repoRoot, deps)) {
    return buildFallback(repoRoot, "not-a-repo", `${repoRoot} is not a git repository`, deps);
  }

  const wtPath = computeWorktreePath(repoRoot);

  if (deps.existsSync(wtPath) && isInsideWorkTree(wtPath, deps)) {
    deps.log?.(`[worktree] reuse: ${wtPath}`);
    applyWorktreeHttpsRewrite(repoRoot, wtPath, options?.ghPath ?? "", deps);
    return { path: wtPath, created: false };
  }

  const parentDir = path.dirname(wtPath);
  try {
    deps.mkdirSync(parentDir, { recursive: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return buildFallback(repoRoot, "add-failed", `mkdir ${parentDir}: ${msg}`, deps);
  }

  const branch = resolveDefaultBranch(repoRoot, deps);
  const addRes = deps.exec(
    "git",
    ["-C", repoRoot, "worktree", "add", "-B", HOTFIX_WORKTREE_BRANCH, wtPath, `origin/${branch}`],
    { cwd: repoRoot, timeoutMs: 120_000 }
  );

  if (!addRes.ok) {
    return buildFallback(
      repoRoot,
      "add-failed",
      `git worktree add failed: ${addRes.error.message.trim()}`,
      deps
    );
  }

  deps.log?.(`[worktree] created: ${wtPath} (branch ${HOTFIX_WORKTREE_BRANCH} @ origin/${branch})`);
  applyWorktreeHttpsRewrite(repoRoot, wtPath, options?.ghPath ?? "", deps);
  runPostCreateCommand(wtPath, options?.postCreateCommand, deps);
  return { path: wtPath, created: true };
}

/**
 * Run a one-shot shell command inside the freshly-created worktree. Routed
 * through `sh -c` so the configured value can be a small pipeline / cd-prefix
 * if needed. Best-effort: any failure is logged and ignored so the watcher's
 * higher-level flow keeps running.
 */
function runPostCreateCommand(
  wtPath: string,
  command: string | undefined,
  deps: WorktreeDeps
): void {
  const cmd = command?.trim();
  if (!cmd) {
    return;
  }
  deps.log?.(
    `[worktree] post-create: running "${cmd}" in ${wtPath} (one-shot, may take a few minutes)`
  );
  const res = deps.exec("sh", ["-c", cmd], {
    cwd: wtPath,
    timeoutMs: POST_CREATE_TIMEOUT_MS,
  });
  if (!res.ok) {
    deps.log?.(`[worktree] post-create failed (continuing): ${res.error.message.trim()}`);
    return;
  }
  deps.log?.(`[worktree] post-create completed: "${cmd}"`);
}
