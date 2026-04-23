import * as fs from "fs";
import * as path from "path";
import Mocha from "mocha";

function findTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findTestFiles(p));
    } else if (entry.name.endsWith(".test.js")) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Called by VS Code after our extension has activated. Returns a promise that
 * rejects with a non-zero failure count so `runTests` surfaces mocha output.
 */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", color: true, timeout: 30_000 });
  const testsRoot = __dirname;
  for (const file of findTestFiles(testsRoot)) {
    mocha.addFile(file);
  }
  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} mocha test(s) failed.`));
          return;
        }
        resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}
