/**
 * Re-entrancy guard for the hotfix watch-poll loop.
 *
 * The watch loop runs two concurrent schedulers: a direct `void pollOnce()`
 * call from `startWatch` to prime the UI, plus a `setInterval` tick. Under
 * slow network / slow `gh auth token` resolution those can overlap, which
 * without a guard would (a) hit the PR API twice per tick and (b) — much
 * worse — let both calls reach the "all merged" branch and dispatch the
 * hotfix CLI + deploy twice.
 *
 * The gate enforces two invariants:
 *   1. At most one poll body is executing at a time (`pollInFlight`).
 *   2. The "all merged" handler runs at most once per watch
 *      (`mergeHandled`, set by {@link PollContext.claimMerge}).
 *
 * `reset()` is called from `startWatch`/`stopWatch` when a new watch begins
 * or the current one is cancelled.
 */
export type PollContext = {
  /**
   * Atomically claim the merge-handoff slot. Returns `true` on the first
   * successful call per watch lifetime and `false` on every subsequent call
   * (including from a parallel poll body that already passed the `runPoll`
   * entry check). Callers must bail out when this returns `false`.
   */
  claimMerge: () => boolean;
};

export class MergeHandoffGate {
  private pollInFlight = false;
  private mergeHandled = false;

  reset(): void {
    this.pollInFlight = false;
    this.mergeHandled = false;
  }

  get hasHandledMerge(): boolean {
    return this.mergeHandled;
  }

  async runPoll(
    body: (ctx: PollContext) => Promise<void>
  ): Promise<boolean> {
    if (this.pollInFlight || this.mergeHandled) {
      return false;
    }
    this.pollInFlight = true;
    try {
      await body({
        claimMerge: () => {
          if (this.mergeHandled) {
            return false;
          }
          this.mergeHandled = true;
          return true;
        },
      });
      return true;
    } finally {
      this.pollInFlight = false;
    }
  }
}
