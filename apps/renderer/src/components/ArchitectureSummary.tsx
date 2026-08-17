import { useCallback, useEffect, useMemo, useState } from "react";
import type { ArchitectureProfile } from "@ai-ide/shared";
import { getBridge } from "../bridge";

function modSHint(): string {
  const isApple =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  return isApple ? "⌘S" : "Ctrl+S";
}

function modShiftHint(key: string): string {
  const isApple =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  return isApple ? `⌘⇧${key}` : `Ctrl+Shift+${key}`;
}

function chipList(profile: ArchitectureProfile | null): string[] {
  if (!profile) return [];
  const chips: string[] = [];
  if (profile.repo?.packageManager) chips.push(profile.repo.packageManager);
  if (profile.repo?.shape) chips.push(profile.repo.shape);
  for (const r of profile.runtimes) {
    chips.push(r.version ? `${r.id} ${r.version}` : r.id);
  }
  if (profile.backend?.language) chips.push(`BE ${profile.backend.language}`);
  for (const f of profile.backend?.frameworks ?? []) chips.push(f);
  if (profile.frontend?.language) chips.push(`FE ${profile.frontend.language}`);
  for (const f of profile.frontend?.frameworks ?? []) chips.push(f);
  if (profile.testing?.unit?.lib) chips.push(`unit:${profile.testing.unit.lib}`);
  if (profile.testing?.e2e?.lib) chips.push(`e2e:${profile.testing.e2e.lib}`);
  if (profile.api?.style) chips.push(profile.api.style);
  if (profile.data?.orm) chips.push(profile.data.orm);
  return chips.slice(0, 12);
}

type Props = {
  workspaceRoot: string | null | undefined;
  planning?: boolean;
  onOpenArchitecture?: (() => void) | undefined;
};

export function ArchitectureSummary(props: Props) {
  const { workspaceRoot, planning = false, onOpenArchitecture } = props;
  const [profile, setProfile] = useState<ArchitectureProfile | null>(null);
  const [fromFile, setFromFile] = useState(false);
  const [exists, setExists] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => {
    if (!workspaceRoot) {
      setProfile(null);
      setFromFile(false);
      setExists(false);
      return;
    }
    try {
      const res = await getBridge()?.workspace.architectureGet();
      if (!res) return;
      setProfile(res.profile);
      setFromFile(res.fromFile);
      setExists(res.exists);
      setError(res.error ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workspaceRoot]);

  useEffect(() => {
    void refresh();
  }, [refresh, tick, workspaceRoot]);

  // Re-poll occasionally while planning (agent may upsert).
  useEffect(() => {
    if (!planning || !workspaceRoot) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 4_000);
    return () => window.clearInterval(id);
  }, [planning, workspaceRoot]);

  const chips = useMemo(() => chipList(profile), [profile]);
  const needsConfirm = useMemo(() => {
    if (!profile) return false;
    if (!fromFile || !exists) return true;
    const sources = Object.values(profile.meta.sources);
    if (sources.length === 0) return true;
    return sources.some((s) => s !== "user_confirmed");
  }, [profile, fromFile, exists]);

  const confirmSave = useCallback(async () => {
    if (!profile || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await getBridge()?.workspace.architectureSave({
        profile,
        confirm: true,
      });
      if (!res?.ok) {
        setError(res?.error?.userMessage ?? "Save failed");
        setBusy(false);
        return;
      }
      setProfile(res.profile ?? profile);
      setFromFile(true);
      setExists(true);
      setBusy(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, [busy, profile]);

  useEffect(() => {
    if (!planning || !needsConfirm) return;
    // Widget hidden once the file exists — don't keep a silent ⌘S handler.
    if (exists && fromFile) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      void confirmSave();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [planning, needsConfirm, confirmSave, exists, fromFile]);

  if (!workspaceRoot) {
    return (
      <div className="arch-summary arch-summary-empty">
        <strong>Architecture</strong>
        <span className="muted">Open a workspace to detect the stack.</span>
      </div>
    );
  }

  // .aici/ARCHITECTURE.md already saved: stay out of the way (Edit is ⌘⇧A).
  // Shown only until the first confirm/save creates the file; hides on save.
  if (exists && fromFile && !error) {
    return null;
  }

  return (
    <div className={`arch-summary ${needsConfirm ? "arch-summary-draft" : ""}`}>
      <div className="arch-summary-header">
        <div>
          <strong>Architecture</strong>
          <span className="arch-summary-status muted">
            {fromFile
              ? ".aici/ARCHITECTURE.md"
              : profile
                ? "Detected draft — not saved"
                : "No profile yet"}
          </span>
        </div>
        <div className="arch-summary-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={() => setTick((n) => n + 1)}
            title="Refresh architecture"
          >
            Refresh
          </button>
          {onOpenArchitecture ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onOpenArchitecture}
              title={`Open architecture settings (${modShiftHint("A")})`}
            >
              Edit · {modShiftHint("A")}
            </button>
          ) : null}
          {needsConfirm && planning ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || !profile}
              onClick={() => void confirmSave()}
              title={`Confirm and save (${modSHint()})`}
            >
              Confirm · {modSHint()}
            </button>
          ) : null}
        </div>
      </div>
      {chips.length > 0 ? (
        <div className="arch-chips" aria-label="Stack">
          {chips.map((c) => (
            <span key={c} className="arch-chip">
              {c}
            </span>
          ))}
        </div>
      ) : (
        <p className="muted arch-summary-hint">
          Ask the agent to explore the repo, or confirm after detection.
        </p>
      )}
      {error ? <p className="arch-summary-error">{error}</p> : null}
    </div>
  );
}
