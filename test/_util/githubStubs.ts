import { vi } from "vitest";
import type { GitHubPull, SearchIssueItem } from "../../src/githubClient";

export type PullStub = Partial<GitHubPull> & Pick<GitHubPull, "number">;

export function buildPull(partial: PullStub): GitHubPull {
  return {
    number: partial.number,
    title: partial.title ?? `PR #${partial.number}`,
    state: partial.state ?? "open",
    merged_at: partial.merged_at ?? null,
    created_at: partial.created_at ?? "2026-04-22T10:00:00Z",
    html_url:
      partial.html_url ?? `https://github.com/acme/app/pull/${partial.number}`,
  };
}

export function buildSearchItem(partial: PullStub): SearchIssueItem {
  return {
    number: partial.number,
    title: partial.title ?? `PR #${partial.number}`,
    state: partial.state ?? "open",
    created_at: partial.created_at ?? "2026-04-22T10:00:00Z",
    pull_request: { merged_at: partial.merged_at ?? null },
    html_url:
      partial.html_url ?? `https://github.com/acme/app/pull/${partial.number}`,
  };
}

export type ScriptEntry =
  | { status?: number; body?: unknown }
  | "network_error";

export type FetchScript = Record<string, ScriptEntry[]>;

/**
 * Build a fetch stub that returns scripted responses per GitHub API path.
 *
 * - Path key is the part after `https://api.github.com` with the query stripped
 *   (e.g. `/repos/acme/app/pulls/100` or `/search/issues`).
 * - Each call shifts one entry off the path's queue; when only one entry
 *   remains it is reused indefinitely, so tests can express
 *   `[open, merged]` meaning "first poll open, every subsequent poll merged".
 * - Unknown paths return HTTP 500 with `{ message: "unscripted ..." }` so
 *   missing stubs fail loudly rather than silently succeeding.
 */
export function makeFetchStub(
  script: FetchScript
): ReturnType<typeof vi.fn> & typeof fetch {
  const queues = new Map<string, ScriptEntry[]>();
  for (const [k, v] of Object.entries(script)) {
    queues.set(k, [...v]);
  }
  const fn = vi.fn(async (input: unknown): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url?: string }).url ?? String(input);
    const path = url
      .replace(/^https?:\/\/api\.github\.com/, "")
      .split("?")[0];
    const queue = queues.get(path);
    if (!queue || queue.length === 0) {
      return new Response(
        JSON.stringify({ message: `unscripted ${path}` }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next === "network_error") {
      throw new TypeError("network error");
    }
    const status = next.status ?? 200;
    const body = next.body ?? {};
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  return fn as ReturnType<typeof vi.fn> & typeof fetch;
}

export function pullPath(owner: string, repo: string, n: number): string {
  return `/repos/${owner}/${repo}/pulls/${n}`;
}
