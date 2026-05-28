import { describe, expect, it } from "vitest";
import { expandHotfixCommandTemplate, stripFcliJsonOutputFlag } from "../src/hotfixCommandTemplate";

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

  it("does not mutate fcli flags beyond placeholder expansion", () => {
    const out = expandHotfixCommandTemplate(
      "cd {repoRoot} && ./fcli workflows hotfix create-pull-request {prNumbers} {hotfixSuffix}",
      base
    );
    expect(out).toBe("cd /tmp/repo && ./fcli workflows hotfix create-pull-request 1 3 --env pre");
  });

  it("preserves -o json when the user put it in the template", () => {
    const out = expandHotfixCommandTemplate(
      "./fcli workflows hotfix create-pull-request {prNumbers} -o json",
      base
    );
    expect(out).toBe("./fcli workflows hotfix create-pull-request 1 3 -o json");
  });
});

describe("stripFcliJsonOutputFlag", () => {
  it("removes -o json from an fcli hotfix create-pull-request invocation", () => {
    expect(
      stripFcliJsonOutputFlag("./fcli workflows hotfix create-pull-request 12 34 --env pre -o json")
    ).toBe("./fcli workflows hotfix create-pull-request 12 34 --env pre");
  });

  it("removes --output json variants", () => {
    expect(
      stripFcliJsonOutputFlag("./fcli workflows hotfix create-pull-request 1 --output json")
    ).toBe("./fcli workflows hotfix create-pull-request 1");
    expect(
      stripFcliJsonOutputFlag("./fcli workflows hotfix create-pull-request 1 --output=json")
    ).toBe("./fcli workflows hotfix create-pull-request 1");
  });

  it("preserves trailing shell-chain operators", () => {
    expect(
      stripFcliJsonOutputFlag(
        "cd /repo && ./fcli workflows hotfix create-pull-request 1 --env pre -o json && echo done"
      )
    ).toBe("cd /repo && ./fcli workflows hotfix create-pull-request 1 --env pre && echo done");
  });

  it("leaves unrelated commands alone", () => {
    expect(stripFcliJsonOutputFlag("echo hello")).toBe("echo hello");
    expect(stripFcliJsonOutputFlag("./fcli something else 1 2")).toBe("./fcli something else 1 2");
  });
});
