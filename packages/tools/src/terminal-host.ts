/**
 * Interactive multi-PTY host injected by the desktop SessionManager.
 * Soft-confirm (3s) and ask UI live in the host implementation — tools only await results.
 */

export type TerminalInfo = {
  id: string;
  title: string;
  status: "running" | "exited";
  pid: number | null;
  cwd: string;
  exitCode: number | null;
};

export type TerminalReadResult = {
  id: string;
  status: "running" | "exited";
  output: string;
  exitCode: number | null;
  byteLength: number;
};

export type TerminalWriteResult = {
  written: boolean;
  cancelled: boolean;
  /** Exact bytes sent (or that would have been sent). */
  text: string;
  output: string;
  status: "running" | "exited";
  exitCode: number | null;
};

export type TerminalAskResult = {
  selectedOptionId: string | null;
  text: string;
  written: boolean;
  cancelled: boolean;
  output: string;
};

export type TerminalHost = {
  open(opts?: { title?: string; cwd?: string }): Promise<TerminalInfo>;
  list(): TerminalInfo[];
  read(id: string, opts?: { maxChars?: number }): TerminalReadResult;
  /**
   * Soft-confirm every agent write (3s auto-approve). User may edit exact text.
   */
  write(
    id: string,
    text: string,
    opts?: { appendNewline?: boolean; settleMs?: number },
  ): Promise<TerminalWriteResult>;
  /**
   * Exclusive A/B/C (+ free text via ⌘I). May write the resulting text to the PTY.
   */
  ask(params: {
    terminalId: string;
    prompt: string;
    options: Array<{ id: string; label: string }>;
    suggestedText?: string;
    writeToTerminal?: boolean;
    appendNewline?: boolean;
  }): Promise<TerminalAskResult>;
  close(id: string): Promise<{ closed: boolean }>;
};
