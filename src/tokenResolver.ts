/**
 * GitHub token chain: `gh auth token` → VS Code secret → `fordefiHotfix.githubPat`
 * setting → `GITHUB_ACCESS_TOKEN` env. `gh` is preferred because it self-rotates
 * on `gh auth login`; the result is cached for {@link GH_TOKEN_TTL_MS} so the
 * watch-poll loop doesn't pay a 20–80ms shell-out per tick. Cache is dropped on
 * config change, secret store/clear (see `extension.ts`) and on 401 from
 * `githubClient.ts`.
 */

const SECRET_KEY = "fordefiHotfix.githubPat";
const GH_TOKEN_TTL_MS = 30_000;

export type SecretStore = {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

export type TokenConfigProvider = {
  /** `fordefiHotfix.ghPath`; empty → search PATH. */
  ghPath(): string;
  githubPat(): string;
};

export type TokenResolverDeps = {
  /** Async `gh auth token`. Returns `undefined` on any failure. May return
   *  a sync value too (back-compat for tests that don't need Promise plumbing). */
  exec: (
    file: string,
    args: string[],
    timeoutMs: number
  ) => Promise<string | undefined> | string | undefined;
  secrets: SecretStore;
  config: TokenConfigProvider;
  envToken: () => string | undefined;
  now: () => number;
};

type GhTokenCacheEntry = {
  executable: string;
  value: string | undefined;
  at: number;
};

export class TokenResolver {
  private cache: GhTokenCacheEntry | undefined;

  constructor(private readonly deps: TokenResolverDeps) {}

  invalidate(): void {
    this.cache = undefined;
  }

  async resolve(): Promise<string | undefined> {
    const exe = this.deps.config.ghPath().trim() || "gh";
    const fromGh = await this.fromGhCli(exe);
    if (fromGh) {
      return fromGh;
    }
    const fromSecret = (await this.deps.secrets.get(SECRET_KEY))?.trim();
    if (fromSecret) {
      return fromSecret;
    }
    const fromCfg = this.deps.config.githubPat().trim();
    if (fromCfg) {
      return fromCfg;
    }
    const fromEnv = this.deps.envToken()?.trim();
    if (fromEnv) {
      return fromEnv;
    }
    return undefined;
  }

  async store(token: string): Promise<void> {
    await this.deps.secrets.store(SECRET_KEY, token.trim());
    this.invalidate();
  }

  async clear(): Promise<void> {
    await this.deps.secrets.delete(SECRET_KEY);
    this.invalidate();
  }

  /** Cache is keyed on the executable path so `ghPath` config changes don't
   *  serve a stale token from the previous binary. */
  async fromGhCli(executable: string): Promise<string | undefined> {
    const now = this.deps.now();
    const c = this.cache;
    if (c && c.executable === executable && now - c.at < GH_TOKEN_TTL_MS) {
      return c.value;
    }
    const out = await this.deps.exec(executable, ["auth", "token"], 8000);
    const value = out?.trim() || undefined;
    this.cache = { executable, value, at: now };
    return value;
  }
}

export const GITHUB_PAT_SECRET_KEY = SECRET_KEY;
