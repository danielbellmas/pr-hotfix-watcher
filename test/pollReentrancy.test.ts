import { describe, expect, it } from "vitest";
import { MergeHandoffGate } from "../src/watchPollGuard";

/** Resolve on the next microtask turn — cheap way to simulate an await. */
const tick = (): Promise<void> => Promise.resolve();

describe("MergeHandoffGate", () => {
  it("serializes overlapping polls: only one body runs at a time", async () => {
    const gate = new MergeHandoffGate();
    let currentlyInside = 0;
    let maxInside = 0;
    const body = async (): Promise<void> => {
      currentlyInside++;
      maxInside = Math.max(maxInside, currentlyInside);
      await tick();
      currentlyInside--;
    };
    // Two near-simultaneous scheduler ticks (start-immediate + setInterval).
    await Promise.all([gate.runPoll(body), gate.runPoll(body)]);
    expect(maxInside).toBe(1);
  });

  it("skips `runPoll` when another body is already in flight", async () => {
    const gate = new MergeHandoffGate();
    let started = 0;
    const never = new Promise<void>(() => undefined);
    const first = gate.runPoll(async () => {
      started++;
      await never;
    });
    // Let the first body claim `pollInFlight`.
    await tick();
    const second = await gate.runPoll(async () => {
      started++;
    });
    expect(started).toBe(1);
    expect(second).toBe(false);
    // Don't await `first` — it hangs intentionally to keep the gate busy.
    void first;
  });

  it("claimMerge returns true exactly once even under concurrent polls", async () => {
    const gate = new MergeHandoffGate();
    let mergeDispatches = 0;
    const body = async ({
      claimMerge,
    }: {
      claimMerge: () => boolean;
    }): Promise<void> => {
      // Simulate the watch-poll body doing network I/O before the merge branch.
      await tick();
      await tick();
      if (!claimMerge()) {
        return;
      }
      // Another simulated await between claim and actual handoff.
      await tick();
      mergeDispatches++;
    };
    await Promise.all([
      gate.runPoll(body),
      gate.runPoll(body),
      gate.runPoll(body),
    ]);
    expect(mergeDispatches).toBe(1);
    expect(gate.hasHandledMerge).toBe(true);
  });

  it("does not set mergeHandled when a poll returns without claiming", async () => {
    const gate = new MergeHandoffGate();
    let polls = 0;
    const body = async (): Promise<void> => {
      polls++;
      // No claim — simulate the "continue" branch.
      await tick();
    };
    await gate.runPoll(body);
    await gate.runPoll(body);
    expect(polls).toBe(2);
    expect(gate.hasHandledMerge).toBe(false);
  });

  it("refuses further polls once the merge has been handled", async () => {
    const gate = new MergeHandoffGate();
    let dispatches = 0;
    await gate.runPoll(async ({ claimMerge }) => {
      if (claimMerge()) {
        dispatches++;
      }
    });
    // A later interval tick arriving after deploy has been dispatched must
    // not re-enter the body.
    let secondRan = false;
    const ran = await gate.runPoll(async () => {
      secondRan = true;
    });
    expect(ran).toBe(false);
    expect(secondRan).toBe(false);
    expect(dispatches).toBe(1);
  });

  it("reset() re-opens the gate for the next startWatch cycle", async () => {
    const gate = new MergeHandoffGate();
    await gate.runPoll(async ({ claimMerge }) => {
      claimMerge();
    });
    expect(gate.hasHandledMerge).toBe(true);
    gate.reset();
    expect(gate.hasHandledMerge).toBe(false);
    let ran = 0;
    await gate.runPoll(async () => {
      ran++;
    });
    expect(ran).toBe(1);
  });

  it("releases `pollInFlight` even when the body throws", async () => {
    const gate = new MergeHandoffGate();
    await expect(
      gate.runPoll(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    // Next poll must be allowed even after the failure.
    let ran = false;
    await gate.runPoll(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
