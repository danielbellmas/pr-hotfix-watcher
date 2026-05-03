/**
 * Run mode for the post-merge hotfix command.
 *
 * - `transparent` (new default): spawn the child without a visible terminal,
 *   stream output to a hidden output channel, surface YubiKey / conflict /
 *   `[y/n]` prompts as dual-fired notifications. The user-facing toggle is the
 *   `fordefiHotfix.debugTerminal` setting (false → transparent).
 * - `integratedTerminal`: the original visible-terminal flow, kept as the
 *   debug escape hatch (`debugTerminal: true`). YubiKey and `[y/n]` prompts
 *   are visible in the terminal exactly as before.
 * - `background`: legacy spawn mode without prompt detection. Retained as a
 *   value purely for back-compat with users who set
 *   `fordefiHotfix.hotfixRunMode: "background"` in older versions; treated
 *   identically to `transparent` everywhere we branch on the mode.
 */
export type HotfixRunMode = "integratedTerminal" | "background" | "transparent";

export function parseHotfixRunMode(raw: string | undefined): HotfixRunMode {
  if (raw === "integratedTerminal") return "integratedTerminal";
  if (raw === "background") return "background";
  return "transparent";
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
const ESC = String.fromCharCode(0x1b);
const ANSI_SGR = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, "g");

function stripAnsi(s: string): string {
  return s.replace(ANSI_SGR, "");
}

const HOTFIX_PR_URL_RE = /HOTFIX_PR_URL\s*=\s*(https?:\/\/github\.com\/[^\s"'<>]+?\/pull\/\d+)/i;

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
  const m = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i.exec(url.trim());
  if (!m) {
    return undefined;
  }
  const [, owner, repo] = m;
  const prNumber = Number(m[3]);
  if (!owner || !repo || !Number.isInteger(prNumber) || prNumber <= 0) {
    return undefined;
  }
  return { owner, repo, prNumber };
}

/**
 * One hotfix PR entry from the `--output json` payload of
 * `fcli workflows hotfix create-pull-request`. Only fields the watcher
 * actually consumes are typed; unknown fields are tolerated.
 */
export type HotfixPrEntry = {
  /** Mapped from JSON `environment` ("pre" | "prod"). */
  env: "pre" | "prod";
  /** PR number on the target service repo. */
  prNumber: number;
  /** Full GitHub PR URL (so callers can reuse {@link parseGithubPullUrl} for owner/repo). */
  htmlUrl: string;
  releaseBranch?: string;
  hotfixBranch?: string;
  draft?: boolean;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function coerceHotfixPrEntry(raw: unknown): HotfixPrEntry | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }
  const envRaw = raw["environment"];
  const envStr = typeof envRaw === "string" ? envRaw.trim().toLowerCase() : undefined;
  if (envStr !== "pre" && envStr !== "prod") {
    return undefined;
  }
  const htmlUrlRaw = raw["html_url"];
  const htmlUrl = typeof htmlUrlRaw === "string" ? htmlUrlRaw.trim() : "";
  if (!htmlUrl) {
    return undefined;
  }
  const prNumberRaw = raw["pr_number"];
  const prNumber =
    typeof prNumberRaw === "number" && Number.isInteger(prNumberRaw)
      ? prNumberRaw
      : Number(prNumberRaw);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return undefined;
  }
  const releaseBranch = raw["release_branch"];
  const hotfixBranch = raw["hotfix_branch"];
  const draft = raw["draft"];
  return {
    env: envStr,
    prNumber,
    htmlUrl,
    releaseBranch: typeof releaseBranch === "string" ? releaseBranch : undefined,
    hotfixBranch: typeof hotfixBranch === "string" ? hotfixBranch : undefined,
    draft: typeof draft === "boolean" ? draft : undefined,
  };
}

/**
 * Parse the JSON payload emitted by `fcli ... hotfix create-pull-request -o json`.
 * The script writes a single JSON line to stdout (rich console goes to stderr in
 * JSON mode), but our captured `output` may interleave both streams. Strategy:
 * scan lines bottom-up for the newest object that looks like the hotfix
 * payload (`{ "prs": [...] }`) so trailing log noise can't mask it.
 *
 * Returns `undefined` when no parseable payload found (caller falls back to the
 * legacy `HOTFIX_PR_URL=...` regex).
 */
export function parseHotfixCliJson(output: string): HotfixPrEntry[] | undefined {
  if (!output) {
    return undefined;
  }
  const cleaned = stripAnsi(output).replace(/\r\n/g, "\n");
  const lines = cleaned.split("\n");
  for (const raw of [...lines].reverse()) {
    const line = raw.trim();
    if (!line.startsWith("{") || !line.endsWith("}")) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(parsed)) {
      continue;
    }
    const prsRaw = parsed["prs"];
    if (!Array.isArray(prsRaw)) {
      continue;
    }
    const entries: HotfixPrEntry[] = [];
    for (const item of prsRaw) {
      const entry = coerceHotfixPrEntry(item);
      if (entry) {
        entries.push(entry);
      }
    }
    if (entries.length === 0) {
      continue;
    }
    return entries;
  }
  return undefined;
}
