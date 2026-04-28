import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyWorktreeHttpsRewrite,
  computeWorktreePath,
  ensureHotfixWorktree,
  HOTFIX_WORKTREE_BRANCH,
  resolveDefaultBranch,
  type ExecResult,
  type WorktreeDeps,
} from "../src/worktreeManager";

type ExecCall = { file: string; args: string[]; cwd?: string };

type ExecResponder = (call: ExecCall) => ExecResult | undefined;

function ok(stdout: string): ExecResult {
  return { ok: true, stdout };
}

function fail(message: string): ExecResult {
  return { ok: false, error: new Error(message) };
}

function makeDeps(overrides: {
  responder?: ExecResponder;
  existing?: Set<string>;
  mkdirThrows?: boolean;
}): {
  deps: WorktreeDeps;
  calls: ExecCall[];
  mkdirCalls: string[];
  logs: string[];
} {
  const calls: ExecCall[] = [];
  const mkdirCalls: string[] = [];
  const logs: string[] = [];
  const existing = overrides.existing ?? new Set<string>();

  const deps: WorktreeDeps = {
    exec: (file, args, opts) => {
      const call: ExecCall = { file, args: [...args], cwd: opts?.cwd };
      calls.push(call);
      const r = overrides.responder?.(call);
      if (r) {
        return r;
      }
      return ok("");
    },
    existsSync: (p) => existing.has(p),
    mkdirSync: (p) => {
      mkdirCalls.push(p);
      if (overrides.mkdirThrows) {
        throw new Error("EACCES: mkdir");
      }
    },
    log: (line) => logs.push(line),
  };
  return { deps, calls, mkdirCalls, logs };
}

describe("computeWorktreePath", () => {
  it("appends -hotfix-worktree as a sibling of repoRoot", () => {
    expect(computeWorktreePath("/Users/me/go/src/arnac")).toBe(
      "/Users/me/go/src/arnac-hotfix-worktree"
    );
  });

  it("strips a trailing slash before appending the suffix", () => {
    expect(computeWorktreePath("/Users/me/go/src/arnac/")).toBe(
      "/Users/me/go/src/arnac-hotfix-worktree"
    );
  });

  it("strips a trailing backslash (windows paths)", () => {
    expect(computeWorktreePath("C:\\src\\arnac\\")).toBe(
      "C:\\src\\arnac-hotfix-worktree"
    );
  });
});

describe("resolveDefaultBranch", () => {
  it("strips the origin/ prefix from symbolic-ref output", () => {
    const { deps } = makeDeps({
      responder: (call) => {
        if (call.args.includes("symbolic-ref")) {
          return ok("origin/develop\n");
        }
        return undefined;
      },
    });
    expect(resolveDefaultBranch("/path/repo", deps)).toBe("develop");
  });

  it("falls back to main when symbolic-ref fails", () => {
    const { deps } = makeDeps({
      responder: (call) => {
        if (call.args.includes("symbolic-ref")) {
          return fail("no HEAD");
        }
        return undefined;
      },
    });
    expect(resolveDefaultBranch("/path/repo", deps)).toBe("main");
  });

  it("falls back to main when symbolic-ref returns empty", () => {
    const { deps } = makeDeps({
      responder: (call) => {
        if (call.args.includes("symbolic-ref")) {
          return ok("");
        }
        return undefined;
      },
    });
    expect(resolveDefaultBranch("/path/repo", deps)).toBe("main");
  });
});

