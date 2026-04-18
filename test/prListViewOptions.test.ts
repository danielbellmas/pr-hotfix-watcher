import { describe, expect, it } from "vitest";
import {
  applyPrViewFilterSort,
  matchesPrStatusFilter,
  normalizePrListViewOptions,
} from "../src/prListViewOptions";

const row = (
  n: number,
  merged: boolean,
  created: string,
): { number: number; mergedAt: string | null; createdAt: string } => ({
  number: n,
  mergedAt: merged ? "2024-01-02T00:00:00Z" : null,
  createdAt: created,
});

describe("normalizePrListViewOptions", () => {
  it("fills defaults", () => {
    expect(normalizePrListViewOptions(undefined)).toEqual({
      statusFilter: "all",
      sortMode: "status",
    });
  });
  it("accepts valid partials", () => {
    expect(normalizePrListViewOptions({ statusFilter: "open", sortMode: "created" })).toEqual({
      statusFilter: "open",
      sortMode: "created",
    });
  });

  it("preserves explicit all and status when defaults differ", () => {
    const altDefaults = { statusFilter: "open" as const, sortMode: "created" as const };
    expect(normalizePrListViewOptions({ statusFilter: "all" }, altDefaults)).toEqual({
      statusFilter: "all",
      sortMode: "created",
    });
    expect(normalizePrListViewOptions({ sortMode: "status" }, altDefaults)).toEqual({
      statusFilter: "open",
      sortMode: "status",
    });
  });

  it("rejects unknown statusFilter and sortMode strings", () => {
    const altDefaults = { statusFilter: "merged" as const, sortMode: "created" as const };
    // @ts-expect-error persisted garbage
    expect(normalizePrListViewOptions({ statusFilter: "nope" }, altDefaults)).toEqual(altDefaults);
    // @ts-expect-error persisted garbage
    expect(normalizePrListViewOptions({ sortMode: "newest" }, altDefaults)).toEqual(altDefaults);
  });
});

describe("matchesPrStatusFilter", () => {
  it("respects all / open / merged", () => {
    const open = row(1, false, "2024-01-01T00:00:00Z");
    const merged = row(2, true, "2024-01-01T00:00:00Z");
    expect(matchesPrStatusFilter(open, "all")).toBe(true);
    expect(matchesPrStatusFilter(open, "open")).toBe(true);
    expect(matchesPrStatusFilter(open, "merged")).toBe(false);
    expect(matchesPrStatusFilter(merged, "merged")).toBe(true);
    expect(matchesPrStatusFilter(merged, "open")).toBe(false);
  });
});

describe("applyPrViewFilterSort", () => {
  const r1 = row(1, false, "2024-01-01T00:00:00Z");
  const r2 = row(2, false, "2024-06-01T00:00:00Z");
  const r3 = row(3, true, "2024-03-01T00:00:00Z");
  const r4 = row(4, true, "2024-02-01T00:00:00Z");

  it("sort status: open before merged, then newest created", () => {
    const out = applyPrViewFilterSort([r3, r1, r4, r2], "all", "status", new Set());
    expect(out.map((r) => r.number)).toEqual([2, 1, 3, 4]);
  });

  it("sort created: newest first", () => {
    const out = applyPrViewFilterSort([r1, r2, r3], "all", "created", new Set());
    expect(out.map((r) => r.number)).toEqual([2, 3, 1]);
  });

  it("filter open keeps selected merged visible", () => {
    const out = applyPrViewFilterSort([r1, r2, r3], "open", "status", new Set([3]));
    expect(out.map((r) => r.number)).toEqual([2, 1, 3]);
  });

  it("filter merged hides open unless selected", () => {
    const out = applyPrViewFilterSort([r1, r2, r3], "merged", "created", new Set());
    expect(out.map((r) => r.number)).toEqual([3]);
  });

  it("filter merged keeps selected open row visible, then status sort (open before merged)", () => {
    const out = applyPrViewFilterSort([r1, r2, r3], "merged", "status", new Set([2]));
    expect(out.map((r) => r.number)).toEqual([2, 3]);
  });

  it("tie-breaks created sort by PR number descending", () => {
    const a = row(1, false, "2024-01-01T00:00:00Z");
    const b = row(2, false, "2024-01-01T00:00:00Z");
    expect(applyPrViewFilterSort([a, b], "all", "created", new Set()).map((r) => r.number)).toEqual([2, 1]);
  });

  it("invalid createdAt sorts as 0 but tie-break still orders", () => {
    const bad = { number: 5, mergedAt: null as string | null, createdAt: "not-a-date" };
    const good = row(6, false, "2024-06-01T00:00:00Z");
    expect(applyPrViewFilterSort([bad, good], "all", "created", new Set()).map((r) => r.number)).toEqual([6, 5]);
  });
});
