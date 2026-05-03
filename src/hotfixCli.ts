export type HotfixCliEnv = "pre" | "prod" | "both";

export type HotfixCliOptions = {
  env: HotfixCliEnv;
  draft: boolean;
  criticalFastTrack: boolean;
  /**
   * Extension-side flag: after the fcli-created hotfix PR is merged, dispatch
   * the matching arnac-io/workflows workflow(s). Not forwarded to fcli.
   */
  deploy: boolean;
};

/** `fcli workflows hotfix create-pull-request` flag segment (`--env`, optional `--draft`, `--critical-fast-track`). */
export function buildHotfixCliSuffix(opts: HotfixCliOptions): string {
  let s = opts.env === "both" ? "--env pre --env prod" : `--env ${opts.env}`;
  if (opts.draft) {
    s += " --draft";
  }
  if (opts.criticalFastTrack) {
    s += " --critical-fast-track";
  }
  return s;
}

export function normalizeHotfixCliOptions(
  partial: Partial<HotfixCliOptions> | undefined,
  defaults: HotfixCliOptions
): HotfixCliOptions {
  return {
    env:
      partial?.env === "prod"
        ? "prod"
        : partial?.env === "both"
          ? "both"
          : partial?.env === "pre"
            ? "pre"
            : defaults.env,
    draft: typeof partial?.draft === "boolean" ? partial.draft : defaults.draft,
    criticalFastTrack:
      typeof partial?.criticalFastTrack === "boolean"
        ? partial.criticalFastTrack
        : defaults.criticalFastTrack,
    deploy: typeof partial?.deploy === "boolean" ? partial.deploy : defaults.deploy,
  };
}
