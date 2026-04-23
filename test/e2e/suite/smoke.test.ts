import * as assert from "assert";
import * as vscode from "vscode";

const EXTENSION_ID = "fordefi.hotfix-watcher";

suite("Fordefi Hotfix Watcher smoke", () => {
  test("extension activates", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} not found`);
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  test("core commands are registered", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      "fordefiHotfix.setToken",
      "fordefiHotfix.clearStoredToken",
      "fordefiHotfix.refresh",
      "fordefiHotfix.startWatch",
      "fordefiHotfix.stopWatch",
      "fordefiHotfix.syncRepoFromGit",
    ]) {
      assert.ok(commands.includes(id), `missing command: ${id}`);
    }
  });

  test("refresh with an empty PR list does not throw", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    await ext.activate();

    // Deterministic empty-list response so the suite doesn't depend on `gh`
    // being authenticated in CI.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ items: [], total_count: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    try {
      // The focus command throws if the container is already active; that's
      // not a failure for this smoke test.
      try {
        await vscode.commands.executeCommand("fordefiHotfix.prList.focus");
      } catch {
        // ignore
      }
      await vscode.commands.executeCommand("fordefiHotfix.refresh");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
