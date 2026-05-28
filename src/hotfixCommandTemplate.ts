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

const FCLI_HOTFIX_INVOCATION =
  /(\.?\/?fcli\b[^&|;\n]*\bhotfix\b[^&|;\n]*\bcreate-pull-request\b[^&|;\n]*?)(\s*)(?=$|[&|;\n])/i;
const JSON_OUTPUT_FLAG = /\s+(?:-o(?:\s+|=)json|--output(?:\s+|=)json)\b/gi;
const HAS_JSON_OUTPUT_FLAG = /(?:^|\s)(?:-o(?:\s+|=)json|--output(?:\s+|=)json)\b/i;

/**
 * Remove `-o json` / `--output json` from an fcli `hotfix create-pull-request`
 * invocation. Most fcli builds still reject the flag; enable
 * `fordefiHotfix.fcliJsonOutput` when yours supports it.
 */
export function stripFcliJsonOutputFlag(command: string): string {
  if (!command.includes("create-pull-request")) {
    return command;
  }
  const m = FCLI_HOTFIX_INVOCATION.exec(command);
  if (!m) {
    return command;
  }
  const invocation = m[1] ?? "";
  if (!HAS_JSON_OUTPUT_FLAG.test(invocation)) {
    return command;
  }
  const stripped = invocation.replace(JSON_OUTPUT_FLAG, "").replace(/[ \t]+$/, "");
  const start = m.index;
  const end = start + invocation.length;
  const trailingWs = m[2] ?? "";
  return command.slice(0, start) + stripped + trailingWs + command.slice(end + trailingWs.length);
}
