import { beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildDeployShellScript,
  type DeployTargets,
} from "../src/deployWorkflow";

/**
 * Stub `gh` script. Mirrors just enough of `gh`'s CLI surface for the
 * generated wait loop to run: the snapshot call, the dispatch call, the
 * poll-for-new-run call, and the two per-field `gh run view` calls.
 *
 * Return values come from schedule files in $GH_STUB_STATE so each test can
 * drive the stub deterministically (including multiple iterations of each
 * loop). Every invocation is appended to log.txt so tests can assert that
 * e.g. `production-hotfix.yml` was NEVER dispatched on a failed pre run.
 */
const STUB_SCRIPT = `#!/usr/bin/env bash
set -u
LOG="$GH_STUB_STATE/log.txt"
echo "gh $*" >> "$LOG"
ARGS="$*"
next_line() {
  local file="$1"
  local counter="$2"
  local i
  if [ -f "$counter" ]; then i=$(cat "$counter"); else i=0; fi
  i=$((i+1))
  echo "$i" > "$counter"
  sed -n "$i"p "$file"
}
case "$ARGS" in
  *"run list"*"--limit 5"*)
    cat "$GH_STUB_STATE/snapshot_id"
    ;;
  *"workflow run"*)
    echo "dispatched: $ARGS"
    ;;
  *"run list"*"--limit 20"*)
    out=$(next_line "$GH_STUB_STATE/newid_schedule" "$GH_STUB_STATE/newid_counter")
    if [ "$out" = "empty" ]; then echo ""; else echo "$out"; fi
    ;;
  *"run view"*"--json status"*)
    next_line "$GH_STUB_STATE/status_schedule" "$GH_STUB_STATE/status_counter"
    ;;
  *"run view"*"--json conclusion"*)
    out=$(next_line "$GH_STUB_STATE/conclusion_schedule" "$GH_STUB_STATE/conclusion_counter")
    if [ "$out" = "-" ]; then echo ""; else echo "$out"; fi
    ;;
  *)
    echo "stub gh: unhandled args: $ARGS" >&2
    exit 99
    ;;
esac
`;

const targets: DeployTargets = {
  repoSlug: "acme/workflows",
  preWorkflow: "pre-hotfix.yml",
  prodWorkflow: "production-hotfix.yml",
  ref: "main",
};

// macOS ships bash 3.2 (sufficient here); Windows has no bash. Skip on win32
// rather than using git-bash heuristics — not worth the test flakiness.
const maybeDescribe = process.platform === "win32" ? describe.skip : describe;

