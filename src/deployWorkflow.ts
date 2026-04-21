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
 * Shell snippet that waits for the most recent run of `workflow` (triggered by
 * the immediately preceding `gh workflow run`) to complete and exits non-zero
 * if its conclusion is not `success`. Uses a poll loop so it works on older
 * `gh` versions without relying on `gh run watch` semantics differing between
 * 2.x minor releases.
 */
export function buildGhRunWaitCommand(params: {
  repoSlug: string;
  workflow: string;
  /** Seconds between polls. */
  pollSeconds?: number;
  /** Max seconds to wait before failing the wait step. */
  timeoutSeconds?: number;
}): string {
  const pollSeconds = Math.max(5, params.pollSeconds ?? 15);
  const timeoutSeconds = Math.max(60, params.timeoutSeconds ?? 60 * 60);
  const slug = shellQuote(params.repoSlug);
  const wf = shellQuote(params.workflow);
  // Give Actions a moment to register the newly-dispatched run before polling.
  return [
    `echo "[deploy] waiting for ${params.workflow} run to complete..."`,
    `sleep 5`,
    `__hf_start=$(date +%s)`,
    `while :; do`,
    `  __hf_row=$(gh run list --repo ${slug} --workflow ${wf} --limit 1 --json databaseId,status,conclusion,htmlUrl -q '.[0]')`,
    `  __hf_status=$(printf %s "$__hf_row" | sed -n 's/.*"status":"\\([^"]*\\)".*/\\1/p')`,
    `  __hf_conclusion=$(printf %s "$__hf_row" | sed -n 's/.*"conclusion":"\\([^"]*\\)".*/\\1/p')`,
    `  __hf_url=$(printf %s "$__hf_row" | sed -n 's/.*"htmlUrl":"\\([^"]*\\)".*/\\1/p')`,
    `  echo "[deploy] status=$__hf_status conclusion=$__hf_conclusion $__hf_url"`,
    `  if [ "$__hf_status" = "completed" ]; then`,
    `    if [ "$__hf_conclusion" = "success" ]; then`,
    `      echo "[deploy] ${params.workflow} succeeded"; break;`,
    `    fi`,
    `    echo "[deploy] ${params.workflow} ended with $__hf_conclusion" >&2; exit 1;`,
    `  fi`,
    `  __hf_now=$(date +%s)`,
    `  if [ $((__hf_now - __hf_start)) -ge ${timeoutSeconds} ]; then`,
    `    echo "[deploy] timed out after ${timeoutSeconds}s waiting for ${params.workflow}" >&2; exit 1;`,
    `  fi`,
    `  sleep ${pollSeconds};`,
    `done`,
  ].join("\n");
}

/**
 * Compose the deploy shell script for the given env. Each env dispatches ONLY
 * its matching workflow(s); `both` also gates prod behind pre-hotfix success.
 * Throws on unknown env so a malformed state never silently picks the wrong
 * environment.
 */
export function buildDeployShellScript(
  env: HotfixCliEnv,
  targets: DeployTargets
): string {
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
  const waitPre = buildGhRunWaitCommand({ repoSlug, workflow: preWorkflow });

  switch (env) {
    case "pre":
      return `set -e\n${preRun}\n`;
    case "prod":
      return `set -e\n${prodRun}\n`;
    case "both":
      return `set -e\n${preRun}\n${waitPre}\n${prodRun}\n`;
    default: {
      const exhaustive: never = env;
      throw new Error(
        `buildDeployShellScript: unsupported env ${String(exhaustive)}`
      );
    }
  }
}
