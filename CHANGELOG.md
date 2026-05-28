# Changelog

All notable changes to the Fordefi Hotfix Watcher extension will be documented in this file.

## [0.1.2] - 2026-05-28

### Fixed

- Stop auto-injecting `-o json` into fcli commands (breaks older fcli builds)
- Lower `engines.vscode` to `^1.94.0` so the VSIX installs on current Cursor builds

## [0.1.0] - 2026-05-03

### Added

- Sidebar webview listing your recent PRs with checkbox selection
- Watch mode: poll selected PRs until all merged, then run configurable CLI
- Transparent mode (default): silent spawn with dual-fired notifications for YubiKey, conflicts, milestones
- Debug terminal mode: visible integrated terminal for interactive runs
- Deploy phase: watch hotfix PR merge, dispatch pre/prod/both workflows
- Pre→prod sequencing: dispatch pre, wait for success, then dispatch prod
- Managed git worktree for hotfix runs (keeps primary checkout clean)
- Doctor command: diagnostic report for fresh-install troubleshooting
- GitHub token chain: `gh auth token` → Secret Storage → settings → env
- macOS native notifications via `osascript` for deploy milestones
- Search: local title/number filter with debounced GitHub remote fallback
- Status filter (all/open/merged) and sort (open-first/newest) controls
