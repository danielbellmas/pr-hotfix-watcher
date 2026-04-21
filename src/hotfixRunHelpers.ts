export type HotfixRunMode = "integratedTerminal" | "background";

export function parseHotfixRunMode(raw: string | undefined): HotfixRunMode {
  return raw === "background" ? "background" : "integratedTerminal";
}

/** Last segment of text for short error toasts (single line-ish). */
export function truncateRunLogTail(s: string, maxChars: number): string {
  const t = s.replace(/\r\n/g, "\n").trim();
  if (t.length <= maxChars) {
    return t.replace(/\s+/g, " ").trim();
  }
  return ("…" + t.slice(-maxChars)).replace(/\s+/g, " ").trim();
}

export function formatPrLabels(prNumbers: readonly number[]): string {
  return prNumbers.map((n) => `#${n}`).join(", ");
}

/** Strip ANSI SGR escape sequences so `HOTFIX_PR_URL=` still parses when fcli colors output. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

const HOTFIX_PR_URL_RE =
  /HOTFIX_PR_URL\s*=\s*(https?:\/\/github\.com\/[^\s"'<>]+?\/pull\/\d+)/i;

/**
 * Parse the `HOTFIX_PR_URL=<url>` line emitted by the arnac fcli hotfix script.
 * Returns the last match found (fcli prints once, but tests may include noise after).
 */
export function parseHotfixPrUrl(output: string): string | undefined {
  if (!output) {
    return undefined;
  }
  const cleaned = stripAnsi(output).replace(/\r\n/g, "\n");
  let last: string | undefined;
  const re = new RegExp(HOTFIX_PR_URL_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    last = m[1];
  }
  return last;
}

export type ParsedPrUrl = {
  owner: string;
  repo: string;
  prNumber: number;
};

/** Split a GitHub pull-request URL (e.g. https://github.com/arnac-io/arnac/pull/123) into owner/repo/prNumber. */
export function parseGithubPullUrl(url: string): ParsedPrUrl | undefined {
  const m = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i.exec(
    url.trim()
  );
  if (!m) {
    return undefined;
  }
  const prNumber = Number(m[3]);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return undefined;
  }
  return { owner: m[1], repo: m[2], prNumber };
}
