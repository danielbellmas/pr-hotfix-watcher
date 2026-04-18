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
