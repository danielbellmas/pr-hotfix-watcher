/**
 * PR list filtering for the Hotfix webview: substring / `#` number match on the last refresh,
 * then merge checked PRs so selections stay visible when filtered or when using remote-only hits.
 */
export function filterPrRowsByQuery<
  T extends { number: number; title: string }
>(rows: readonly T[], trimmed: string): T[] {
  const q = trimmed.trim().toLowerCase();
  if (!q) {
    return [...rows];
  }
  const numOnly = q.replace(/^#/, "");
  const asNum = /^\d+$/.test(numOnly) ? Number.parseInt(numOnly, 10) : NaN;
  return rows.filter((r) => {
    if (!Number.isNaN(asNum) && r.number === asNum) {
      return true;
    }
    return r.title.toLowerCase().includes(q);
  });
}

export function mergeSelectedPrRows<T extends { number: number }>(
  base: readonly T[],
  lookup: readonly T[],
  selected: ReadonlySet<number> | readonly number[]
): T[] {
  const sel = selected instanceof Set ? selected : new Set(selected);
  const map = new Map<number, T>();
  for (const r of base) {
    map.set(r.number, r);
  }
  for (const n of sel) {
    if (!map.has(n)) {
      const found = lookup.find((r) => r.number === n);
      if (found) {
        map.set(n, found);
      }
    }
  }
  return [...map.values()].sort((a, b) => b.number - a.number);
}

export function buildDisplayPrRows<T extends { number: number; title: string }>(
  allRows: readonly T[],
  remoteRows: readonly T[],
  searchQuery: string,
  selected: ReadonlySet<number> | readonly number[]
): T[] {
  const trimmed = searchQuery.trim();
  if (!trimmed) {
    return mergeSelectedPrRows(allRows, allRows, selected);
  }
  const local = filterPrRowsByQuery(allRows, trimmed);
  const base = local.length > 0 ? local : remoteRows;
  return mergeSelectedPrRows(base, allRows, selected);
}
