import * as cp from "node:child_process";
import * as vscode from "vscode";

const DEFAULT_SHELL_INTEGRATION_WAIT_MS = 8000;
const OUTPUT_TAIL_LIMIT = 16_000;

export type IntegratedTerminalRunOptions = {
  command: string;
  cwd: string;
  terminalName: string;
  log: (line: string) => void;
  captureOutput?: boolean;
  /** One-shot keystroke sent after `delayMs` regardless of output, used to
   *  auto-answer fcli's first `y` prompt. `addNewline` is decided from the
   *  text itself so a CR/LF-bearing value doesn't get a duplicate Enter. */
  autoFirstConfirm?: {
    text: string;
    delayMs: number;
  };
  shellIntegrationWaitMs?: number;
};

export type IntegratedTerminalRunResult = {
  exitCode: number | undefined;
  output: string;
  /** True iff the harness fell back to `sendText` — no exit code is available. */
  fallbackUsed: boolean;
};

/**
 * Prefer shell-integration `executeCommand` (real exit code); fall back to
 * `sendText` after `shellIntegrationWaitMs`.
 */
export async function runInIntegratedTerminal(
  options: IntegratedTerminalRunOptions
): Promise<IntegratedTerminalRunResult> {
  const {
    command,
    cwd,
    terminalName,
    log,
    captureOutput = false,
    autoFirstConfirm,
    shellIntegrationWaitMs = DEFAULT_SHELL_INTEGRATION_WAIT_MS,
  } = options;

  const terminal = vscode.window.createTerminal({ name: terminalName, cwd });
  terminal.show(true);

  let capturedOutput = "";
  let resolvedExit: number | undefined;
  let fallbackUsed = false;

  await new Promise<void>((resolve) => {
    let activeExecution: vscode.TerminalShellExecution | undefined;
    let settled = false;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let autoFirstConfirmTimer: ReturnType<typeof setTimeout> | undefined;
    const disposables: vscode.Disposable[] = [];

    const cleanup = (): void => {
      if (fallbackTimer !== undefined) {
        clearTimeout(fallbackTimer);
        fallbackTimer = undefined;
      }
      if (autoFirstConfirmTimer !== undefined) {
        clearTimeout(autoFirstConfirmTimer);
        autoFirstConfirmTimer = undefined;
      }
      for (const d of disposables) {
        d.dispose();
      }
    };

    const done = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };

    const scheduleAutoFirstConfirm = (): void => {
      if (!autoFirstConfirm) {
        return;
      }
      const { text, delayMs } = autoFirstConfirm;
      if (autoFirstConfirmTimer !== undefined) {
        clearTimeout(autoFirstConfirmTimer);
      }
      autoFirstConfirmTimer = setTimeout(() => {
        autoFirstConfirmTimer = undefined;
        if (settled) {
          return;
        }
        const addNewline = !/[\r\n]/.test(text);
        log(`[auto-confirm] sending first-prompt input after ${delayMs}ms`);
        try {
          terminal.sendText(text, addNewline);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          log(`[auto-confirm] ${msg}`);
        }
      }, delayMs);
    };

    const consumeExecutionStream = async (
      execution: vscode.TerminalShellExecution
    ): Promise<void> => {
      const maybeRead = (execution as unknown as { read?: () => AsyncIterable<string> }).read;
      if (typeof maybeRead !== "function") {
        return;
      }
      try {
        for await (const chunk of maybeRead.call(execution)) {
          capturedOutput = (capturedOutput + chunk).slice(-OUTPUT_TAIL_LIMIT);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`[stream read failed] ${msg}`);
      }
    };

    const tryExecute = (si: vscode.TerminalShellIntegration | undefined): boolean => {
      if (activeExecution || !si) {
        return false;
      }
      try {
        activeExecution = si.executeCommand(command);
        if (fallbackTimer !== undefined) {
          clearTimeout(fallbackTimer);
          fallbackTimer = undefined;
        }
        scheduleAutoFirstConfirm();
        if (captureOutput) {
          void consumeExecutionStream(activeExecution);
        }
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`[executeCommand failed] ${msg}`);
        activeExecution = undefined;
        return false;
      }
    };

    const endSub = vscode.window.onDidEndTerminalShellExecution((e) => {
      if (!activeExecution || e.execution !== activeExecution) {
        return;
      }
      log(
        `[shell integration] exit ${e.exitCode === undefined ? "undefined" : String(e.exitCode)}`
      );
      resolvedExit = e.exitCode;
      done();
    });
    disposables.push(endSub);

    const fallbackSendText = (reason: string): void => {
      if (activeExecution) {
        return;
      }
      fallbackUsed = true;
      log(`[fallback] ${reason}`);
      terminal.sendText(command, true);
      done();
    };

    if (tryExecute(terminal.shellIntegration)) {
      return;
    }

    const intSub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal !== terminal) {
        return;
      }
      if (tryExecute(e.shellIntegration)) {
        intSub.dispose();
        const i = disposables.indexOf(intSub);
        if (i >= 0) {
          disposables.splice(i, 1);
        }
      }
    });
    disposables.push(intSub);

    fallbackTimer = setTimeout(() => {
      if (activeExecution) {
        return;
      }
      intSub.dispose();
      const i = disposables.indexOf(intSub);
      if (i >= 0) {
        disposables.splice(i, 1);
      }
      fallbackSendText(`no shell integration within ${shellIntegrationWaitMs}ms`);
    }, shellIntegrationWaitMs);
  });

  return { exitCode: resolvedExit, output: capturedOutput, fallbackUsed };
}

