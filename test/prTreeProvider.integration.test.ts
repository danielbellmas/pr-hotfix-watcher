import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("vscode", async () => {
  const mod = await import("./_util/fakeVscode");
  return mod.vscodeModule;
});

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => "fake-gh-token\n"),
  spawn: vi.fn(),
}));

vi.mock("../src/hotfixRun", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/hotfixRun")>();
  return {
    ...real,
    runHotfixShellCommandAfterMerge: vi.fn(),
    registerHotfixCliOutputChannel: vi.fn(),
  };
});

vi.mock("../src/deployRun", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/deployRun")>();
  return {
    ...real,
    runHotfixDeploy: vi.fn(),
    registerHotfixDeployOutputChannel: vi.fn(),
  };
});

vi.mock("../src/config", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/config")>();
  return {
    ...real,
    getPollIntervalMs: () => 20,
    getHotfixPrPollIntervalMs: () => 20,
  };
});

// Integration tests assert against repoRoot directly; we don't want the real
// `git worktree add` to run against the dummy `/tmp/fake-repo` path, so stub the
// manager to be a passthrough. worktreeManager has its own dedicated unit tests.
vi.mock("../src/worktreeManager", () => ({
  ensureHotfixWorktree: vi.fn(async (repoRoot: string) => ({
    path: repoRoot,
    created: false,
  })),
}));

import * as cp from "node:child_process";
import {
  getFakes,
  getLatestDeployRunningContext,
  makeFakeExtensionContext,
  resetFakeVscode,
  setConfig,
} from "./_util/fakeVscode";
import { buildPull, makeFetchStub, pullPath } from "./_util/githubStubs";
import { invalidateGhTokenCache } from "../src/config";
import { runHotfixDeploy } from "../src/deployRun";
import { runHotfixShellCommandAfterMerge } from "../src/hotfixRun";
import { PrTreeProvider } from "../src/prTreeProvider";

const mockedRunFcli = vi.mocked(runHotfixShellCommandAfterMerge);
const mockedRunDeploy = vi.mocked(runHotfixDeploy);
const mockedExecFileSync = vi.mocked(cp.execFileSync);

/**
 * Real-timer alternative to `vi.waitFor`. Keeps the provider's own
 * `setInterval` poll loop on real time so tests don't have to juggle
 * fake-timer interleaving.
 */
