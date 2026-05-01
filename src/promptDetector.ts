/**
 * Streaming pattern detector for transparent-mode fcli runs. Caller feeds raw
 * stdout/stderr chunks; detector emits semantic events that the run harness
 * maps to OS notifications and VS Code toasts.
 *
 * Pure / framework-free so it's trivial to unit test. The fcli run module
 * wires events to side effects (osNotify, vscode.window.showInformationMessage,
 * stdin auto-confirm).
 */

export type DetectedEvent =
  /** fcli is asking the user to physically touch the YubiKey. */
  | { kind: "yubikey_touch_requested" }
  /** fcli (or git) hit a merge/rebase/cherry-pick conflict. */
  | { kind: "conflict_detected"; line: string }
  /** A `[y/n]` style prompt appeared. The harness should auto-fill `y\n`
   *  on stdin for the FIRST occurrence and surface a notification on
   *  subsequent occurrences (caller tracks the count). */
  | { kind: "yes_no_prompt"; line: string }
  /** A python traceback / unhandled-error line appeared in the output.
   *  Surfaced as a non-fatal hint; the run's exit code is still authoritative. */
  | { kind: "error_line"; line: string };

export type PromptDetectorOptions = {
  /** Receives every detected event in chunk order. */
  onEvent: (event: DetectedEvent) => void;
};

// eslint-disable-next-line no-control-regex
const ANSI_SGR = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * Patterns are intentionally broad to catch wording variants across fcli
 * versions and across upstream signers (yubikey-agent, ssh-agent, gpg-agent).
 * False-positive cost is low (we only fire a notification); false-negative
 * cost is high (silent stuck run). Keep them anchored to recognisable
 * keywords, not exact phrases.
 */
const YUBIKEY_RES: readonly RegExp[] = [
  /touch\s+(your\s+)?yubikey/i,
  /touch\s+(the\s+)?security\s+key/i,
  /please\s+touch/i,
  /confirm\s+(presence|with).*yubikey/i,
  /tap\s+(your\s+)?yubikey/i,
];

const CONFLICT_RES: readonly RegExp[] = [
  /^CONFLICT\b/m,
  /\bAutomatic merge failed\b/i,
  /\bcould not apply\b.*conflict/i,
  /\bmerge conflict in\b/i,
  /\brebase.*stopped at/i,
];

const YES_NO_RE = /(?:^|[^a-z0-9])\[\s*y\s*\/\s*n\s*\]\s*[?:]?\s*$/im;

const ERROR_RES: readonly RegExp[] = [
  /^Traceback \(most recent call last\):/m,
  /^Error:\s+/m,
  /^FATAL:\s+/m,
];

export class PromptDetector {
  private buffer = "";
  /** Tracks emission state so a single contiguous prompt doesn't double-fire
   *  while the user is mid-touch. Reset by `reset()` (call between runs). */
  private state: {
    yubikeyActive: boolean;
    /** lineCount of YES_NO matches we've already emitted, so a third prompt
     *  re-emits even if the second one only differs in whitespace. */
    lastYesNoLineIndex: number;
    conflictEmittedForCurrentRun: boolean;
  } = {
    yubikeyActive: false,
    lastYesNoLineIndex: -1,
    conflictEmittedForCurrentRun: false,
  };
  private lineIndex = 0;

  constructor(private readonly options: PromptDetectorOptions) {}

  /** Feed a stdout/stderr chunk. Internally line-buffers so multi-line
   *  patterns (`Traceback` etc) match cleanly even when chunks split lines. */
  push(chunk: string): void {
    if (!chunk) {
      return;
    }
    const cleaned = chunk.replace(ANSI_SGR, "");
    this.buffer += cleaned;
    let nlIdx = this.buffer.indexOf("\n");
    while (nlIdx !== -1) {
      const line = this.buffer.slice(0, nlIdx);
      this.buffer = this.buffer.slice(nlIdx + 1);
      this.processLine(line);
      this.lineIndex++;
      nlIdx = this.buffer.indexOf("\n");
    }
    // For prompts that end without newline (the [y/n] case fcli prints with
    // just a trailing space), check the unterminated buffer too.
    this.scanPending(this.buffer);
  }

  /** Forget mid-line state. Call when starting a new run with the same
   *  detector instance. */
  reset(): void {
    this.buffer = "";
    this.state = {
      yubikeyActive: false,
      lastYesNoLineIndex: -1,
      conflictEmittedForCurrentRun: false,
    };
    this.lineIndex = 0;
  }

  private processLine(line: string): void {
    if (CONFLICT_RES.some((re) => re.test(line))) {
      if (!this.state.conflictEmittedForCurrentRun) {
        this.state.conflictEmittedForCurrentRun = true;
        this.options.onEvent({ kind: "conflict_detected", line });
      }
    }
    if (ERROR_RES.some((re) => re.test(line))) {
      this.options.onEvent({ kind: "error_line", line });
    }
    if (YUBIKEY_RES.some((re) => re.test(line))) {
      if (!this.state.yubikeyActive) {
        this.state.yubikeyActive = true;
        this.options.onEvent({ kind: "yubikey_touch_requested" });
      }
    } else if (
      this.state.yubikeyActive &&
      line.trim().length > 0 &&
      !YUBIKEY_RES.some((re) => re.test(line))
    ) {
      // Reset so a *next* yubikey prompt later in the run can fire again.
      this.state.yubikeyActive = false;
    }
    if (YES_NO_RE.test(line)) {
      this.options.onEvent({ kind: "yes_no_prompt", line });
      this.state.lastYesNoLineIndex = this.lineIndex;
    }
  }

  private scanPending(pending: string): void {
    if (!pending) {
      return;
    }
    if (YUBIKEY_RES.some((re) => re.test(pending))) {
      if (!this.state.yubikeyActive) {
        this.state.yubikeyActive = true;
        this.options.onEvent({ kind: "yubikey_touch_requested" });
      }
    }
    if (YES_NO_RE.test(pending)) {
      // Only emit once per identical pending buffer to avoid spamming as the
      // same trailing prompt is re-scanned on subsequent chunks.
      if (this.state.lastYesNoLineIndex !== this.lineIndex) {
        this.options.onEvent({ kind: "yes_no_prompt", line: pending });
        this.state.lastYesNoLineIndex = this.lineIndex;
      }
    }
  }
}
