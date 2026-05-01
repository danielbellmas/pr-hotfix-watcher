import type { ChildProcess } from "node:child_process";

/**
 * Single-slot registries for the in-flight fcli child and deploy child. The
 * watch session reaches in to SIGTERM whichever is running when the user
 * presses Stop mid-phase. Module-singleton state is OK here because:
 *   1. The session model only ever runs one fcli AND at most one deploy
 *      script at a time (orchestrator awaits them sequentially).
 *   2. Tests that exercise the run modules do so via injected runners that
 *      don't touch this registry.
 */

type Slot = "fcli" | "deploy";

const slots = new Map<Slot, ChildProcess>();

export function registerActiveChild(slot: Slot, child: ChildProcess): void {
  slots.set(slot, child);
}

export function unregisterActiveChild(slot: Slot): void {
  slots.delete(slot);
}

export function getActiveChild(slot: Slot): ChildProcess | undefined {
  return slots.get(slot);
}

/**
 * Best-effort SIGTERM for the registered child, if any. Returns true iff a
 * child was present and `kill()` returned truthy. Never throws — the caller
 * is `stop()` and must remain idempotent on broken state.
 */
export function killActiveChild(slot: Slot): boolean {
  const child = slots.get(slot);
  if (!child) {
    return false;
  }
  slots.delete(slot);
  try {
    return child.kill("SIGTERM");
  } catch {
    return false;
  }
}

/** Test-only — wipe both slots so leaked refs don't bleed between tests. */
export function resetRunRegistryForTests(): void {
  slots.clear();
}
