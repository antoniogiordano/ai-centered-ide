import type { PreviewSetup } from "@ai-ide/shared";

/**
 * What the preview shows before it knows how to run the project.
 *
 * The IDE used to guess the dev script from its name and got it wrong on the
 * first real repo it met, so the question now goes to the agent — which can read
 * the README and the compose file — and the human signs off before any process
 * starts. The answer is then a fact in .aici/ARCHITECTURE.md, asked once.
 */
export function PreviewSetupBanner(props: {
  phase: "needs_command" | "needs_confirm";
  setup: PreviewSetup;
  busy: boolean;
  onAsk: () => void;
  onConfirm: () => void;
  onChange: () => void;
}) {
  const { phase, setup, busy, onAsk, onConfirm, onChange } = props;

  if (phase === "needs_confirm") {
    return (
      <div className="preview-setup" role="status">
        <h3 className="preview-setup-title">Run this to preview the app?</h3>
        <code className="preview-setup-command">{setup.command}</code>
        {setup.supportCount > 0 ? (
          <p className="preview-setup-note">
            Plus {setup.supportCount} support{" "}
            {setup.supportCount === 1 ? "process" : "processes"}, each in its
            own terminal.
          </p>
        ) : null}
        <p className="preview-setup-note">
          Proposed by the agent. Confirming stores it in{" "}
          <code>.aici/ARCHITECTURE.md</code>, so you are asked only once.
        </p>
        <div className="preview-setup-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            title="Start the dev processes and remember this command (Enter)"
            onClick={onConfirm}
          >
            Run · Enter
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            title="Tell the agent what is wrong with this command (⌘E)"
            onClick={onChange}
          >
            Change · ⌘E
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="preview-setup" role="status">
      <h3 className="preview-setup-title">
        This project has not said how to run itself
      </h3>
      <p className="preview-setup-note">
        The agent reads package.json, the README and any compose file, then
        writes a <code>dev</code> section in <code>.aici/ARCHITECTURE.md</code>.
        You confirm it before anything starts.
      </p>
      {setup.candidates.length ? (
        <ul className="preview-setup-candidates">
          {setup.candidates.map((candidate) => (
            <li key={candidate.name}>
              <code>{candidate.command}</code>
              {candidate.testVariant ? (
                <span className="preview-setup-flag">test variant</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="preview-setup-note">
          No dev script in package.json — the agent will have to find another
          way to start it.
        </p>
      )}
      <div className="preview-setup-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy}
          title="Ask the agent to work out the dev command (Enter)"
          onClick={onAsk}
        >
          {busy ? "Agent is working…" : "Ask the agent · Enter"}
        </button>
      </div>
    </div>
  );
}
