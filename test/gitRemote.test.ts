import { describe, expect, it } from "vitest";
import { parseGitHubRepoFromRemote } from "../src/gitRemote";

describe("parseGitHubRepoFromRemote", () => {
  it("parses git@github.com:owner/repo.git", () => {
    expect(
      parseGitHubRepoFromRemote("git@github.com:arnac-io/arnac.git")
    ).toEqual({
      owner: "arnac-io",
      repo: "arnac",
    });
  });

  it("parses ssh://git@github.com/owner/repo", () => {
    expect(
      parseGitHubRepoFromRemote("ssh://git@github.com/arnac-io/arnac")
    ).toEqual({
      owner: "arnac-io",
      repo: "arnac",
    });
  });

  it("parses https URL", () => {
    expect(parseGitHubRepoFromRemote("https://github.com/foo/bar")).toEqual({
      owner: "foo",
      repo: "bar",
    });
  });

  it("parses http URL to github.com", () => {
    expect(parseGitHubRepoFromRemote("http://github.com/acme/widget")).toEqual({
      owner: "acme",
      repo: "widget",
    });
  });

  it("strips .git for https", () => {
    expect(parseGitHubRepoFromRemote("https://github.com/foo/bar.git")).toEqual(
      {
        owner: "foo",
        repo: "bar",
      }
    );
  });

  it("returns undefined for empty", () => {
    expect(parseGitHubRepoFromRemote("")).toBeUndefined();
    expect(parseGitHubRepoFromRemote("   ")).toBeUndefined();
  });

  it("returns undefined for non-GitHub host", () => {
    expect(
      parseGitHubRepoFromRemote("https://gitlab.com/foo/bar")
    ).toBeUndefined();
  });

  it("returns undefined for incomplete path", () => {
    expect(
      parseGitHubRepoFromRemote("https://github.com/solo")
    ).toBeUndefined();
  });
});