export type SpawnRunOptions = {
  command: string;
  cwd: string;
  shell?: boolean | string;
  /** Run `$SHELL -lc command` so direnv/nix/PATH match an integrated terminal. */
  loginShell?: boolean;
  log: (chunk: string) => void;
  captureOutput?: boolean;
  /** Optional secondary chunk stream — same data as `log`, useful when one
   *  consumer wants to write to an output channel while another (e.g. a
   *  prompt detector) inspects it. Called once per chunk. */
  onChunk?: (chunk: string) => void;
  /**
   * Called once with the spawned ChildProcess so the caller can hold a
   * reference for stdin auto-confirm and SIGTERM-on-Stop. Fires after
   * `spawn()` succeeds; never called when the spawn itself errors (the
   * `error` event resolves the promise with `spawnError` instead).
   */
  onChild?: (child: cp.ChildProcess) => void;
};

export type SpawnRunResult = {
  exitCode: number | undefined;
  signal: NodeJS.Signals | null;
  output: string;
  /** Set when `spawn` itself errored (e.g. ENOENT). */
  spawnError?: Error;
};

/** Never rejects — spawn errors surface as `{ spawnError }`. */
export async function runViaSpawn(options: SpawnRunOptions): Promise<SpawnRunResult> {
  const {
    command,
    cwd,
    shell = true,
    loginShell = false,
    log,
    captureOutput = false,
    onChunk,
    onChild,
  } = options;

  return new Promise<SpawnRunResult>((resolve) => {
    let captured = "";
    let resolvedExit: number | undefined;
    let resolvedSignal: NodeJS.Signals | null = null;
    let spawnError: Error | undefined;

    const child = loginShell
      ? cp.spawn(process.env.SHELL || "/bin/zsh", ["-lc", command], {
          cwd,
          env: process.env,
          windowsHide: true,
        })
      : cp.spawn(command, {
          shell,
          cwd,
          env: process.env,
          windowsHide: true,
        });

    if (onChild) {
      try {
        onChild(child);
      } catch {
        // onChild is for the caller's bookkeeping; if it throws (e.g. the
        // controller already torn down) we don't want to abort the run.
      }
    }

    const handleData = (chunk: Buffer): void => {
      const t = chunk.toString();
      if (captureOutput) {
        captured = (captured + t).slice(-OUTPUT_TAIL_LIMIT);
      }
      log(t);
      if (onChunk) {
        try {
          onChunk(t);
        } catch {
          // Detector errors must not kill the run.
        }
      }
    };

    child.stdout?.on("data", handleData);
    child.stderr?.on("data", handleData);

    child.on("error", (err) => {
      spawnError = err;
      resolve({
        exitCode: undefined,
        signal: null,
        output: captured,
        spawnError,
      });
    });

    child.on("close", (code, signal) => {
      if (spawnError) {
        return; // already resolved via 'error'
      }
      resolvedExit = typeof code === "number" ? code : undefined;
      resolvedSignal = signal ?? null;
      resolve({
        exitCode: resolvedExit,
        signal: resolvedSignal,
        output: captured,
      });
    });
  });
}
