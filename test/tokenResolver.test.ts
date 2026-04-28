import { beforeEach, describe, expect, it, vi } from "vitest";
import { TokenResolver, type TokenResolverDeps } from "../src/tokenResolver";

function makeDeps(
  overrides: Partial<TokenResolverDeps> = {}
): TokenResolverDeps & {
  exec: ReturnType<typeof vi.fn>;
  secrets: {
    get: ReturnType<typeof vi.fn>;
    store: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
} {
  let t = 1_000_000;
  const exec = vi.fn(
    (_file: string, _args: string[], _timeout: number) => undefined
  );
  const secrets = {
    get: vi.fn(async (_k: string) => undefined),
    store: vi.fn(async (_k: string, _v: string) => undefined),
    delete: vi.fn(async (_k: string) => undefined),
  };
  return {
    exec,
    secrets,
    config: {
      ghPath: () => "",
      githubPat: () => "",
    },
    envToken: () => undefined,
    now: () => (t += 1),
    ...overrides,
  } as ReturnType<typeof makeDeps>;
}

describe("TokenResolver.resolve — priority chain", () => {
  it("returns gh token when gh succeeds (does not consult secret/cfg/env)", async () => {
    const deps = makeDeps({
      exec: vi.fn(() => "gh-token\n"),
      secrets: {
        get: vi.fn(async () => "secret-token"),
        store: vi.fn(),
        delete: vi.fn(),
      },
      config: { ghPath: () => "", githubPat: () => "cfg-token" },
      envToken: () => "env-token",
    });
    const r = new TokenResolver(deps);
    expect(await r.resolve()).toBe("gh-token");
    expect(deps.secrets.get).not.toHaveBeenCalled();
  });

  it("falls through to secret when gh returns empty", async () => {
    const deps = makeDeps({
      exec: vi.fn(() => undefined),
      secrets: {
        get: vi.fn(async () => "secret-token"),
        store: vi.fn(),
        delete: vi.fn(),
      },
    });
    const r = new TokenResolver(deps);
    expect(await r.resolve()).toBe("secret-token");
  });

  it("falls through to githubPat config when gh + secret are empty", async () => {
    const deps = makeDeps({
      config: { ghPath: () => "", githubPat: () => "  cfg-token  " },
    });
    const r = new TokenResolver(deps);
    expect(await r.resolve()).toBe("cfg-token");
  });

  it("falls through to env var as the last resort", async () => {
    const deps = makeDeps({ envToken: () => "  env-token  " });
    const r = new TokenResolver(deps);
    expect(await r.resolve()).toBe("env-token");
  });

  it("returns undefined when every source is empty", async () => {
    const r = new TokenResolver(makeDeps());
    expect(await r.resolve()).toBeUndefined();
  });

  it("uses configured ghPath as the executable when non-empty", async () => {
    const exec = vi.fn(() => "tok");
    const deps = makeDeps({
      exec,
      config: { ghPath: () => " /opt/homebrew/bin/gh ", githubPat: () => "" },
    });
    const r = new TokenResolver(deps);
    await r.resolve();
    expect(exec.mock.calls[0][0]).toBe("/opt/homebrew/bin/gh");
  });

  it("defaults to 'gh' on empty ghPath", async () => {
    const exec = vi.fn(() => "tok");
    const deps = makeDeps({ exec });
    const r = new TokenResolver(deps);
    await r.resolve();
    expect(exec.mock.calls[0][0]).toBe("gh");
  });

  it("trims trailing newline from gh stdout", async () => {
    const deps = makeDeps({ exec: () => "ghp_xxx\n\r" });
    const r = new TokenResolver(deps);
    expect(await r.resolve()).toBe("ghp_xxx");
  });
});

describe("TokenResolver.fromGhCli — TTL cache", () => {
  let realNow: number;
  let exec: ReturnType<typeof vi.fn>;
  let deps: TokenResolverDeps;

  beforeEach(() => {
    realNow = 1_000_000;
    exec = vi.fn(() => "tok");
    deps = makeDeps({ exec, now: () => realNow });
  });

  it("caches subsequent calls within TTL", async () => {
    const r = new TokenResolver(deps);
    expect(await r.fromGhCli("gh")).toBe("tok");
    expect(await r.fromGhCli("gh")).toBe("tok");
    expect(await r.fromGhCli("gh")).toBe("tok");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("re-shells after TTL expires", async () => {
    const r = new TokenResolver(deps);
    await r.fromGhCli("gh");
    realNow += 30_001;
    await r.fromGhCli("gh");
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("re-shells when the executable changes (different ghPath)", async () => {
    const r = new TokenResolver(deps);
    await r.fromGhCli("gh");
    await r.fromGhCli("/opt/homebrew/bin/gh");
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("caches a NEGATIVE result (gh returned undefined) within TTL", async () => {
    exec.mockReturnValue(undefined);
    const r = new TokenResolver(deps);
    expect(await r.fromGhCli("gh")).toBeUndefined();
    expect(await r.fromGhCli("gh")).toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("invalidate() forces a re-shell on the next call", async () => {
    const r = new TokenResolver(deps);
    await r.fromGhCli("gh");
    r.invalidate();
    await r.fromGhCli("gh");
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe("TokenResolver.store / clear", () => {
  it("store writes to secret storage and invalidates the cache", async () => {
    const deps = makeDeps({ exec: vi.fn(() => "old-gh-token") });
    const r = new TokenResolver(deps);
    await r.resolve();
    expect(deps.exec).toHaveBeenCalledTimes(1);

    await r.store("  new-token  ");
    expect(deps.secrets.store).toHaveBeenCalledWith(
      "fordefiHotfix.githubPat",
      "new-token"
    );

    await r.resolve();
    expect(deps.exec).toHaveBeenCalledTimes(2); // cache busted
  });

  it("clear deletes the secret and invalidates the cache", async () => {
    const deps = makeDeps({ exec: vi.fn(() => "tok") });
    const r = new TokenResolver(deps);
    await r.resolve();

    await r.clear();
    expect(deps.secrets.delete).toHaveBeenCalledWith(
      "fordefiHotfix.githubPat"
    );

    await r.resolve();
    expect(deps.exec).toHaveBeenCalledTimes(2);
  });
});
