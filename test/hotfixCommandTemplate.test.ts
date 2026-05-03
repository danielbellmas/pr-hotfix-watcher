import { describe, expect, it } from "vitest";
import { ensureJsonOutputFlag, expandHotfixCommandTemplate } from "../src/hotfixCommandTemplate";

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
      base
    );
    expect(out).toBe("cd /tmp/repo && echo o/r 1 3 1,3 --env pre");
  });

  it("throws when template omits {prNumbers}", () => {
    expect(() =>
      expandHotfixCommandTemplate("cd {repoRoot} && true", {
        ...base,
        prNumbers: [1],
      })
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

  it("auto-injects -o json into an fcli hotfix create-pull-request invocation", () => {
    const out = expandHotfixCommandTemplate(
      "cd {repoRoot} && ./fcli workflows hotfix create-pull-request {prNumbers} {hotfixSuffix}",
      base
    );
    expect(out).toBe(
      "cd /tmp/repo && ./fcli workflows hotfix create-pull-request 1 3 --env pre -o json"
    );
  });

  it("does not double-inject -o json when the user already specified it", () => {
    const out = expandHotfixCommandTemplate(
      "./fcli workflows hotfix create-pull-request {prNumbers} -o json",
      base
    );
    expect(out).toBe("./fcli workflows hotfix create-pull-request 1 3 -o json");
  });
});

describe("ensureJsonOutputFlag", () => {
  it("appends -o json to an fcli hotfix create-pull-request invocation", () => {
    expect(
      ensureJsonOutputFlag("./fcli workflows hotfix create-pull-request 12 34 --env pre")
    ).toBe("./fcli workflows hotfix create-pull-request 12 34 --env pre -o json");
  });

  it("is idempotent when -o json or --output json already present", () => {
    const a = "./fcli workflows hotfix create-pull-request 1 -o json";
    expect(ensureJsonOutputFlag(a)).toBe(a);
    const b = "./fcli workflows hotfix create-pull-request 1 --output json";
    expect(ensureJsonOutputFlag(b)).toBe(b);
    const c = "./fcli workflows hotfix create-pull-request 1 --output=json";
    expect(ensureJsonOutputFlag(c)).toBe(c);
  });

  it("preserves trailing shell-chain operators (&&, ;) by injecting before them", () => {
    expect(
      ensureJsonOutputFlag(
        "cd /repo && ./fcli workflows hotfix create-pull-request 1 --env pre && echo done"
      )
    ).toBe(
      "cd /repo && ./fcli workflows hotfix create-pull-request 1 --env pre -o json && echo done"
    );
  });

  it("leaves unrelated commands alone", () => {
    expect(ensureJsonOutputFlag("echo hello")).toBe("echo hello");
    expect(ensureJsonOutputFlag("./fcli something else 1 2")).toBe("./fcli something else 1 2");
  });
});
