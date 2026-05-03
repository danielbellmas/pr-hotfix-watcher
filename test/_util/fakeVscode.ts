import { vi, type Mock } from "vitest";

type AnyMock = Mock<(...args: unknown[]) => unknown>;

type Listener<T> = (e: T) => void;

class EventEmitter<T> {
  private listeners: Listener<T>[] = [];
  event = (listener: Listener<T>): { dispose(): void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };
  fire(payload: T): void {
    for (const l of this.listeners.slice()) {
      try {
        l(payload);
      } catch {
        // Swallow — subscribers should not abort the emit loop.
      }
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

type FakeTerminal = {
  sendText: AnyMock;
  show: AnyMock;
  dispose: AnyMock;
  shellIntegration: undefined;
  exitStatus: undefined;
};

type FakeOutputChannel = {
  append: AnyMock;
  appendLine: AnyMock;
  show: AnyMock;
  dispose: AnyMock;
  clear: AnyMock;
};

type FakeState = {
  info: AnyMock;
  warn: AnyMock;
  error: AnyMock;
  inputBox: AnyMock;
  executeCommand: AnyMock;
  createOutputChannel: AnyMock;
  createTerminal: AnyMock;
  configStore: Map<string, unknown>;
  secretsStore: Map<string, string>;
  workspaceStateStore: Map<string, unknown>;
};

const state: FakeState = {
  info: vi.fn(async () => undefined),
  warn: vi.fn(async () => undefined),
  error: vi.fn(async () => undefined),
  inputBox: vi.fn(async () => undefined),
  executeCommand: vi.fn(async () => undefined),
  createOutputChannel: vi.fn(
    (): FakeOutputChannel => ({
      append: vi.fn(),
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
      clear: vi.fn(),
    })
  ),
  createTerminal: vi.fn(
    (): FakeTerminal => ({
      sendText: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
      shellIntegration: undefined,
      exitStatus: undefined,
    })
  ),
  configStore: new Map(),
  secretsStore: new Map(),
  workspaceStateStore: new Map(),
};

export function resetFakeVscode(): void {
  state.info.mockReset();
  state.warn.mockReset();
  state.error.mockReset();
  state.inputBox.mockReset();
  state.executeCommand.mockReset();
  state.createOutputChannel.mockClear();
  state.createTerminal.mockClear();

  state.info.mockImplementation(async () => undefined);
  state.warn.mockImplementation(async () => undefined);
  state.error.mockImplementation(async () => undefined);
  state.inputBox.mockImplementation(async () => undefined);
  state.executeCommand.mockImplementation(async () => undefined);
  state.createOutputChannel.mockImplementation(() => ({
    append: vi.fn(),
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
    clear: vi.fn(),
  }));
  state.createTerminal.mockImplementation(() => ({
    sendText: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
    shellIntegration: undefined,
    exitStatus: undefined,
  }));

  state.configStore.clear();
  state.secretsStore.clear();
  state.workspaceStateStore.clear();
}

export function getFakes(): {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  inputBox: ReturnType<typeof vi.fn>;
  executeCommand: ReturnType<typeof vi.fn>;
} {
  return {
    info: state.info,
    warn: state.warn,
    error: state.error,
    inputBox: state.inputBox,
    executeCommand: state.executeCommand,
  };
}

/**
 * Write a value into the fake `workspace.getConfiguration("fordefiHotfix")`
 * store. Keys may be bare (`owner`) or fully-qualified (`fordefiHotfix.owner`).
 */
export function setConfig(key: string, value: unknown): void {
  state.configStore.set(key, value);
}

export function getSetContextCalls(): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const args of state.executeCommand.mock.calls) {
    if (args[0] === "setContext" && typeof args[1] === "string") {
      out.push([args[1] as string, args[2]]);
    }
  }
  return out;
}

export function getLatestDeployRunningContext(): boolean | undefined {
  const hits = getSetContextCalls().filter(([k]) => k === "fordefiHotfix.deployRunning");
  if (hits.length === 0) {
    return undefined;
  }
  return hits[hits.length - 1][1] as boolean;
}

export type FakeExtensionContext = {
  subscriptions: Array<{ dispose(): unknown }>;
  secrets: {
    get(key: string): Promise<string | undefined>;
    store(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  workspaceState: {
    get<T>(key: string, fallback?: T): T | undefined;
    update(key: string, value: unknown): Promise<void>;
  };
};

export function makeFakeExtensionContext(): FakeExtensionContext {
  return {
    subscriptions: [],
    secrets: {
      get: async (k) => state.secretsStore.get(k),
      store: async (k, v) => {
        state.secretsStore.set(k, v);
      },
      delete: async (k) => {
        state.secretsStore.delete(k);
      },
    },
    workspaceState: {
      get: <T>(k: string, fb?: T): T | undefined =>
        state.workspaceStateStore.has(k) ? (state.workspaceStateStore.get(k) as T) : fb,
      update: async (k, v) => {
        state.workspaceStateStore.set(k, v);
      },
    },
  };
}

function makeConfig(): {
  get<T>(key: string, fallback?: T): T | undefined;
  update(key: string, value: unknown): Promise<void>;
} {
  return {
    get: <T>(key: string, fallback?: T): T | undefined => {
      const fq = `fordefiHotfix.${key}`;
      if (state.configStore.has(fq)) {
        return state.configStore.get(fq) as T;
      }
      if (state.configStore.has(key)) {
        return state.configStore.get(key) as T;
      }
      return fallback;
    },
    update: async (key, value) => {
      state.configStore.set(`fordefiHotfix.${key}`, value);
    },
  };
}

/** Shape that `vi.mock("vscode", ...)` should return. */
export const vscodeModule: Record<string, unknown> = {
  EventEmitter,
  window: {
    showInformationMessage: (...args: unknown[]) => state.info(...args),
    showWarningMessage: (...args: unknown[]) => state.warn(...args),
    showErrorMessage: (...args: unknown[]) => state.error(...args),
    showInputBox: (...args: unknown[]) => state.inputBox(...args),
    createOutputChannel: (...args: unknown[]) => state.createOutputChannel(...args),
    createTerminal: (...args: unknown[]) => state.createTerminal(...args),
    registerWebviewViewProvider: () => ({ dispose: () => undefined }),
    onDidChangeActiveColorTheme: () => ({ dispose: () => undefined }),
    onDidChangeTerminalShellIntegration: () => ({ dispose: () => undefined }),
    onDidEndTerminalShellExecution: () => ({ dispose: () => undefined }),
  },
  workspace: {
    getConfiguration: (_ns?: string) => makeConfig(),
    onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    workspaceFolders: [],
  },
  commands: {
    executeCommand: (...args: unknown[]) => state.executeCommand(...args),
    registerCommand: () => ({ dispose: () => undefined }),
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  env: { openExternal: vi.fn(async () => false) },
  Uri: {
    parse: (s: string) => ({ toString: () => s, fsPath: s }),
    file: (p: string) => ({ toString: () => p, fsPath: p }),
  },
  ThemeIcon: class ThemeIcon {
    constructor(public readonly id: string) {}
  },
  TreeItem: class TreeItem {},
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
};
