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
