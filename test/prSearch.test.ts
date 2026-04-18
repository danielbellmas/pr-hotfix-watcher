import { describe, expect, it } from "vitest";
import { buildDisplayPrRows, filterPrRowsByQuery, mergeSelectedPrRows } from "../src/prSearch";

const rows = [
  { number: 10, title: "Fix hotfix pipeline" },
  { number: 2, title: "Docs only" },
  { number: 99, title: "HOTFIX: urgent" },
];

describe("filterPrRowsByQuery", () => {
  it("returns all rows for empty query", () => {
    expect(filterPrRowsByQuery(rows, "")).toEqual(rows);
    expect(filterPrRowsByQuery(rows, "   ")).toEqual(rows);
  });

  it("matches title substring case-insensitively", () => {
    expect(filterPrRowsByQuery(rows, "hotfix").map((r) => r.number)).toEqual([10, 99]);
    expect(filterPrRowsByQuery(rows, "urgent").map((r) => r.number)).toEqual([99]);
  });

  it("matches exact PR number", () => {
    expect(filterPrRowsByQuery(rows, "2")).toEqual([rows[1]]);
    expect(filterPrRowsByQuery(rows, "#10")).toEqual([rows[0]]);
  });

  it("does not match PR 10 when searching for PR 1 via #1", () => {
    const withOne = [
      { number: 1, title: "Alpha" },
      { number: 10, title: "Beta" },
    ];
    expect(filterPrRowsByQuery(withOne, "#1").map((r) => r.number)).toEqual([1]);
  });

  it("returns empty when nothing matches", () => {
    expect(filterPrRowsByQuery(rows, "zzz")).toEqual([]);
  });
});

describe("mergeSelectedPrRows", () => {
  it("dedupes by PR number and sorts descending", () => {
    const base = [rows[0], rows[0]];
    const out = mergeSelectedPrRows(base, rows, new Set<number>());
    expect(out.map((r) => r.number)).toEqual([10]);
  });

  it("appends selected rows from lookup when missing from base", () => {
    const base = [{ number: 1, title: "Remote only" }];
    const lookup = [...rows];
    const out = mergeSelectedPrRows(base, lookup, new Set([2, 99]));
    expect(out.map((r) => r.number)).toEqual([99, 2, 1]);
  });

  it("ignores selected numbers not present in lookup", () => {
    const out = mergeSelectedPrRows([rows[0]], rows, new Set([10, 999]));
    expect(out.map((r) => r.number)).toEqual([10]);
  });
});

describe("buildDisplayPrRows", () => {
  const remote = [{ number: 50, title: "From API" }];

  it("shows all rows when query empty (with selected merge)", () => {
    const out = buildDisplayPrRows(rows, remote, "", new Set([2]));
    expect(out.map((r) => r.number)).toEqual([99, 10, 2]);
  });

  it("when query empty and nothing selected, sorts by PR number descending", () => {
    const out = buildDisplayPrRows(rows, remote, "", new Set<number>());
    expect(out.map((r) => r.number)).toEqual([99, 10, 2]);
    expect(out).toEqual([rows[2], rows[0], rows[1]]);
  });

  it("prefers local matches over remote rows", () => {
    const out = buildDisplayPrRows(rows, remote, "docs", new Set<number>());
    expect(out.map((r) => r.number)).toEqual([2]);
  });

  it("uses remote when local has no hits", () => {
    const out = buildDisplayPrRows(rows, remote, "nope", new Set<number>());
    expect(out).toEqual([remote[0]]);
  });

  it("keeps checked PRs visible when they do not match filter (local path)", () => {
    const out = buildDisplayPrRows(rows, remote, "docs", new Set([99]));
    expect(out.map((r) => r.number)).toEqual([99, 2]);
  });

  it("keeps checked PRs visible when they do not match filter (remote path)", () => {
    const out = buildDisplayPrRows(rows, remote, "nope", new Set([2]));
    expect(out.map((r) => r.number)).toEqual([50, 2]);
  });
});
