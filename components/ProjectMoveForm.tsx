"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { projectMoveRefusalMessage } from "@/lib/sidebar-actions";

/** What POST /api/projects/move?dryRun plans, as the confirmation shows it. */
export interface ProjectMovePlanSummary {
  source: string;
  targetDir: string;
  targetDirExists: boolean;
  /** The project's folder inside `targetDir`: the project keeps its own name. */
  destination: string;
  targetContents: { folders: number; files: number };
  sessionCount: number;
  warnings: string[];
}

export interface ProjectMoveOutcome {
  source: string;
  destination: string;
  movedSessions: number;
  warnings: string[];
  errors: string[];
}

type Phase = "idle" | "checking" | "moving";

/**
 * A project group's "Move project…" body (`components/SessionSidebar.tsx`),
 * a custom menu body: the destination folder, then Move.
 *
 * The typed path is the folder the project moves *into*: the project's own
 * folder keeps its name, so `~/Documents/testing` holds `…/testing/<project>`.
 * A destination that already holds anything is described before it is used
 * ("This folder contains 4 folders and 3 files") and needs a second,
 * explicitly worded confirmation — the files there are not touched, but a
 * move is the one sidebar action with no Undo.
 */
export function ProjectMoveForm({
  root,
  name,
  onMoved,
  onCancel,
  showCancel,
}: {
  /** The project's folder today. */
  root: string;
  /** The project's display name, for the heading and the destination preview. */
  name: string;
  onMoved: (outcome: ProjectMoveOutcome) => void;
  onCancel: () => void;
  /** Desktop body: its own Cancel. On a phone the sheet brings one. */
  showCancel: boolean;
}) {
  const { t } = useI18n();
  const [target, setTarget] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [plan, setPlan] = useState<ProjectMovePlanSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const value = target.trim();
  const busy = phase !== "idle";
  const existing = plan ? plan.targetContents.folders + plan.targetContents.files : 0;

  const request = async (dryRun: boolean) => {
    setError(null);
    let response: Response;
    try {
      response = await fetch("/api/projects/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, target: value, dryRun }),
      });
    } catch (err) {
      // A request that never got an answer may well have moved the folder:
      // saying "failed" would send the user looking for a project that is gone.
      setError(t("sidebar.moveProjectUnclear"));
      console.warn("[pi-web] project move request failed", err);
      return null;
    }
    const data = await response.json().catch(() => ({})) as {
      plan?: ProjectMovePlanSummary;
      moved?: ProjectMoveOutcome;
      code?: string;
      error?: string;
    };
    if (!response.ok) {
      const message = projectMoveRefusalMessage(data.code, data.error ?? `HTTP ${response.status}`);
      setError(t(message.key, message.params));
      return null;
    }
    return data;
  };

  const move = async () => {
    setPhase("moving");
    const data = await request(false);
    if (data?.moved) {
      onMoved(data.moved);
      return;
    }
    // The destination may have changed since the check: the next press asks again.
    setPlan(null);
    setPhase("idle");
  };

  const submit = async () => {
    if (!value || busy) return;
    // A second press after a warning is the confirmation: the destination was
    // already described, so it goes through even though it holds something.
    if (plan) {
      await move();
      return;
    }
    setPhase("checking");
    const data = await request(true);
    if (!data?.plan) {
      setPhase("idle");
      return;
    }
    setPlan(data.plan);
    const occupied = data.plan.targetContents.folders + data.plan.targetContents.files;
    if (occupied > 0) {
      setPhase("idle");
      return;
    }
    await move();
  };

  const primaryLabel = phase === "checking"
    ? t("sidebar.moveProjectChecking")
    : phase === "moving"
      ? t("sidebar.movingProject")
      : plan && existing > 0
        ? t("sidebar.moveProjectConfirm")
        : t("sidebar.moveProjectAction");

  return (
    <div className="sidebar-worktree-form sidebar-project-move">
      <div className="sidebar-menu-header" title={root}>{t("sidebar.moveProjectHeading", { name })}</div>
      <input
        className="sidebar-worktree-input"
        data-sidebar-menu-autofocus=""
        value={target}
        readOnly={busy}
        placeholder={t("sidebar.moveProjectPlaceholder")}
        aria-label={t("sidebar.moveProjectPathLabel")}
        onChange={(event) => {
          setTarget(event.target.value);
          // A new destination is checked again before it is used.
          setPlan(null);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          void submit();
        }}
      />
      <p className="sidebar-project-move-hint">{t("sidebar.moveProjectHint", { name })}</p>
      {plan && (
        <p className="sidebar-project-move-destination" title={plan.destination}>
          <span className="sidebar-project-move-arrow" aria-hidden="true">→</span>
          {plan.destination}
        </p>
      )}
      {plan && existing > 0 && (
        <p className="sidebar-project-move-warning" role="status">
          {t("sidebar.moveProjectWarning", { folders: plan.targetContents.folders, files: plan.targetContents.files })}
        </p>
      )}
      <div className="sidebar-worktree-form-buttons">
        <button type="button" className="sidebar-worktree-create" disabled={busy || !value} onClick={() => void submit()}>
          {primaryLabel}
        </button>
        {showCancel && (
          <button type="button" className="sidebar-worktree-cancel" onClick={onCancel} disabled={busy}>
            {t("sidebar.cancel")}
          </button>
        )}
      </div>
      {error && <div className="sidebar-worktree-error" role="alert">{error}</div>}
    </div>
  );
}
