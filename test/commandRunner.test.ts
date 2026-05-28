import * as cp from "node:child_process";
import * as fs from "node:fs";
import { describe, expect, it } from "vitest";
import { stripFcliJsonOutputFlag } from "../src/hotfixCommandTemplate";

const WORKTREE = "/Users/danielbellmas/go/src/arnac-hotfix-worktree";
const hasWorktree = fs.existsSync(`${WORKTREE}/fcli`);

/** Mirrors transparent-mode `runViaSpawn({ loginShell: true })`. */
function runLoginShell(command: string, cwd: string): { exitCode: number | null; output: string } {
  const shell = process.env.SHELL || "/bin/zsh";
  const result = cp.spawnSync(shell, ["-lc", command], {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  return {
    exitCode: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

describe("transparent loginShell spawn (fcli worktree)", () => {
  it("echo smoke test through $SHELL -lc", () => {
    const { exitCode, output } = runLoginShell("echo transparent-login-shell-ok", process.cwd());
    expect(exitCode).toBe(0);
    expect(output).toContain("transparent-login-shell-ok");
  });

  it("fcli hotfix --help exits 0 without -o json errors", () => {
    if (!hasWorktree) {
      return;
    }
    const { exitCode, output } = runLoginShell(
      `cd ${WORKTREE} && ./fcli workflows hotfix create-pull-request --help`,
      WORKTREE
    );
    expect(exitCode).toBe(0);
    expect(output).toMatch(/create-pull-request/i);
    expect(output).not.toMatch(/No such option: -o/i);
  }, 120_000);

  it("strip removes -o json so fcli fails on PR logic not unknown flag", () => {
    if (!hasWorktree) {
      return;
    }
    const raw = `cd ${WORKTREE} && ./fcli workflows hotfix create-pull-request 21716 --env pre -o json`;
    const cmd = stripFcliJsonOutputFlag(raw);
    expect(cmd).not.toMatch(/\s-o json\b/);

    const bad = runLoginShell(raw, WORKTREE);
    const good = runLoginShell(cmd, WORKTREE);

    expect(bad.exitCode).not.toBe(0);
    expect(bad.output).toMatch(/No such option: -o/i);
    expect(good.output).not.toMatch(/No such option: -o/i);
  }, 120_000);
});