describe("ensureHotfixWorktree", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty-root fallback when repoRoot is empty", async () => {
    const { deps } = makeDeps({});
    const res = await ensureHotfixWorktree("", deps);
    expect(res.fallback).toBe("empty-root");
    expect(res.path).toBe("");
    expect(res.created).toBe(false);
  });

  it("returns missing-git fallback when `git --version` fails with ENOENT", async () => {
    const { deps } = makeDeps({
      responder: (call) => {
        if (call.file === "git" && call.args[0] === "--version") {
          const err = new Error("spawn git ENOENT") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          return { ok: false, error: err };
        }
        return undefined;
      },
    });
    const res = await ensureHotfixWorktree("/path/repo", deps);
    expect(res.fallback).toBe("missing-git");
    expect(res.path).toBe("/path/repo");
  });

  it("returns not-a-repo fallback when `git rev-parse --git-dir` fails", async () => {
    const { deps } = makeDeps({
      responder: (call) => {
        if (call.args.includes("--git-dir")) {
          return fail("fatal: not a git repository");
        }
        return undefined;
      },
    });
    const res = await ensureHotfixWorktree("/path/not-a-repo", deps);
    expect(res.fallback).toBe("not-a-repo");
    expect(res.path).toBe("/path/not-a-repo");
  });

  it("reuses an existing worktree without invoking `git worktree add`", async () => {
    const repoRoot = "/Users/me/go/src/arnac";
    const expectedPath = "/Users/me/go/src/arnac-hotfix-worktree";
    const { deps, calls } = makeDeps({
      existing: new Set([expectedPath]),
      responder: (call) => {
        if (call.args.includes("--is-inside-work-tree")) {
          return ok("true\n");
        }
        return undefined;
      },
    });

    const res = await ensureHotfixWorktree(repoRoot, deps);

    expect(res.created).toBe(false);
    expect(res.fallback).toBeUndefined();
    expect(res.path).toBe(expectedPath);

    const addCalls = calls.filter(
      (c) => c.args.includes("worktree") && c.args.includes("add")
    );
    expect(addCalls).toHaveLength(0);
  });

  it("falls through to creating when the path exists but is not a worktree", async () => {
    const repoRoot = "/Users/me/go/src/arnac";
    const expectedPath = "/Users/me/go/src/arnac-hotfix-worktree";
    const { deps, calls, mkdirCalls } = makeDeps({
      existing: new Set([expectedPath]),
      responder: (call) => {
        if (call.args.includes("--is-inside-work-tree")) {
          return ok("false\n");
        }
        if (
          call.args.includes("symbolic-ref") &&
          call.args.some((a) => a.startsWith("refs/remotes/"))
        ) {
          return ok("origin/main\n");
        }
        return undefined;
      },
    });

    const res = await ensureHotfixWorktree(repoRoot, deps);

    expect(res.created).toBe(true);
    expect(res.path).toBe(expectedPath);
    expect(mkdirCalls).toContain(path.dirname(expectedPath));
    const addCalls = calls.filter(
      (c) => c.args.includes("worktree") && c.args.includes("add")
    );
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0].args).toEqual([
      "-C",
      repoRoot,
      "worktree",
      "add",
      "-B",
      HOTFIX_WORKTREE_BRANCH,
      expectedPath,
      "origin/main",
    ]);
  });

  it("creates a fresh worktree on the dedicated branch (not detached) so fcli sees a branch name", async () => {
    const repoRoot = "/Users/me/go/src/arnac";
    const expectedPath = "/Users/me/go/src/arnac-hotfix-worktree";
    const { deps, calls, logs } = makeDeps({
      responder: (call) => {
        if (
          call.args.includes("symbolic-ref") &&
          call.args.some((a) => a.startsWith("refs/remotes/"))
        ) {
          return ok("origin/develop\n");
        }
        return undefined;
      },
    });

    const res = await ensureHotfixWorktree(repoRoot, deps);

    expect(res.created).toBe(true);
    expect(res.fallback).toBeUndefined();
    expect(res.path).toBe(expectedPath);

    const addCalls = calls.filter(
      (c) => c.args.includes("worktree") && c.args.includes("add")
    );
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0].args).not.toContain("--detach");
    expect(addCalls[0].args).toContain("-B");
    expect(addCalls[0].args).toContain(HOTFIX_WORKTREE_BRANCH);
    expect(addCalls[0].args.at(-1)).toBe("origin/develop");
    expect(logs.some((l) => l.startsWith("[worktree] created:"))).toBe(true);
  });

  it("never invokes any git command on the reused worktree beyond the existence/inside-worktree probe (create once, leave alone)", async () => {
    const repoRoot = "/Users/me/go/src/arnac";
    const expectedPath = "/Users/me/go/src/arnac-hotfix-worktree";
    const { deps, calls } = makeDeps({
      existing: new Set([expectedPath]),
      responder: (call) => {
        if (call.args.includes("--is-inside-work-tree")) {
          return ok("true\n");
        }
        return undefined;
      },
    });

    await ensureHotfixWorktree(repoRoot, deps);

    const wtMutating = calls.filter(
      (c) =>
        c.args.includes("checkout") ||
        c.args.includes("fetch") ||
        c.args.includes("reset") ||
        (c.args.includes("worktree") && c.args.includes("add"))
    );
    expect(wtMutating).toHaveLength(0);
  });

  it("returns add-failed fallback when `git worktree add` fails", async () => {
    const { deps } = makeDeps({
      responder: (call) => {
        if (call.args.includes("worktree") && call.args.includes("add")) {
          return fail("fatal: 'wt' already exists");
        }
        return undefined;
      },
    });

    const res = await ensureHotfixWorktree("/Users/me/go/src/arnac", deps);

    expect(res.fallback).toBe("add-failed");
    expect(res.path).toBe("/Users/me/go/src/arnac");
    expect(res.created).toBe(false);
    expect(res.fallbackDetail).toMatch(/already exists/);
  });

  it("returns add-failed fallback when mkdir throws", async () => {
    const { deps } = makeDeps({
      mkdirThrows: true,
    });

    const res = await ensureHotfixWorktree("/Users/me/go/src/arnac", deps);

    expect(res.fallback).toBe("add-failed");
    expect(res.path).toBe("/Users/me/go/src/arnac");
    expect(res.fallbackDetail).toMatch(/mkdir/);
  });

  it("applies the per-worktree https-rewrite + gh credential helper after creating a fresh worktree", async () => {
    const repoRoot = "/Users/me/go/src/arnac";
    const wt = "/Users/me/go/src/arnac-hotfix-worktree";
    const { deps, calls } = makeDeps({
      responder: (call) => {
        if (
          call.args.includes("symbolic-ref") &&
          call.args.some((a) => a.startsWith("refs/remotes/"))
        ) {
          return ok("origin/main\n");
        }
        return undefined;
      },
    });

    const res = await ensureHotfixWorktree(repoRoot, deps, {
      ghPath: "/opt/homebrew/bin/gh",
    });
    expect(res.created).toBe(true);

    const enable = calls.filter(
      (c) =>
        c.args.includes("config") &&
        c.args.includes("extensions.worktreeConfig")
    );
    expect(enable).toHaveLength(1);

    const insteadOf = calls.filter((c) =>
      c.args.includes("url.https://github.com/.insteadOf")
    );
    expect(insteadOf).toHaveLength(1);
    expect(insteadOf[0].args).toEqual([
      "-C",
      wt,
      "config",
      "--worktree",
      "--replace-all",
      "url.https://github.com/.insteadOf",
      "git@github.com:",
    ]);

    const helperCalls = calls.filter((c) =>
      c.args.includes("credential.https://github.com.helper")
    );
    expect(helperCalls.map((c) => c.args.at(-1))).toEqual([
      "credential.https://github.com.helper",
      "",
      "!/opt/homebrew/bin/gh auth git-credential",
    ]);
    expect(helperCalls[0].args).toContain("--unset-all");
    expect(helperCalls[1].args).toContain("--add");
    expect(helperCalls[2].args).toContain("--add");
  });

  it("re-applies the rewrite on reuse so existing worktrees pick up changes", async () => {
    const repoRoot = "/Users/me/go/src/arnac";
    const wt = "/Users/me/go/src/arnac-hotfix-worktree";
    const { deps, calls } = makeDeps({
      existing: new Set([wt]),
      responder: (call) => {
        if (call.args.includes("--is-inside-work-tree")) {
          return ok("true\n");
        }
        return undefined;
      },
    });

    const res = await ensureHotfixWorktree(repoRoot, deps, { ghPath: "" });
    expect(res.created).toBe(false);
    expect(
      calls.filter((c) => c.args.includes("url.https://github.com/.insteadOf"))
    ).toHaveLength(1);
  });

  it("falls back to literal `gh` when ghPath option is empty", async () => {
    const repoRoot = "/Users/me/go/src/arnac";
    const { deps, calls } = makeDeps({
      existing: new Set(["/Users/me/go/src/arnac-hotfix-worktree"]),
      responder: (call) => {
        if (call.args.includes("--is-inside-work-tree")) {
          return ok("true\n");
        }
        return undefined;
      },
    });
    await ensureHotfixWorktree(repoRoot, deps, { ghPath: "" });
    const helperAdd = calls.find(
      (c) =>
        c.args.includes("--add") &&
        c.args.includes("credential.https://github.com.helper") &&
        typeof c.args.at(-1) === "string" &&
        (c.args.at(-1) as string).includes("auth git-credential")
    );
    expect(helperAdd?.args.at(-1)).toBe("!gh auth git-credential");
  });

  it("never writes outside `--worktree` scope", async () => {
    const repoRoot = "/Users/me/go/src/arnac";
    const { deps, calls } = makeDeps({
      responder: (call) => {
        if (
          call.args.includes("symbolic-ref") &&
          call.args.some((a) => a.startsWith("refs/remotes/"))
        ) {
          return ok("origin/main\n");
        }
        return undefined;
      },
    });

    await ensureHotfixWorktree(repoRoot, deps, { ghPath: "/usr/bin/gh" });

    const insteadOf = calls.filter((c) =>
      c.args.includes("url.https://github.com/.insteadOf")
    );
    const helperWrites = calls.filter(
      (c) =>
        c.args.includes("credential.https://github.com.helper") &&
        (c.args.includes("--add") || c.args.includes("--unset-all"))
    );
    for (const c of [...insteadOf, ...helperWrites]) {
      expect(c.args).toContain("--worktree");
      expect(c.args).not.toContain("--global");
      expect(c.args).not.toContain("--system");
    }
  });

  it("runs the postCreateCommand once (in the worktree cwd) after a fresh `git worktree add`", async () => {
    const repoRoot = "/Users/me/go/src/arnac";
    const wt = "/Users/me/go/src/arnac-hotfix-worktree";
    const { deps, calls, logs } = makeDeps({
      responder: (call) => {
        if (
          call.args.includes("symbolic-ref") &&
          call.args.some((a) => a.startsWith("refs/remotes/"))
        ) {
          return ok("origin/main\n");
        }
        return undefined;
      },
    });

    const res = await ensureHotfixWorktree(repoRoot, deps, {
      postCreateCommand: "./atool prepare-codeenv",
    });
    expect(res.created).toBe(true);

    const post = calls.filter(
      (c) => c.file === "sh" && c.args[0] === "-c"
    );
    expect(post).toHaveLength(1);
    expect(post[0].args[1]).toBe("./atool prepare-codeenv");
    expect(post[0].cwd).toBe(wt);
    expect(logs.some((l) => l.includes("post-create completed"))).toBe(true);
  });

  it("does NOT run the postCreateCommand when the worktree is reused (one-shot only)", async () => {
    const repoRoot = "/Users/me/go/src/arnac";
    const wt = "/Users/me/go/src/arnac-hotfix-worktree";
    const { deps, calls } = makeDeps({
      existing: new Set([wt]),
      responder: (call) => {
        if (call.args.includes("--is-inside-work-tree")) {
          return ok("true\n");
        }
        return undefined;
      },
    });

    const res = await ensureHotfixWorktree(repoRoot, deps, {
      postCreateCommand: "./atool prepare-codeenv",
    });
    expect(res.created).toBe(false);

    const post = calls.filter(
      (c) => c.file === "sh" && c.args[0] === "-c"
    );
    expect(post).toHaveLength(0);
  });

  it("skips the postCreateCommand when the option is empty / missing", async () => {
    const repoRoot = "/Users/me/go/src/arnac";
    const { deps, calls } = makeDeps({
      responder: (call) => {
        if (
          call.args.includes("symbolic-ref") &&
          call.args.some((a) => a.startsWith("refs/remotes/"))
        ) {
          return ok("origin/main\n");
        }
        return undefined;
      },
    });

    await ensureHotfixWorktree(repoRoot, deps, { postCreateCommand: "" });
    expect(calls.filter((c) => c.file === "sh")).toHaveLength(0);

    await ensureHotfixWorktree(repoRoot, deps, {});
    expect(calls.filter((c) => c.file === "sh")).toHaveLength(0);
  });

  it("does not fail the worktree when the postCreateCommand exits non-zero (best-effort)", async () => {
    const repoRoot = "/Users/me/go/src/arnac";
    const { deps, logs } = makeDeps({
      responder: (call) => {
        if (call.file === "sh") {
          return fail("exit 1");
        }
        if (
          call.args.includes("symbolic-ref") &&
          call.args.some((a) => a.startsWith("refs/remotes/"))
        ) {
          return ok("origin/main\n");
        }
        return undefined;
      },
    });

    const res = await ensureHotfixWorktree(repoRoot, deps, {
      postCreateCommand: "./atool prepare-codeenv",
    });
    expect(res.created).toBe(true);
    expect(res.fallback).toBeUndefined();
    expect(logs.some((l) => l.includes("post-create failed"))).toBe(true);
  });

  it("logs and continues when enabling extensions.worktreeConfig fails (no fallback, worktree still works)", async () => {
    const repoRoot = "/Users/me/go/src/arnac";
    const { deps, calls, logs } = makeDeps({
      responder: (call) => {
        if (call.args.includes("extensions.worktreeConfig")) {
          return fail("permission denied");
        }
        if (
          call.args.includes("symbolic-ref") &&
          call.args.some((a) => a.startsWith("refs/remotes/"))
        ) {
          return ok("origin/main\n");
        }
        return undefined;
      },
    });

    const res = await ensureHotfixWorktree(repoRoot, deps, { ghPath: "gh" });
    expect(res.created).toBe(true);
    expect(res.fallback).toBeUndefined();
    expect(
      calls.filter((c) =>
        c.args.includes("url.https://github.com/.insteadOf")
      )
    ).toHaveLength(0);
    expect(logs.some((l) => l.includes("https-rewrite skipped"))).toBe(true);
  });
});

describe("applyWorktreeHttpsRewrite (unit)", () => {
  it("issues exactly the expected sequence: enable extension → replace insteadOf → unset+add empty+add gh helper", () => {
    const calls: ExecCall[] = [];
    const deps: WorktreeDeps = {
      exec: (file, args, opts) => {
        calls.push({ file, args: [...args], cwd: opts?.cwd });
        return ok("");
      },
      existsSync: () => true,
      mkdirSync: () => undefined,
      log: () => undefined,
    };

    applyWorktreeHttpsRewrite("/repo", "/repo-wt", "/usr/local/bin/gh", deps);

    const argsList = calls.map((c) => c.args.join(" "));
    expect(argsList).toEqual([
      "-C /repo config extensions.worktreeConfig true",
      "-C /repo-wt config --worktree --replace-all url.https://github.com/.insteadOf git@github.com:",
      "-C /repo-wt config --worktree --unset-all credential.https://github.com.helper",
      "-C /repo-wt config --worktree --add credential.https://github.com.helper ",
      "-C /repo-wt config --worktree --add credential.https://github.com.helper !/usr/local/bin/gh auth git-credential",
    ]);
  });
});
