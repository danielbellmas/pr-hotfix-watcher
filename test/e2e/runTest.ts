import * as path from "path";
import { runTests } from "@vscode/test-electron";

/**
 * Deliberately narrow harness: only catches "extension failed to activate" or
 * "webview HTML unparsable". Flow behavior lives in the in-process integration
 * suite at `test/prTreeProvider.integration.test.ts`.
 */
async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, "..", "..", "..");
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ["--disable-extensions"],
    });
  } catch (err) {
    console.error("Failed to run e2e smoke tests:", err);
    process.exit(1);
  }
}

void main();
