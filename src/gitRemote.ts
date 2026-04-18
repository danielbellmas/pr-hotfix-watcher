import * as cp from "node:child_process";

export function parseGitHubRepoFromRemote(
  url: string
): { owner: string; repo: string } | undefined {
  const trimmed = url.trim();
  if (!trimmed) {
    return undefined;
  }
  let path = trimmed;
  if (path.startsWith("git@github.com:")) {
    path = path.slice("git@github.com:".length);
  } else if (path.startsWith("ssh://git@github.com/")) {
    path = path.slice("ssh://git@github.com/".length);
  } else {
    try {
      const u = new URL(trimmed);
      if (u.hostname !== "github.com") {
        return undefined;
      }
      const raw = u.pathname.replace(/^\//, "").replace(/\.git$/i, "");
      if (!raw) {
        return undefined;
      }
      path = raw;
    } catch {
      return undefined;
    }
  }
  path = path.replace(/\.git$/i, "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) {
    return undefined;
  }
  return { owner, repo };
}

export function readOriginRemote(repoRoot: string): string | undefined {
  try {
    return cp
      .execSync("git remote get-url origin", {
        cwd: repoRoot,
        encoding: "utf8",
      })
      .trim();
  } catch {
    return undefined;
  }
}
