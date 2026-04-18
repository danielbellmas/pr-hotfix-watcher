# Option A: Load the extension (with pictures)

## Step 1 — Open the extension project folder

Use **File → Open Folder…** (macOS: **File → Open Folder…**) and choose:

`~/scripts/fordefi-hotfix-watcher`

![Step 1: Open Folder](hotfix-ext-step1-open-folder.png)

---

## Step 2 — Start the Extension Development Host

Use **Run → Start Debugging**, or press **F5**.

If VS Code asks for a launch configuration, pick **Run Extension**.

![Step 2: Start Debugging / F5](hotfix-ext-step2-f5-debug.png)

A **second** VS Code window opens. Its title bar usually includes **`[Extension Development Host]`**.  
All remaining steps happen in **that** window—not the first one.

---

## Step 3 — Open your real repo and show “Hotfix PRs”

In the **[Extension Development Host]** window:

1. **File → Open Folder…** again, and open your **clone of the monorepo** (where `./fcli` lives), e.g. `~/go/src/arnac-second` or `arnac`.  
   The extension only needs a workspace so **Repo root** can default to that folder; you can also set `fordefiHotfix.repoRoot` in settings later.

2. In the **Activity Bar** (far left), click the **Explorer** icon (two documents).

3. In the **Explorer** sidebar, **scroll down**. Under the same Explorer area as your files, VS Code adds a section named **“Hotfix PRs”**.  
   **Click “Hotfix PRs” once** (or expand it). That loads the extension view.

![Step 3: Find Hotfix PRs in Explorer](hotfix-ext-step3-hotfix-prs-view.png)

### If you still do not see “Hotfix PRs”

- Confirm you are in the window whose title says **`[Extension Development Host]`**.
- **View → Appearance → Primary Side Bar** (ensure the side bar is visible).
- **View → Open View…** → type **Hotfix** → choose **Hotfix PRs** if it appears in the list.
- In the first window (extension source), run **Terminal → Run Task… → npm: compile** so `out/` exists, then press **F5** again.

---

## After the view appears

Ensure **`gh auth login`** works in a terminal (the extension uses **`gh auth token`** first, like `./fcli`). If VS Code cannot find `gh`, set **`fordefiHotfix.ghPath`** to the full path (e.g. `/opt/homebrew/bin/gh` on Apple Silicon). Only then use **Hotfix: Set GitHub token** as an override, or **Hotfix: Clear stored GitHub token** to drop a bad saved PAT. Use **Refresh** on the Hotfix PRs toolbar.
