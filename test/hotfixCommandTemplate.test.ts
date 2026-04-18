import { describe, expect, it } from "vitest";
import { expandHotfixCommandTemplate } from "../src/hotfixCommandTemplate";

describe("expandHotfixCommandTemplate", () => {
  const base = {
    repoRoot: "/tmp/repo",
    owner: "o",
    repo: "r",
    prNumbers: [3, 1],
    hotfixSuffix: "--env pre",
  };

  it("replaces all placeholders and sorts PR numbers", () => {
    const out = expandHotfixCommandTemplate(
      "cd {repoRoot} && echo {owner}/{repo} {prNumbers} {prList} {hotfixSuffix}",
      base,
    );
    expect(out).toBe("cd /tmp/repo && echo o/r 1 3 1,3 --env pre");
  });

  it("throws when template omits {prNumbers}", () => {
    expect(() =>
      expandHotfixCommandTemplate("cd {repoRoot} && true", {
        ...base,
        prNumbers: [1],
      }),
    ).toThrow("fordefiHotfix.commandTemplate must contain {prNumbers}");
  });

  it("leaves unknown placeholders untouched", () => {
    const out = expandHotfixCommandTemplate("{prNumbers} {notAPlaceholder} {repoRoot}", {
      ...base,
      prNumbers: [9],
    });
    expect(out).toBe("9 {notAPlaceholder} /tmp/repo");
  });

  it("handles empty pr list as empty string segments", () => {
    const out = expandHotfixCommandTemplate("x {prNumbers} y {prList} z", {
      ...base,
      prNumbers: [],
      hotfixSuffix: "",
    });
    expect(out).toBe("x  y  z");
  });
});