maybeDescribe("buildDeployShellScript(both) — real shell + stub gh", () => {
  let tmpDir: string;
  let stubDir: string;
  let stateDir: string;
  let scriptPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "hf-deploy-"));
    stubDir = path.join(tmpDir, "bin");
    stateDir = path.join(tmpDir, "state");
    mkdirSync(stubDir);
    mkdirSync(stateDir);
    const ghPath = path.join(stubDir, "gh");
    writeFileSync(ghPath, STUB_SCRIPT);
    chmodSync(ghPath, 0o755);
    scriptPath = path.join(tmpDir, "deploy.sh");
    writeFileSync(path.join(stateDir, "log.txt"), "");
  });

  /**
   * Compile the production `both`-env script, replace every `sleep 10` with
   * `sleep 0` (otherwise the test would idle for 10s+ per iteration), and
   * execute it under a PATH where only our stub `gh` is visible.
   */
  const runScript = (): ReturnType<typeof spawnSync> => {
    const compiled = buildDeployShellScript("both", targets);
    const fast = compiled.replace(/sleep 10/g, "sleep 0");
    writeFileSync(scriptPath, fast);
    return spawnSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ""}`,
        GH_STUB_STATE: stateDir,
      },
      encoding: "utf8",
    });
  };

  const readLog = (): string =>
    readFileSync(path.join(stateDir, "log.txt"), "utf8");

  const writeSchedule = (name: string, lines: string[]): void => {
    writeFileSync(
      path.join(stateDir, name),
      lines.join("\n") + (lines.length ? "\n" : "")
    );
  };

  it("success: after pre completes successfully, prod is dispatched", () => {
    writeFileSync(path.join(stateDir, "snapshot_id"), "5\n");
    writeSchedule("newid_schedule", ["empty", "10"]);
    writeSchedule("status_schedule", ["in_progress", "completed"]);
    writeSchedule("conclusion_schedule", ["-", "success"]);

    const res = runScript();
    expect({
      status: res.status,
      stderr: res.stderr,
      stdout: res.stdout,
    }).toMatchObject({ status: 0 });

    const log = readLog();
    // `"$*"` strips the original single quotes when bash expanded argv;
    // match the unquoted form that the stub actually logs.
    expect(log.match(/workflow run pre-hotfix\.yml/g) ?? []).toHaveLength(1);
    expect(
      log.match(/workflow run production-hotfix\.yml/g) ?? []
    ).toHaveLength(1);
    expect(log.indexOf("run list")).toBeLessThan(
      log.indexOf("workflow run pre-hotfix.yml")
    );
  });

  it("race guard: polls repeatedly until a databaseId > prev appears", () => {
    writeFileSync(path.join(stateDir, "snapshot_id"), "100\n");
    // the first two polls return empty (new run hasn't shown up yet), third
    // returns 101 — verifies the script doesn't lock on the first result.
    writeSchedule("newid_schedule", ["empty", "empty", "101"]);
    writeSchedule("status_schedule", ["completed"]);
    writeSchedule("conclusion_schedule", ["success"]);

    const res = runScript();
    expect(res.status).toBe(0);

    const newIdCounter = Number(
      readFileSync(path.join(stateDir, "newid_counter"), "utf8").trim()
    );
    expect(newIdCounter).toBe(3);

    // The "watching ... run id=101" line is produced by the generated
    // script's own `echo`, so it lands in the bash process stdout — not in
    // the stub-gh invocation log.
    expect(res.stdout).toMatch(/watching pre-hotfix\.yml run id=101/);
    const log = readLog();
    expect(
      log.match(/workflow run production-hotfix\.yml/g) ?? []
    ).toHaveLength(1);
  });

  it("failure: pre run fails → script exits non-zero and prod is NEVER dispatched", () => {
    writeFileSync(path.join(stateDir, "snapshot_id"), "5\n");
    writeSchedule("newid_schedule", ["10"]);
    writeSchedule("status_schedule", ["completed"]);
    writeSchedule("conclusion_schedule", ["failure"]);

    const res = runScript();
    expect(res.status).not.toBe(0);

    const log = readLog();
    expect(log).toMatch(/workflow run pre-hotfix\.yml/);
    // CRITICAL: a failed pre must never trigger prod
    expect(log).not.toMatch(/workflow run production-hotfix\.yml/);
    expect(res.stderr).toMatch(/ended with failure/);
  });

  it("failure: pre run cancelled → script exits non-zero", () => {
    writeFileSync(path.join(stateDir, "snapshot_id"), "5\n");
    writeSchedule("newid_schedule", ["10"]);
    writeSchedule("status_schedule", ["completed"]);
    writeSchedule("conclusion_schedule", ["cancelled"]);

    const res = runScript();
    expect(res.status).not.toBe(0);
    expect(readLog()).not.toMatch(/workflow run production-hotfix\.yml/);
  });

  it("status polls correctly across multiple iterations before success", () => {
    writeFileSync(path.join(stateDir, "snapshot_id"), "5\n");
    writeSchedule("newid_schedule", ["10"]);
    writeSchedule("status_schedule", [
      "queued",
      "in_progress",
      "in_progress",
      "completed",
    ]);
    writeSchedule("conclusion_schedule", ["-", "-", "-", "success"]);

    const res = runScript();
    expect(res.status).toBe(0);

    const statusCounter = Number(
      readFileSync(path.join(stateDir, "status_counter"), "utf8").trim()
    );
    expect(statusCounter).toBe(4);
  });
});
