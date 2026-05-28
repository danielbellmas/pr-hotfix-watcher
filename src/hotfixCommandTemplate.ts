export type HotfixCommandPlaceholders = {
  repoRoot: string;
  owner: string;
  repo: string;
  prNumbers: number[];
  hotfixSuffix: string;
};

export function expandHotfixCommandTemplate(
  template: string,
  p: HotfixCommandPlaceholders
): string {
  if (!template.includes("{prNumbers}")) {
    throw new Error("fordefiHotfix.commandTemplate must contain {prNumbers}");
  }
  const sorted = [...p.prNumbers].sort((a, b) => a - b);
  const prNumbersStr = sorted.join(" ");
  const prListStr = sorted.join(",");
  return template
    .replaceAll("{repoRoot}", p.repoRoot)
    .replaceAll("{prNumbers}", prNumbersStr)
    .replaceAll("{prList}", prListStr)
    .replaceAll("{owner}", p.owner)
    .replaceAll("{repo}", p.repo)
    .replaceAll("{hotfixSuffix}", p.hotfixSuffix);
}
