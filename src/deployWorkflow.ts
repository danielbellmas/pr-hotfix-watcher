import type { HotfixCliEnv } from "./hotfixCli";

export type DeployTargets = {
  /** `owner/repo` for the workflows repository (e.g. `arnac-io/workflows`). */
  repoSlug: string;
  preWorkflow: string;
  prodWorkflow: string;
  ref: string;
};

/** Single-quote value for inclusion in a POSIX shell command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildGhWorkflowRunCommand(params: {
  repoSlug: string;
  workflow: string;
  ref: string;
}): string {
  const { repoSlug, workflow, ref } = params;
  return [
    "gh",
    "workflow",
    "run",
    shellQuote(workflow),
    "--repo",
    shellQuote(repoSlug),
    "--ref",
    shellQuote(ref),
  ].join(" ");
}

/**
 * Capture the newest `databaseId` for `workflow` *before* dispatching, so the
 * subsequent poll can unambiguously identify the run we triggered rather than
 * the previously-completed one (which could already satisfy "completed +
 * success" and cause the wait to return immediately with the wrong run).
 *
 * Assigns to shell variable `prevIdVar`. Uses `// 0` so an empty workflow
 * history yields a numeric zero, making the "> prev" comparison in
 * {@link buildGhWaitForNewAndCompleteRun} work on the first-ever run.
 */
export function buildGhRunListSnapshotLatestId(params: {
  repoSlug: string;
  workflow: string;
  prevIdVar: string;
}): string {
  const { repoSlug, workflow, prevIdVar } = params;
  const slug = shellQuote(repoSlug);
  const wf = shellQuote(workflow);
  return [
    `${prevIdVar}=$(gh run list --repo ${slug} --workflow ${wf} --limit 5 --json databaseId -q '[.[].databaseId] | max // 0')`,
    `echo "[deploy] snapshot latest ${workflow} run id=$${prevIdVar}"`,
  ].join("\n");
}

/**
 * Poll `gh run list` until a run with `databaseId > $prevIdVar` exists, then
 * poll `gh run view <id>` on that specific run until its `status=completed`
 * and verify `conclusion=success`. Emits structured `[deploy]` log lines so
 * users can see progress in the integrated terminal / output channel.
 *
 * Per-field `-q` queries avoid parsing multi-line pretty-printed JSON with
 * `sed` (which is how this logic used to silently never match).
 */
export function buildGhWaitForNewAndCompleteRun(params: {
  repoSlug: string;
  workflow: string;
  prevIdVar: string;
  runIdVar: string;
  /** Seconds between polls. */
  pollSeconds?: number;
  /** Max seconds to wait for the new run to appear in the run list. */
  newRunTimeoutSeconds?: number;
  /** Max seconds to wait for the run to reach `completed`. */
  completionTimeoutSeconds?: number;
}): string {
  const { repoSlug, workflow, prevIdVar, runIdVar } = params;
  const pollSeconds = Math.max(2, params.pollSeconds ?? 10);
  const newRunTimeout = Math.max(30, params.newRunTimeoutSeconds ?? 300);
  const completionTimeout = Math.max(60, params.completionTimeoutSeconds ?? 60 * 60);
  const slug = shellQuote(repoSlug);
  const wf = shellQuote(workflow);
  return [
    `echo "[deploy] waiting for new ${workflow} run to appear (prev id=$${prevIdVar})..."`,
    `__hf_new_start=$(date +%s)`,
    `${runIdVar}=""`,
    `while [ -z "$${runIdVar}" ]; do`,
    `  ${runIdVar}=$(gh run list --repo ${slug} --workflow ${wf} --limit 20 --json databaseId -q "[.[].databaseId | select(. > $${prevIdVar})] | max // empty")`,
    `  if [ -n "$${runIdVar}" ]; then break; fi`,
    `  __hf_now=$(date +%s)`,
    `  if [ $((__hf_now - __hf_new_start)) -ge ${newRunTimeout} ]; then`,
    `    echo "[deploy] timed out after ${newRunTimeout}s waiting for a new ${workflow} run (prev id=$${prevIdVar})" >&2; exit 1;`,
    `  fi`,
    `  sleep ${pollSeconds};`,
    `done`,
    `echo "[deploy] watching ${workflow} run id=$${runIdVar}"`,
    `__hf_wait_start=$(date +%s)`,
    `while :; do`,
    `  __hf_status=$(gh run view "$${runIdVar}" --repo ${slug} --json status -q '.status' 2>/dev/null || echo unknown)`,
    `  __hf_conclusion=$(gh run view "$${runIdVar}" --repo ${slug} --json conclusion -q '.conclusion' 2>/dev/null || echo '')`,
    `  echo "[deploy] run $${runIdVar} status=$__hf_status conclusion=$__hf_conclusion"`,
    `  if [ "$__hf_status" = "completed" ]; then`,
    `    if [ "$__hf_conclusion" = "success" ]; then`,
    `      echo "[deploy] ${workflow} run $${runIdVar} succeeded"; break;`,
    `    fi`,
    `    echo "[deploy] ${workflow} run $${runIdVar} ended with $__hf_conclusion" >&2; exit 1;`,
    `  fi`,
    `  __hf_now=$(date +%s)`,
    `  if [ $((__hf_now - __hf_wait_start)) -ge ${completionTimeout} ]; then`,
    `    echo "[deploy] timed out after ${completionTimeout}s waiting for ${workflow} run $${runIdVar}" >&2; exit 1;`,
    `  fi`,
    `  sleep ${pollSeconds};`,
    `done`,
  ].join("\n");
}

/**
 * Compose the deploy shell script for the given env. Each env dispatches ONLY
 * its matching workflow(s); `both` also gates prod behind the specific
 * pre-hotfix run we just dispatched (not "whatever the latest run is"), by
 * snapshotting the previous databaseId and waiting for the first higher id.
 * Throws on unknown env so a malformed state never silently picks the wrong
 * environment.
 */
export function buildDeployShellScript(env: HotfixCliEnv, targets: DeployTargets): string {
  const { repoSlug, preWorkflow, prodWorkflow, ref } = targets;
  const preRun = buildGhWorkflowRunCommand({
    repoSlug,
    workflow: preWorkflow,
    ref,
  });
  const prodRun = buildGhWorkflowRunCommand({
    repoSlug,
    workflow: prodWorkflow,
    ref,
  });

  switch (env) {
    case "pre":
      return `set -e\n${preRun}\n`;
    case "prod":
      return `set -e\n${prodRun}\n`;
    case "both": {
      const snapshot = buildGhRunListSnapshotLatestId({
        repoSlug,
        workflow: preWorkflow,
        prevIdVar: "__hf_prev",
      });
      const wait = buildGhWaitForNewAndCompleteRun({
        repoSlug,
        workflow: preWorkflow,
        prevIdVar: "__hf_prev",
        runIdVar: "__hf_id",
      });
      return ["set -e", snapshot, preRun, wait, prodRun, ""].join("\n");
    }
    default: {
      const exhaustive: never = env;
      throw new Error(`buildDeployShellScript: unsupported env ${String(exhaustive)}`);
    }
  }
}
