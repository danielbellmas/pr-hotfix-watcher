# Fordefi Hotfix Watcher (VS Code)

Sidebar view that lists **your** recent pull requests in a GitHub repo, lets you **checkbox-select** several, **polls until all are merged**, then runs a **configurable shell command** once (defaults to `./fcli workflows hotfix create-pull-request …`).

## Requirements

- VS Code **1.85+** (tree checkboxes).
- A GitHub token with access to the target repo (`repo` scope for private repositories).
- A local clone of the monorepo where [`fcli`](https://github.com/arnac-io/arnac) (or your wrapper) exists; set **Repo root** to that directory.

## Setup

1. Install the extension (from `.vsix` or after publishing).
2. Open the **Explorer** side bar → **Hotfix PRs** view.
3. **Auth:** With **[GitHub CLI](https://cli.github.com/)** installed, run `gh auth login` in a terminal. The extension reads **`gh auth token`** first (same as `./fcli`). If `gh` is not on your `PATH` inside VS Code, use **“Hotfix: Set GitHub token”** to store a PAT override in Secret Storage.
4. Set **fordefiHotfix.repoRoot** to the absolute path of your git checkout (or open that folder as the workspace; an empty `repoRoot` uses the first workspace folder).
5. Optional: **“Hotfix: Set owner/repo from git remote”** sets `fordefiHotfix.owner` / `fordefiHotfix.repo` from `origin` (GitHub URLs only).

## Usage

1. Click **Refresh** to load your latest PRs (count from **fordefiHotfix.recentPrCount**).
2. Use **checkboxes** to choose PRs to batch.
3. **Start watching** — the extension polls until every selected PR has merged, then opens an integrated terminal and sends the configured command line.
4. **Stop** cancels polling.

**Add PR by number** includes a PR that is outside the recent list (it stays on the list until the next refresh removes it if it is no longer in the search window — manual numbers are merged into refresh).

## Settings

| ID | Default | Description |
|----|---------|-------------|
| `fordefiHotfix.owner` | `arnac-io` | GitHub owner |
| `fordefiHotfix.repo` | `arnac` | GitHub repo name |
| `fordefiHotfix.recentPrCount` | `20` | Latest PRs by update time (max 100) |
| `fordefiHotfix.pollIntervalSeconds` | `60` | Merge poll interval while watching |
| `fordefiHotfix.repoRoot` | `""` | Clone path (empty = first workspace folder) |
| `fordefiHotfix.commandTemplate` | see `package.json` | Must contain `{prNumbers}`. Also: `{repoRoot}`, `{prList}`, `{owner}`, `{repo}` |
| `fordefiHotfix.githubPat` | `""` | Optional PAT if `gh` is not used |
| `fordefiHotfix.ghPath` | `""` | Full path to `gh` if VS Code’s `PATH` does not include it (common on macOS when Code is opened from the Dock) |

Token resolution order: **`gh auth token`** (see `fordefiHotfix.ghPath`) → **Secret Storage** (“Hotfix: Set GitHub token”) → `fordefiHotfix.githubPat` → process env `GITHUB_ACCESS_TOKEN`.

If you see **401 Bad credentials**: run `gh auth status` in a terminal. Prefer fixing **`gh`** (login or `fordefiHotfix.ghPath`) so the extension uses the same token as the CLI. If you previously saved a bad PAT in VS Code, run **Hotfix: Clear stored GitHub token (use gh CLI again)** or remove `fordefiHotfix.githubPat` from settings.

## Command template

Example including pre environment:

```text
cd {repoRoot} && ./fcli workflows hotfix create-pull-request {prNumbers} --env pre
```

`{prNumbers}` is sorted ascending, space-separated. The underlying CLI still enforces merged PRs, Jira tickets in titles, etc.

### `-o json` and the deploy phase

The bundled `fcli` accepts `--output json` (alias `-o json`). In JSON mode the
human-readable output goes to stderr, no browser opens, and a single JSON line
is written to stdout describing every hotfix PR that was created:

```json
{ "prs": [ { "environment": "pre", "pr_number": 123, "html_url": "…", "release_branch": "…", "hotfix_branch": "…", "draft": false } ], "source_pr_numbers": [42] }
```

The watcher prefers this payload when it is present and falls back to the
legacy `HOTFIX_PR_URL=…` line (then to a manual prompt) otherwise. Adding
`-o json` to the **commandTemplate** is the recommended setup, and is required
for the pre→prod sequencing described below:

```text
cd {repoRoot} && ./fcli workflows hotfix create-pull-request {prNumbers} --env pre --env prod -o json
```

When the deploy toggle is on and the user picked **both** environments:

- With `-o json`: the watcher watches the pre hotfix PR until it merges, runs
  the pre deploy workflow, then watches the prod hotfix PR until it merges,
  then runs the prod deploy workflow.
- Without `-o json` (regex fallback): only one PR URL is recoverable, so the
  watcher watches that single PR and dispatches the chained pre→prod deploy
  script in one shot (legacy behavior).

## Deploy-finished notification (macOS)

When a hotfix deploy finishes, the extension fires a native macOS Notification Center banner in addition to the in-VS-Code toast — so you get a heads-up even when VS Code is in the background. One ping per `runHotfixDeploy` resolution:

- **Hotfix deploy succeeded** — exit 0.
- **Hotfix deploy FAILED** — non-zero exit (`exit N` in the subtitle).
- **Hotfix deploy finished** — terminal mode without shell integration reporting (subtitle: `exit unknown`).
- **Hotfix deploy stopped** — process killed (signal in the subtitle, e.g. `SIGTERM`).
- **Hotfix deploy did not start** — `spawn` failure before the deploy script ran.

The body lists the source PR numbers you batched (e.g. `PRs: #123, #124`) so a stale notification still identifies the run.

The pings are delivered via `osascript -e 'display notification …'`. The first time it runs on a fresh Mac, macOS shows a permission dialog asking whether **Script Editor** can post notifications — accept it, otherwise the first ping is silently dropped (subsequent ones work). To mute later: System Settings → Notifications → Script Editor. On non-macOS the notification is a no-op; the existing VS Code toasts still fire.

Failures of the notifier itself (e.g. `osascript` missing) are logged to the **Fordefi Hotfix Deploy** output channel and never surfaced as a toast.

## Managed hotfix worktree

To keep your primary `arnac` checkout free while the CLI runs, the extension automatically runs the hotfix command inside a dedicated **git worktree** it creates as a sibling of your `repoRoot`:

```text
<repoRoot>-hotfix-worktree
```

e.g. if `repoRoot = /Users/you/go/src/arnac` the worktree lives at `/Users/you/go/src/arnac-hotfix-worktree`. It's kept next to `arnac` on purpose: the same `direnv` layer and any paths relative to the monorepo parent still work.

Behavior:

- **Created on first run** via `git worktree add -B hotfix-worktree <repoRoot>-hotfix-worktree origin/<default-branch>`. The dedicated `hotfix-worktree` branch is required because `fcli` reads `repo.active_branch.name` (gitpython) and a detached HEAD makes it raise `TypeError: HEAD is a detached symbolic reference`. You'll see a one-time toast with the path plus a reminder to touch your YubiKey when the integrated terminal prompts.
- **Reused as-is on every subsequent run.** The extension does not auto-fetch, auto-reset, or otherwise touch the worktree — that's intentional so nothing silently mutates between runs. If the worktree ever gets into a bad state (e.g. detached HEAD from an older version of this extension), fix it manually once: `git -C <repoRoot>-hotfix-worktree checkout -B hotfix-worktree`. To wipe and recreate from scratch, use the cleanup commands lower in this section.
- The integrated terminal still opens normally, so YubiKey and any `[y/n]` prompts work exactly as before; only the working directory changes.
- If `git` is missing, the directory isn't a repo, or `git worktree add` fails, the extension falls back to running in `repoRoot` and logs the reason (`[worktree] fallback: …`) to the **Fordefi Hotfix CLI** output channel.

First-time setup note: because the worktree is a new directory, you will need to run `direnv allow` in it once so `./fcli` gets its environment:

```bash
cd <repoRoot>-hotfix-worktree
direnv allow
```

To refresh the worktree to the latest default branch:

```bash
cd <repoRoot>-hotfix-worktree
git fetch origin && git reset --hard origin/main
```

To fully reset it, delete the directory and let the next run recreate it:

```bash
git -C <repoRoot> worktree remove <repoRoot>-hotfix-worktree
# or, if git complains:
rm -rf <repoRoot>-hotfix-worktree
git -C <repoRoot> worktree prune
```

## `direnv` / `fcli`

The wrapper script typically runs `direnv exec . python …` when not already in a direnv-loaded shell. Open VS Code from a directory where direnv is applied, use a direnv VS Code extension, or bake `direnv exec .` into **commandTemplate**.

## Development

Sources live under `~/scripts/fordefi-hotfix-watcher`:

```bash
cd ~/scripts/fordefi-hotfix-watcher
npm install
npm run compile
```

Press F5 in VS Code with this folder opened to launch an **Extension Development Host**.

## Packaging & publish

```bash
npm run compile
npx vsce package
# optional
npx ovsx publish *.vsix --pat $OPENVSX_TOKEN
```

Use your own `publisher` in `package.json` before publishing to the Marketplace or Open VSX. The Marketplace expects a **128×128 PNG** icon; this repo ships `media/icon.svg` for branding only (omit `icon` in `package.json` until you add a PNG).

## CI

If you initialize this folder as its own git repository, `.github/workflows/ci.yml` compiles the extension on push/pull request and uploads a `.vsix` build artifact.
