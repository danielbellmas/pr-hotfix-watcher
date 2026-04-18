export type PrStatusFilter = "all" | "open" | "merged";

export type PrSortMode = "status" | "created";

export type PrListViewOptions = {
  statusFilter: PrStatusFilter;
  sortMode: PrSortMode;
};

const DEFAULT_PR_LIST_VIEW: PrListViewOptions = {
  statusFilter: "all",
  sortMode: "status",
};

export function normalizePrListViewOptions(
  partial: Partial<PrListViewOptions> | undefined,
  defaults: PrListViewOptions = DEFAULT_PR_LIST_VIEW
): PrListViewOptions {
  const sf = partial?.statusFilter;
  const statusFilter: PrStatusFilter =
    sf === "all" || sf === "open" || sf === "merged"
      ? sf
      : defaults.statusFilter;
  const sm = partial?.sortMode;
  const sortMode: PrSortMode =
    sm === "created" || sm === "status" ? sm : defaults.sortMode;
  return { statusFilter, sortMode };
}

export function matchesPrStatusFilter(
  row: { mergedAt: string | null },
  filter: PrStatusFilter
): boolean {
  if (filter === "all") {
    return true;
  }
  if (filter === "open") {
    return !row.mergedAt;
  }
  return Boolean(row.mergedAt);
}

function createdMs(row: { createdAt?: string }): number {
  if (!row.createdAt) {
    return 0;
  }
  const t = Date.parse(row.createdAt);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Apply status filter (selected PRs always stay visible), then sort.
 * `status`: open first, then merged; within each bucket newest `createdAt` first.
 * `created`: newest `createdAt` first.
 */
export function applyPrViewFilterSort<
  T extends { number: number; mergedAt: string | null; createdAt?: string }
>(
  rows: readonly T[],
  filter: PrStatusFilter,
  sort: PrSortMode,
  selected: ReadonlySet<number>
): T[] {
  const out = rows.filter(
    (r) => matchesPrStatusFilter(r, filter) || selected.has(r.number)
  );
  const createdKey = (r: T) => createdMs(r);
  if (sort === "created") {
    return [...out].sort(
      (a, b) => createdKey(b) - createdKey(a) || b.number - a.number
    );
  }
  return [...out].sort((a, b) => {
    const ao = a.mergedAt ? 1 : 0;
    const bo = b.mergedAt ? 1 : 0;
    if (ao !== bo) {
      return ao - bo;
    }
    return createdKey(b) - createdKey(a) || b.number - a.number;
  });
}