async function waitFor(
  check: () => boolean,
  opts: { timeoutMs?: number; label?: string } = {}
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 1000);
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise<void>((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timed out${opts.label ? ` (${opts.label})` : ""}`);
}

/** Minimum sane config for `buildHotfixCommand` + `pollOnce` repoRoot check. */
function installBaseConfig(): void {
  setConfig("fordefiHotfix.owner", "acme");
  setConfig("fordefiHotfix.repo", "app");
  setConfig("fordefiHotfix.repoRoot", "/tmp/fake-repo");
  setConfig("fordefiHotfix.hotfixEnv", "pre");
  setConfig("fordefiHotfix.workflowsOwner", "acme");
  setConfig("fordefiHotfix.workflowsRepo", "workflows");
  setConfig("fordefiHotfix.preHotfixWorkflow", "pre-hotfix.yml");
  setConfig("fordefiHotfix.productionHotfixWorkflow", "production-hotfix.yml");
  setConfig("fordefiHotfix.workflowRef", "main");
}

type DeferredResult<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): DeferredResult<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("PrTreeProvider integration", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    resetFakeVscode();
    installBaseConfig();
    mockedRunFcli.mockReset();
    mockedRunDeploy.mockReset();
    mockedExecFileSync.mockReset();
    mockedExecFileSync.mockImplementation(
      () => "fake-gh-token\n" as unknown as Buffer
    );
    invalidateGhTokenCache();
    global.fetch = vi.fn(async () => {
      throw new Error("fetch not stubbed for this test");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("happy path: watch -> merged -> fcli -> deploy dispatched", async () => {
    global.fetch = makeFetchStub({
      [pullPath("acme", "app", 100)]: [
        { body: buildPull({ number: 100, state: "open", merged_at: null }) },
        {
          body: buildPull({
            number: 100,
            state: "closed",
            merged_at: "2026-04-22T12:00:00Z",
          }),
        },
      ],
      [pullPath("acme", "app", 101)]: [
        { body: buildPull({ number: 101, state: "open", merged_at: null }) },
        {
          body: buildPull({
            number: 101,
            state: "closed",
            merged_at: "2026-04-22T12:00:00Z",
          }),
        },
      ],
      [pullPath("acme", "app", 999)]: [
        {
          body: buildPull({
            number: 999,
            title: "hotfix PR",
            state: "closed",
            merged_at: "2026-04-22T12:05:00Z",
          }),
        },
      ],
    });

    mockedRunFcli.mockResolvedValue({
      exitCode: 0,
      ok: true,
      hotfixPrUrl: "https://github.com/acme/app/pull/999",
      output: "HOTFIX_PR_URL=https://github.com/acme/app/pull/999\n",
    });

    const deploy = deferred<{ exitCode: number; ok: boolean }>();
    mockedRunDeploy.mockImplementation(async () => deploy.promise);

    const provider = new PrTreeProvider(makeFakeExtensionContext());
    provider.setHotfixCliOptions({ deploy: true, env: "pre" });
    provider.setCheckboxState(100, true);
    provider.setCheckboxState(101, true);
    provider.startWatch();

    await waitFor(() => mockedRunFcli.mock.calls.length >= 1, {
      label: "fcli invoked",
    });
    expect(mockedRunFcli).toHaveBeenCalledTimes(1);
    const fcliArgs = mockedRunFcli.mock.calls[0][0];
    expect(Array.from(fcliArgs.prNumbers)).toEqual([100, 101]);
    expect(fcliArgs.cwd).toBe("/tmp/fake-repo");

    await waitFor(() => provider.getViewState().deployRunning === true, {
      label: "deployRunning=true",
    });
    expect(getLatestDeployRunningContext()).toBe(true);
    expect(mockedRunDeploy).toHaveBeenCalledTimes(1);
    const deployArgs = mockedRunDeploy.mock.calls[0][0];
    expect(deployArgs.env).toBe("pre");
    expect(deployArgs.targets.repoSlug).toBe("acme/workflows");

    provider.stopWatch();
    expect(provider.getViewState().deployRunning).toBe(true);
    expect(provider.getWatching()).toBe(true);

    deploy.resolve({ exitCode: 0, ok: true });

    await waitFor(() => provider.getWatching() === false, {
      label: "watch cleared after deploy",
    });
    expect(provider.getViewState().deployRunning).toBe(false);
    expect(getLatestDeployRunningContext()).toBe(false);
  });

  it("stop during deploy is honest: state is not cleared while deploy is awaiting", async () => {
    global.fetch = makeFetchStub({
      [pullPath("acme", "app", 100)]: [
        {
          body: buildPull({
            number: 100,
            state: "closed",
            merged_at: "2026-04-22T12:00:00Z",
          }),
        },
      ],
      [pullPath("acme", "app", 999)]: [
        {
          body: buildPull({
            number: 999,
            state: "closed",
            merged_at: "2026-04-22T12:05:00Z",
          }),
        },
      ],
    });
    mockedRunFcli.mockResolvedValue({
      exitCode: 0,
      ok: true,
      hotfixPrUrl: "https://github.com/acme/app/pull/999",
      output: "",
    });
    const deploy = deferred<{ exitCode: number; ok: boolean }>();
    mockedRunDeploy.mockImplementation(async () => deploy.promise);

    const provider = new PrTreeProvider(makeFakeExtensionContext());
    provider.setHotfixCliOptions({ deploy: true, env: "pre" });
    provider.setCheckboxState(100, true);
    provider.startWatch();

    await waitFor(() => provider.getViewState().deployRunning === true, {
      label: "deployRunning=true",
    });
    const statusBefore = provider.getStatusMessage();

    const infoCallsBefore = getFakes().info.mock.calls.length;
    provider.stopWatch();
    expect(provider.getViewState().deployRunning).toBe(true);
    expect(provider.getWatching()).toBe(true);
    expect(provider.getStatusMessage()).toBe(statusBefore);
    const newInfoCalls = getFakes()
      .info.mock.calls.slice(infoCallsBefore)
      .map((c) => String(c[0]));
    expect(
      newInfoCalls.some((m) => /Stop ignored.*deploy/i.test(m))
    ).toBe(true);

    deploy.resolve({ exitCode: 0, ok: true });
    await waitFor(() => provider.getWatching() === false);
  });

  it("fcli non-zero exit: deploy is skipped and an error toast fires", async () => {
    global.fetch = makeFetchStub({
      [pullPath("acme", "app", 200)]: [
        {
          body: buildPull({
            number: 200,
            state: "closed",
            merged_at: "2026-04-22T12:00:00Z",
          }),
        },
      ],
    });
    mockedRunFcli.mockResolvedValue({
      exitCode: 2,
      ok: false,
      hotfixPrUrl: undefined,
      output: "boom",
    });
    mockedRunDeploy.mockResolvedValue({ exitCode: 0, ok: true });

    const provider = new PrTreeProvider(makeFakeExtensionContext());
    provider.setHotfixCliOptions({ deploy: true, env: "pre" });
    provider.setCheckboxState(200, true);
    provider.startWatch();

    await waitFor(() => getFakes().error.mock.calls.length > 0, {
      label: "error toast",
    });

    expect(mockedRunFcli).toHaveBeenCalledTimes(1);
    expect(mockedRunDeploy).not.toHaveBeenCalled();
    const errorToasts = getFakes()
      .error.mock.calls.map((c) => String(c[0]))
      .filter((s) => /Hotfix CLI failed/.test(s));
    expect(errorToasts.length).toBeGreaterThan(0);
    expect(provider.getWatching()).toBe(false);
  });

  it("fcli emits no URL + user cancels prompt: watch stops without deploying", async () => {
    global.fetch = makeFetchStub({
      [pullPath("acme", "app", 300)]: [
        {
          body: buildPull({
            number: 300,
            state: "closed",
            merged_at: "2026-04-22T12:00:00Z",
          }),
        },
      ],
    });
    mockedRunFcli.mockResolvedValue({
      exitCode: 0,
      ok: true,
      hotfixPrUrl: undefined,
      output: "no url here",
    });

    getFakes().inputBox.mockImplementation(async () => undefined);

    const provider = new PrTreeProvider(makeFakeExtensionContext());
    provider.setHotfixCliOptions({ deploy: true, env: "pre" });
    provider.setCheckboxState(300, true);
    provider.startWatch();

    await waitFor(() => provider.getWatching() === false, {
      label: "watch cleared after user cancels URL prompt",
    });

    expect(getFakes().inputBox).toHaveBeenCalledTimes(1);
    expect(mockedRunDeploy).not.toHaveBeenCalled();
  });

  it("hotfix PR closed without merge: deploy never dispatched, warning toast", async () => {
    global.fetch = makeFetchStub({
      [pullPath("acme", "app", 400)]: [
        {
          body: buildPull({
            number: 400,
            state: "closed",
            merged_at: "2026-04-22T12:00:00Z",
          }),
        },
      ],
      [pullPath("acme", "app", 999)]: [
        {
          body: buildPull({
            number: 999,
            state: "closed",
            merged_at: null,
          }),
        },
      ],
    });
    mockedRunFcli.mockResolvedValue({
      exitCode: 0,
      ok: true,
      hotfixPrUrl: "https://github.com/acme/app/pull/999",
      output: "",
    });

    const provider = new PrTreeProvider(makeFakeExtensionContext());
    provider.setHotfixCliOptions({ deploy: true, env: "pre" });
    provider.setCheckboxState(400, true);
    provider.startWatch();

    await waitFor(
      () =>
        getFakes()
          .warn.mock.calls.map((c) => String(c[0]))
          .some((s) => /closed without merging/.test(s)),
      { label: "closed-without-merge warning" }
    );

    expect(mockedRunDeploy).not.toHaveBeenCalled();
    expect(provider.getWatching()).toBe(false);
  });

  it("re-entrant pollOnce: concurrent calls only dispatch fcli + deploy once", async () => {
    global.fetch = makeFetchStub({
      [pullPath("acme", "app", 500)]: [
        {
          body: buildPull({
            number: 500,
            state: "closed",
            merged_at: "2026-04-22T12:00:00Z",
          }),
        },
      ],
    });
    mockedRunFcli.mockResolvedValue({
      exitCode: 0,
      ok: true,
      hotfixPrUrl: undefined,
      output: "",
    });
    getFakes().inputBox.mockImplementation(async () => undefined);

    const provider = new PrTreeProvider(makeFakeExtensionContext());
    provider.setHotfixCliOptions({ deploy: false, env: "pre" });
    provider.setCheckboxState(500, true);
    provider.startWatch();

    const privateProvider = provider as unknown as {
      pollOnce(): Promise<void>;
    };
    await Promise.all([
      privateProvider.pollOnce(),
      privateProvider.pollOnce(),
      privateProvider.pollOnce(),
    ]);

    await waitFor(() => mockedRunFcli.mock.calls.length >= 1);
    expect(mockedRunFcli).toHaveBeenCalledTimes(1);
    expect(mockedRunDeploy).not.toHaveBeenCalled();
  });

  it("poll error then recovery: transient 500 keeps watch alive until a success polls through", async () => {
    global.fetch = makeFetchStub({
      [pullPath("acme", "app", 600)]: [
        { status: 500, body: { message: "boom" } },
        { body: buildPull({ number: 600, state: "open", merged_at: null }) },
        {
          body: buildPull({
            number: 600,
            state: "closed",
            merged_at: "2026-04-22T12:00:00Z",
          }),
        },
      ],
    });
    mockedRunFcli.mockResolvedValue({
      exitCode: 0,
      ok: true,
      hotfixPrUrl: undefined,
      output: "",
    });

    const provider = new PrTreeProvider(makeFakeExtensionContext());
    provider.setHotfixCliOptions({ deploy: false, env: "pre" });
    provider.setCheckboxState(600, true);
    provider.startWatch();

    await waitFor(
      () =>
        getFakes()
          .error.mock.calls.map((c) => String(c[0]))
          .some((s) => /Hotfix watch poll failed/.test(s)),
      { label: "poll-error toast" }
    );
    expect(provider.getWatching()).toBe(true);

    await waitFor(() => mockedRunFcli.mock.calls.length >= 1, {
      label: "fcli eventually invoked",
    });
    expect(mockedRunFcli).toHaveBeenCalledTimes(1);
  });

  it("deploy=false: upstream PR merges → fcli runs → watch ends clean, no deploy", async () => {
    global.fetch = makeFetchStub({
      [pullPath("acme", "app", 800)]: [
        { body: buildPull({ number: 800, state: "open", merged_at: null }) },
        {
          body: buildPull({
            number: 800,
            state: "closed",
            merged_at: "2026-04-22T12:00:00Z",
          }),
        },
      ],
    });
    mockedRunFcli.mockResolvedValue({
      exitCode: 0,
      ok: true,
      hotfixPrUrl: undefined,
      output: "",
    });

    const provider = new PrTreeProvider(makeFakeExtensionContext());
    provider.setHotfixCliOptions({ deploy: false, env: "pre" });
    provider.setCheckboxState(800, true);
    provider.startWatch();

    await waitFor(() => mockedRunFcli.mock.calls.length >= 1, {
      label: "fcli invoked",
    });
    await waitFor(() => provider.getWatching() === false, {
      label: "watch cleared after fcli (no deploy)",
    });

    expect(mockedRunFcli).toHaveBeenCalledTimes(1);
    expect(mockedRunDeploy).not.toHaveBeenCalled();
    expect(provider.getViewState().deployRunning).toBe(false);
  });

  // Real timing gate: hotfix PR is open on first poll, only merges on the
  // second. Proves runDeploy waits for the actual merge-watch transition,
  // not for a coincidentally-already-merged PR (as the happy path covers).
  it("deploy waits for hotfix PR to actually transition open → merged", async () => {
    global.fetch = makeFetchStub({
      [pullPath("acme", "app", 850)]: [
        {
          body: buildPull({
            number: 850,
            state: "closed",
            merged_at: "2026-04-22T12:00:00Z",
          }),
        },
      ],
      [pullPath("acme", "app", 851)]: [
        { body: buildPull({ number: 851, state: "open", merged_at: null }) },
        { body: buildPull({ number: 851, state: "open", merged_at: null }) },
        {
          body: buildPull({
            number: 851,
            state: "closed",
            merged_at: "2026-04-22T12:10:00Z",
          }),
        },
      ],
    });
    mockedRunFcli.mockResolvedValue({
      exitCode: 0,
      ok: true,
      hotfixPrUrl: "https://github.com/acme/app/pull/851",
      output: "HOTFIX_PR_URL=https://github.com/acme/app/pull/851\n",
    });
    mockedRunDeploy.mockResolvedValue({ exitCode: 0, ok: true });

    const provider = new PrTreeProvider(makeFakeExtensionContext());
    provider.setHotfixCliOptions({ deploy: true, env: "pre" });
    provider.setCheckboxState(850, true);
    provider.startWatch();

    await waitFor(() => mockedRunFcli.mock.calls.length >= 1, {
      label: "fcli invoked after upstream merge",
    });
    // Hotfix PR (851) is still open — deploy must NOT have fired yet.
    await new Promise((r) => setTimeout(r, 30));
    expect(mockedRunDeploy).not.toHaveBeenCalled();

    // The third response transitions 851 to merged; deploy then dispatches.
    await waitFor(() => mockedRunDeploy.mock.calls.length >= 1, {
      label: "deploy fires after hotfix PR merges",
    });
    expect(mockedRunDeploy).toHaveBeenCalledTimes(1);
  });

  it("upstream PR closed without merge stops the pre-fcli watch and warns", async () => {
    global.fetch = makeFetchStub({
      [pullPath("acme", "app", 870)]: [
        {
          body: buildPull({
            number: 870,
            state: "closed",
            merged_at: null,
          }),
        },
      ],
    });

    const provider = new PrTreeProvider(makeFakeExtensionContext());
    provider.setHotfixCliOptions({ deploy: true, env: "pre" });
    provider.setCheckboxState(870, true);
    provider.startWatch();

    await waitFor(
      () =>
        getFakes()
          .warn.mock.calls.map((c) => String(c[0]))
          .some((s) => /closed without merging/.test(s)),
      { label: "closed-without-merge warning on upstream PR" }
    );

    expect(mockedRunFcli).not.toHaveBeenCalled();
    expect(mockedRunDeploy).not.toHaveBeenCalled();
    expect(provider.getWatching()).toBe(false);
  });

  it("deploy non-zero exit: error toast fires and watch state clears", async () => {
    global.fetch = makeFetchStub({
      [pullPath("acme", "app", 880)]: [
        {
          body: buildPull({
            number: 880,
            state: "closed",
            merged_at: "2026-04-22T12:00:00Z",
          }),
        },
      ],
      [pullPath("acme", "app", 881)]: [
        {
          body: buildPull({
            number: 881,
            state: "closed",
            merged_at: "2026-04-22T12:05:00Z",
          }),
        },
      ],
    });
    mockedRunFcli.mockResolvedValue({
      exitCode: 0,
      ok: true,
      hotfixPrUrl: "https://github.com/acme/app/pull/881",
      output: "",
    });
    mockedRunDeploy.mockResolvedValue({ exitCode: 7, ok: false });

    const provider = new PrTreeProvider(makeFakeExtensionContext());
    provider.setHotfixCliOptions({ deploy: true, env: "pre" });
    provider.setCheckboxState(880, true);
    provider.startWatch();

    await waitFor(
      () =>
        getFakes()
          .error.mock.calls.map((c) => String(c[0]))
          .some((s) => /deploy did not complete/i.test(s)),
      { label: "deploy-failed error toast" }
    );

    expect(mockedRunDeploy).toHaveBeenCalledTimes(1);
    expect(provider.getWatching()).toBe(false);
    expect(provider.getViewState().deployRunning).toBe(false);
    // Note: context-key transitions on deploy failure happen too quickly for
    // the webview to have observed the intermediate `true`. Happy-path test
    // covers the full true→false context-key cycle.
  });

  it("token cache: many polls resolve to one execFileSync('gh auth token') call", async () => {
    global.fetch = makeFetchStub({
      [pullPath("acme", "app", 700)]: [
        { body: buildPull({ number: 700, state: "open", merged_at: null }) },
      ],
    });

    const provider = new PrTreeProvider(makeFakeExtensionContext());
    provider.setHotfixCliOptions({ deploy: false, env: "pre" });
    provider.setCheckboxState(700, true);
    provider.startWatch();

    await waitFor(
      () =>
        (global.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls
          .length >= 4,
      { label: ">=4 poll fetches" }
    );

    provider.stopWatch();

    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    const firstCall = mockedExecFileSync.mock.calls[0];
    expect(firstCall[0]).toBe("gh");
    expect(firstCall[1]).toEqual(["auth", "token"]);
  });
});
