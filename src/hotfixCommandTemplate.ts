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
  const expanded = template
    .replaceAll("{repoRoot}", p.repoRoot)
    .replaceAll("{prNumbers}", prNumbersStr)
    .replaceAll("{prList}", prListStr)
    .replaceAll("{owner}", p.owner)
    .replaceAll("{repo}", p.repo)
    .replaceAll("{hotfixSuffix}", p.hotfixSuffix);
  return ensureJsonOutputFlag(expanded);
}

const HAS_OUTPUT_JSON_FLAG = /(?:^|\s)(?:-o(?:\s+|=)json|--output(?:\s+|=)json)\b/i;
const FCLI_HOTFIX_INVOCATION =
  /(\.?\/?fcli\b[^&|;\n]*\bhotfix\b[^&|;\n]*\bcreate-pull-request\b[^&|;\n]*?)(\s*)(?=$|[&|;\n])/i;

/**
 * Ensure the fcli `hotfix create-pull-request` invocation includes
 * `-o json`. Transparent mode relies on the JSON payload (one entry per
 * environment) for accurate pre→prod chaining and for the "Hotfix PR(s)
 * created" milestone notification — without it, only the first PR URL is
 * captured by the regex fallback.
 *
 * Idempotent: if the flag is already present anywhere in the matched
 * invocation it returns the input unchanged. Non-fcli or already-suffixed
 * commands flow through without modification so the function stays safe to
 * call unconditionally.
 *
 * Exported separately so tests can exercise it without the placeholder
 * pipeline.
 */
export function ensureJsonOutputFlag(command: string): string {
  if (!command.includes("create-pull-request")) {
    return command;
  }
  const m = FCLI_HOTFIX_INVOCATION.exec(command);
  if (!m) {
    return command;
  }
  const invocation = m[1];
  if (HAS_OUTPUT_JSON_FLAG.test(invocation)) {
    return command;
  }
  const start = m.index;
  const end = start + invocation.length;
  const trailingWs = m[2] ?? "";
  return (
    command.slice(0, start) +
    invocation.replace(/\s+$/, "") +
    " -o json" +
    trailingWs +
    command.slice(end + trailingWs.length)
  );
}
