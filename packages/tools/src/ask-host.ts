/**
 * Blocking user-question host injected by the desktop SessionManager.
 * The overlay and keyboard handling live in the host implementation —
 * the ask_user tool only awaits the answer.
 */

export type AgentAskAnswer = {
  /** Option ids the user picked (empty when they answered with free text only). */
  selectedOptionIds: string[];
  /** Labels matching {@link selectedOptionIds}, for a readable tool summary. */
  selectedLabels: string[];
  /** Free text the user typed, or "" when they only picked options. */
  text: string;
  /** True when the user dismissed the dialog instead of answering. */
  cancelled: boolean;
};

export type AskHost = {
  ask(params: {
    context?: string;
    prompt: string;
    selection?: "single" | "multiple";
    options: Array<{ id: string; label: string }>;
    allowFreeText?: boolean;
  }): Promise<AgentAskAnswer>;
};
