import * as cp from "node:child_process";

/**
 * Detect whether the current user has yubikey-agent (or a comparable
 * touch-on-behalf agent) running. Used by transparent mode to suppress the
 * "touch your YubiKey" notification for users whose agent auto-touches.
 *
 * Detection is deliberately conservative: a positive result requires *some*
 * positive evidence, never a guess. False negatives (notify when agent does
 * exist) are acceptable; false positives (silently swallow a touch prompt the
 * user actually has to act on) are not.
 *
 * The result is cached for the extension session — yubikey-agent state
 * doesn't change while VS Code is running in any realistic flow, and the
 * `pgrep` fallback shells out which we don't want on every prompt scan.
 */

export type YubikeyAgentProbe = {
  /** Reads `process.env`. */
  envSshAuthSock: () => string | undefined;
  /** Returns true iff `pgrep -x yubikey-agent` exits 0 within `timeoutMs`. */
  pgrepYubikeyAgent: (timeoutMs: number) => boolean;
};

const DEFAULT_PGREP_TIMEOUT_MS = 800;

/** Pure detection from probe inputs — easy to unit-test. */
export function detectYubikeyAgentFromProbe(probe: YubikeyAgentProbe): boolean {
  const sock = probe.envSshAuthSock();
  if (sock && /yubikey-agent/i.test(sock)) {
    return true;
  }
  return probe.pgrepYubikeyAgent(DEFAULT_PGREP_TIMEOUT_MS);
}

let cached: boolean | undefined;

/**
 * Cached, side-effecting wrapper. Call once per session; subsequent calls
 * return the same answer without re-shelling.
 */
export function isYubikeyAgentRunning(): boolean {
  if (cached !== undefined) {
    return cached;
  }
  cached = detectYubikeyAgentFromProbe({
    envSshAuthSock: () => process.env.SSH_AUTH_SOCK,
    pgrepYubikeyAgent: (timeoutMs) => {
      try {
        const r = cp.spawnSync("pgrep", ["-x", "yubikey-agent"], {
          timeout: timeoutMs,
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        });
        return r.status === 0;
      } catch {
        return false;
      }
    },
  });
  return cached;
}

/** Test-only: forget the cached answer so probes can be re-evaluated. */
export function resetYubikeyAgentCacheForTests(): void {
  cached = undefined;
}
