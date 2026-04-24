import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeWorktreePath,
  ensureHotfixWorktree,
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
        if (call.args.includes("symbolic-ref")) {
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
      "--detach",
      expectedPath,
      "origin/main",
    ]);
  });

  it("creates a fresh worktree at <repoRoot>-hotfix-worktree with detected default branch", async () => {
    const repoRoot = "/Users/me/go/src/arnac";
    const expectedPath = "/Users/me/go/src/arnac-hotfix-worktree";
    const { deps, calls, logs } = makeDeps({
      responder: (call) => {
        if (call.args.includes("symbolic-ref")) {
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
    expect(addCalls[0].args.at(-1)).toBe("origin/develop");
    expect(logs.some((l) => l.startsWith("[worktree] created:"))).toBe(true);
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
});
