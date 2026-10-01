"use client";

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  completionClass,
  currentPhaseName,
  filterPlans,
  matchesQuery,
  phaseAuditPrompt,
  phaseExecPrompt,
  phaseState,
  planAuditPrompt,
  planErrorCount,
  planExecPrompt,
  sortByCompletion,
  stats,
  taskBadge,
  waveCount,
} from "./project-plan-model";
import type {
  BadgeVariant,
  CompletionClass,
  PpmDashboard,
  PpmPhase,
  PpmPlan,
  PpmProject,
  PpmTask,
  PpmTaskStatus,
  PhaseState,
  PlanFilter,
  PlanStats,
  TaskBadgeInfo,
} from "./project-plan-model";

export interface ProjectPlanPanelProps {
  cwd: string;
  active: boolean; // false when the panel/tab is hidden -> stop polling
  onOpenFile: (filePath: string, fileName: string) => void; // "Open plan.md" -> AppShell opens FileViewer
  onInsertPrompt: (prompt: string) => void; // Execute/Audit -> insert into chat composer
}

const POLL_INTERVAL_MS = 5000;

// Fixed status/badge hues (from task.html design tokens).
const STATUS_COLOR: Record<PpmTaskStatus, string> = {
  completed: "#34d399",
  in_progress: "#38bdf8",
  fail: "#fb7185",
  todo: "#fbbf24",
};

const BADGE_COLOR: Record<BadgeVariant, string> = {
  ready: "#2dd4bf",
  blocked: "#fbbf24",
  stuck: "#fb7185",
  parallel: "#38bdf8",
  waiting: "#8996a8",
  current: "#2dd4bf",
  agent: "#a78bfa",
  wave: "#8996a8",
};

const BAR_COLOR: Record<CompletionClass, string> = {
  zero: "#39424f",
  partial: "#fbbf24",
  complete: "#34d399",
};

const PERCENT_COLOR: Record<CompletionClass, string> = {
  zero: "#8996a8",
  partial: "#fbbf24",
  complete: "#34d399",
};

const TITLE_COLOR: Record<CompletionClass, string> = {
  zero: "#c3ccd9",
  partial: "#fef3c7",
  complete: "#d1fae5",
};

const controlStyle: CSSProperties = {
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  color: "var(--text)",
  borderRadius: 6,
  padding: "5px 8px",
  fontSize: 12,
};

const buttonStyle: CSSProperties = {
  background: "var(--bg-hover)",
  border: "1px solid var(--border)",
  color: "var(--text-muted)",
  borderRadius: 6,
  padding: "6px 10px",
  fontSize: 11.5,
  fontWeight: 500,
  cursor: "pointer",
};

const buttonPrimaryStyle: CSSProperties = {
  ...buttonStyle,
  background: "#2dd4bf",
  border: "1px solid #2dd4bf",
  color: "#0a0e14",
  fontWeight: 600,
};

const mutedTextStyle: CSSProperties = { color: "var(--text-muted)", fontSize: 12 };

const emptyBoxStyle: CSSProperties = {
  color: "var(--text-muted)",
  fontSize: 13,
  border: "1px dashed var(--border)",
  borderRadius: 8,
  padding: 20,
  textAlign: "center",
};

const errorBoxStyle: CSSProperties = {
  color: "#fb7185",
  fontSize: 12.5,
  border: "1px solid rgba(251,113,133,0.35)",
  background: "rgba(251,113,133,0.08)",
  borderRadius: 8,
  padding: "10px 12px",
  wordBreak: "break-word",
};

const summaryStyle: CSSProperties = {
  cursor: "pointer",
  listStyle: "none",
  display: "flex",
  gap: 8,
  alignItems: "flex-start",
};

export function ProjectPlanPanel({ cwd, active, onOpenFile, onInsertPrompt }: ProjectPlanPanelProps) {
  const { t } = useI18n();

  const [data, setData] = useState<PpmDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState("");
  const [filter, setFilter] = useState<PlanFilter>("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Map<string, boolean>>(new Map());
  const [refreshing, setRefreshing] = useState(false);
  const loadRef = useRef<(kind: "initial" | "poll" | "manual") => void>(() => {});
  const queryTrimmed = query.trim();

  // Fetch on mount and whenever cwd changes; poll every 5s only while active.
  // Aborts and clears the interval on unmount / dependency change.
  useEffect(() => {
    let stopped = false;
    let controller: AbortController | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;

    const load = async (kind: "initial" | "poll" | "manual") => {
      if (kind === "initial") setLoading(true);
      if (kind === "manual") setRefreshing(true);
      const current = new AbortController();
      controller?.abort();
      controller = current;
      try {
        const response = await fetch(`/api/ppm?cwd=${encodeURIComponent(cwd)}&scope=registered`, {
          cache: "no-store",
          signal: current.signal,
        });
        if (!response.ok) throw new Error(await response.text());
        const json = (await response.json()) as PpmDashboard;
        if (stopped || controller !== current) return;
        setData(json);
        setError(null);
      } catch (cause) {
        if (stopped || controller !== current) return;
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (controller === current) controller = null;
        if (kind === "initial") setLoading(false);
        if (kind === "manual") setRefreshing(false);
      }
    };

    loadRef.current = load;
    void load("initial");

    if (active) {
      interval = setInterval(() => void load("poll"), POLL_INTERVAL_MS);
    }

    return () => {
      stopped = true;
      if (interval !== null) clearInterval(interval);
      controller?.abort();
    };
  }, [active, cwd]);

  // Preselect currentProjectId (or the first project) and keep the selection
  // across refreshes while the selected project still exists.
  useEffect(() => {
    if (!data) return;
    setProjectId((prev) => {
      if (data.projects.some((project) => project.id === prev)) return prev;
      return data.currentProjectId ?? data.projects[0]?.id ?? "";
    });
  }, [data]);

  const handleRefresh = () => {
    loadRef.current("manual");
  };
  const handleProjectChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setProjectId(event.target.value);
  };
  const handleFilterChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setFilter(event.target.value as PlanFilter);
  };
  const handleQueryChange = (event: ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
  };

  const isOpen = (key: string, fallback: boolean): boolean => {
    const value = open.get(key);
    return value === undefined ? fallback : value;
  };

  // Controlled accordion. Plans/phases are force-opened while a search query is
  // active; that forced state is never persisted (forceLocked). Task rows are
  // never force-opened, so their toggles always persist.
  const handleToggle = (key: string, next: boolean, forceLocked: boolean) => {
    if (forceLocked && queryTrimmed !== "") return;
    setOpen((prev) => {
      const nextMap = new Map(prev);
      nextMap.set(key, next);
      return nextMap;
    });
  };

  const renderChevron = (opened: boolean): ReactNode => (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      style={{
        flexShrink: 0,
        marginTop: 3,
        color: "var(--text-dim)",
        transform: opened ? "rotate(90deg)" : undefined,
        transition: "transform .18s ease",
      }}
    >
      <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );

  const renderBadge = (variant: BadgeVariant, label: string, hint?: string): ReactNode => (
    <span
      title={hint}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        fontSize: 10,
        lineHeight: "16px",
        fontWeight: 600,
        letterSpacing: "0.03em",
        padding: "0 6px",
        borderRadius: 999,
        border: `1px solid ${BADGE_COLOR[variant]}59`,
        background: `${BADGE_COLOR[variant]}14`,
        color: BADGE_COLOR[variant],
        fontFamily: "var(--font-mono)",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );

  const renderProgressBar = (percent: number, variant: CompletionClass): ReactNode => (
    <div
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      style={{ height: 4, width: "100%", borderRadius: 999, background: "var(--bg)", overflow: "hidden" }}
    >
      <div style={{ height: "100%", borderRadius: 999, background: BAR_COLOR[variant], width: `${percent}%` }} />
    </div>
  );

  const renderCompletionBadge = (planStats: PlanStats): ReactNode => {
    const variant = completionClass(planStats.percent);
    return (
      <span style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
            color: PERCENT_COLOR[variant],
          }}
        >
          {planStats.percent}%
        </span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)" }}>
          {planStats.completed}/{planStats.total}
        </span>
      </span>
    );
  };

  const renderNotice = (kind: "error" | "warning", items: string[]): ReactNode => {
    if (!items.length) return null;
    const isError = kind === "error";
    return (
      <div
        style={{
          fontSize: 11.5,
          fontFamily: "var(--font-mono)",
          border: `1px solid ${isError ? "#fb71855e" : "#fbbf245e"}`,
          background: isError ? "rgba(251,113,133,0.10)" : "rgba(251,191,36,0.09)",
          color: isError ? "#fb7185" : "#fcd34d",
          borderRadius: 8,
          padding: "6px 8px",
          margin: "8px 0",
          wordBreak: "break-word",
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 2 }}>
          {t(isError ? "plan.errors" : "plan.warnings", { count: items.length })}
        </div>
        {items.map((item) => (
          <div key={item}>• {item}</div>
        ))}
      </div>
    );
  };

  const renderTaskBadgeInfo = (info: TaskBadgeInfo): ReactNode => {
    switch (info.kind) {
      case "waitingPhase":
        return renderBadge(info.variant, t("plan.waitingPhase"), t("plan.waitingHint", { name: info.current }));
      case "ready":
        return renderBadge(info.variant, t("plan.ready"), t("plan.readyHint"));
      case "parallel":
        return renderBadge(info.variant, t("plan.parallel"), t("plan.parallelHint"));
      case "stuck":
        return renderBadge(
          info.variant,
          t("plan.stuck", { ids: info.ids.join(", ") }),
          t("plan.stuckHint", { ids: info.ids.join(", ") }),
        );
      case "blocked":
        return renderBadge(
          info.variant,
          t("plan.blocked", { ids: info.ids.join(", ") }),
          t("plan.blockedHint", { ids: info.ids.join(", ") }),
        );
    }
  };

  const renderMetaLine = (label: string, values: string[]): ReactNode => (
    <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-dim)", wordBreak: "break-all" }}>
      {label}: {values.join(", ")}
    </div>
  );

  const renderSection = (label: string, body: string): ReactNode => (
    <section style={{ marginTop: 8 }}>
      <div style={{ color: "var(--text-dim)", fontSize: 10.5, fontWeight: 600, letterSpacing: "0.04em" }}>{label}</div>
      <div
        style={{
          fontSize: 12.5,
          color: "var(--text-muted)",
          lineHeight: 1.45,
          marginTop: 2,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {body}
      </div>
    </section>
  );

  const renderTask = (
    task: PpmTask,
    ctx: { statusById: Map<string, string>; phaseState: PhaseState; current: string | null },
    wave: Record<string, number>,
    taskKey: string,
  ): ReactNode => {
    const color = STATUS_COLOR[task.status];
    const opened = isOpen(taskKey, false);
    const badgeInfo = taskBadge(task, ctx);
    const waveIndex = wave[task.id];
    const deps = task.pre_request ?? [];
    const files = task.files ?? [];
    return (
      <details
        key={taskKey}
        open={opened}
        style={{
          borderLeft: `2px solid ${color}`,
          background: "var(--bg-panel)",
          borderRadius: "0 8px 8px 0",
          margin: "6px 0",
          padding: "4px 10px",
        }}
      >
        <summary
          onClick={(event) => {
            event.preventDefault();
            handleToggle(taskKey, !opened, false);
          }}
          style={{
            cursor: "pointer",
            listStyle: "none",
            display: "flex",
            alignItems: "center",
            gap: 8,
            justifyContent: "space-between",
            flexWrap: "wrap",
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: color, flexShrink: 0 }} />
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-dim)", flexShrink: 0 }}>
              {task.id}
            </span>
            <span
              style={{
                fontSize: 13,
                color: "var(--text)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                minWidth: 0,
              }}
            >
              {task.title}
            </span>
          </span>
          <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{task.status}</span>
            {waveIndex ? renderBadge("wave", t("plan.waveBadge", { index: waveIndex }), t("plan.waveHint", { index: waveIndex })) : null}
            {task.agent ? renderBadge("agent", task.agent, t("plan.agentHint")) : null}
            {badgeInfo ? renderTaskBadgeInfo(badgeInfo) : null}
          </span>
        </summary>
        <div style={{ paddingTop: 6 }}>
          {deps.length ? renderMetaLine(t("plan.preRequest"), deps) : null}
          {task.agent ? renderMetaLine(t("plan.agent"), [task.agent]) : null}
          {files.length ? renderMetaLine(t("plan.files"), files) : null}
          {renderSection(t("plan.detail"), task.detail)}
          {task.progress ? renderSection(t("plan.progress"), task.progress) : null}
        </div>
      </details>
    );
  };

  const renderPhase = (plan: PpmPlan, phase: PpmPhase, planKey: string, current: string | null): ReactNode => {
    const phaseStats = stats([phase]);
    const variant = completionClass(phaseStats.percent);
    const state = phaseState(plan, phase.name, current);
    const phaseKey = `${planKey}/${phase.name}`;
    const opened = queryTrimmed ? true : isOpen(phaseKey, state === "current");
    const wave = phase.wave ?? {};
    const ctx = {
      statusById: new Map<string, string>((phase.tasks ?? []).map((task) => [task.id, task.status])),
      phaseState: state,
      current,
    };
    const visibleTasks = queryTrimmed
      ? (phase.tasks ?? []).filter((task) => matchesQuery(task, queryTrimmed))
      : phase.tasks ?? [];
    // While searching, phases without any matching task are hidden.
    if (queryTrimmed && visibleTasks.length === 0) return null;
    const errors = phase.errors ?? [];
    const warnings = phase.warnings ?? [];
    const critical = (phase.criticalPath ?? []).join(" → ") || "—";
    return (
      <details
        key={phaseKey}
        open={opened}
        style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", minWidth: 0 }}
      >
        <summary
          onClick={(event) => {
            event.preventDefault();
            handleToggle(phaseKey, !opened, true);
          }}
          style={summaryStyle}
        >
          {renderChevron(opened)}
          <div style={{ minWidth: 0, marginRight: "auto" }}>
            <div
              style={{
                fontSize: 13.5,
                fontWeight: 600,
                color: TITLE_COLOR[variant],
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {phase.title}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 2 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-dim)" }}>{phase.name}</span>
              {state === "current" ? renderBadge("current", t("plan.current")) : null}
              {state === "waiting" ? renderBadge("waiting", t("plan.waiting")) : null}
              {errors.length ? renderBadge("stuck", t("plan.errorCount", { count: errors.length })) : null}
              {warnings.length ? renderBadge("blocked", t("plan.warnCount", { count: warnings.length })) : null}
            </div>
          </div>
          {renderCompletionBadge(phaseStats)}
        </summary>
        <div style={{ paddingTop: 6 }}>
          {renderProgressBar(phaseStats.percent, variant)}
          {(phase.tasks ?? []).length > 0 ? (
            <div style={{ fontSize: 10.5, fontFamily: "var(--font-mono)", color: "var(--text-dim)", marginTop: 4, wordBreak: "break-word" }}>
              {t("plan.waveCount", { count: waveCount(phase) })} · {t("plan.criticalPath", { path: critical })}
            </div>
          ) : null}
          {renderNotice("error", errors)}
          {renderNotice("warning", warnings)}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            <button type="button" style={buttonPrimaryStyle} onClick={() => onInsertPrompt(phaseExecPrompt(plan.name, phase.name))}>
              {t("plan.executePhase")}
            </button>
            <button type="button" style={buttonStyle} onClick={() => onInsertPrompt(phaseAuditPrompt(plan.name, phase.name))}>
              {t("plan.auditPhase")}
            </button>
          </div>
          {visibleTasks.map((task) => renderTask(task, ctx, wave, `${phaseKey}/${task.id}`))}
          {!queryTrimmed && visibleTasks.length === 0 ? <div style={mutedTextStyle}>{t("plan.noTasks")}</div> : null}
        </div>
      </details>
    );
  };

  const renderPlan = (project: PpmProject, plan: PpmPlan): ReactNode => {
    const planStats = stats(plan.phases);
    const variant = completionClass(planStats.percent);
    const current = currentPhaseName(plan);
    const planKey = `${project.id}/${plan.name}`;
    const opened = queryTrimmed ? true : isOpen(planKey, false);
    const phases = (plan.phases ?? []).map((phase) => renderPhase(plan, phase, planKey, current)).filter(Boolean);
    // While searching, hide the plan when none of its phases matched.
    if (queryTrimmed && phases.length === 0) return null;
    const errorTotal = planErrorCount(plan);
    const planPath = project.path.replace(/[/\\]+$/, "");
    return (
      <details
        key={planKey}
        open={opened}
        style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 12, padding: 8, marginBottom: 8, minWidth: 0 }}
      >
        <summary
          onClick={(event) => {
            event.preventDefault();
            handleToggle(planKey, !opened, true);
          }}
          style={summaryStyle}
        >
          {renderChevron(opened)}
          <div style={{ minWidth: 0, marginRight: "auto" }}>
            <div
              style={{
                fontSize: 14.5,
                fontWeight: 600,
                color: TITLE_COLOR[variant],
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {plan.name}
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-dim)", marginTop: 1 }}>
              {t("plan.created", { date: plan.createdAt ?? "—" })} · {t("plan.updated", { date: plan.lastUpdated ?? "—" })}
            </div>
          </div>
          <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flexShrink: 0 }}>
            {renderCompletionBadge(planStats)}
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {errorTotal > 0 ? renderBadge("stuck", t("plan.errorCount", { count: errorTotal }), "plan_validate would fail") : null}
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("plan.phaseCount", { count: (plan.phases ?? []).length })}</span>
            </span>
          </span>
        </summary>
        <div style={{ paddingTop: 6 }}>
          {renderProgressBar(planStats.percent, variant)}
          {renderNotice("error", plan.errors ?? [])}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "8px 0" }}>
            <button type="button" style={buttonPrimaryStyle} onClick={() => onInsertPrompt(planExecPrompt(plan.name))}>
              {t("plan.executePlan")}
            </button>
            <button type="button" style={buttonStyle} onClick={() => onInsertPrompt(planAuditPrompt(plan.name))}>
              {t("plan.auditPlan")}
            </button>
            <button type="button" style={buttonStyle} onClick={() => onOpenFile(`${planPath}/.ppm/${plan.name}/plan.md`, "plan.md")}>
              {t("plan.openPlanMd")}
            </button>
          </div>
          {phases.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{phases}</div>
          ) : (
            <div style={mutedTextStyle}>{t("plan.noPhases")}</div>
          )}
        </div>
      </details>
    );
  };

  const renderBody = (): ReactNode => {
    if (loading && !data) return <div style={mutedTextStyle}>{t("plan.loading")}</div>;
    if (error) {
      return (
        <div style={errorBoxStyle}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>{t("plan.loadError")}</div>
          <div>{error}</div>
        </div>
      );
    }
    if (!data) return <div style={mutedTextStyle}>{t("plan.loading")}</div>;
    if (data.projects.length === 0) return <div style={emptyBoxStyle}>{t("plan.noProjects")}</div>;
    const project = data.projects.find((item) => item.id === projectId) ?? data.projects[0];
    if (project.error) return <div style={errorBoxStyle}>{project.error}</div>;
    const plans = sortByCompletion(
      filterPlans(project.plans, filter).map((plan) => ({ plan, stats: stats(plan.phases) })),
    );
    const rendered = plans.map(({ plan }) => renderPlan(project, plan)).filter(Boolean);
    if (!rendered.length) return <div style={emptyBoxStyle}>{t("plan.noPlans")}</div>;
    return <div style={{ display: "flex", flexDirection: "column" }}>{rendered}</div>;
  };

  return (
    <div
      style={{
        height: "100%",
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "10px 12px",
        boxSizing: "border-box",
      }}
    >
      <style>{`summary::-webkit-details-marker{display:none}`}</style>
      <header style={{ flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", paddingBottom: 8, borderBottom: "1px solid var(--border)", marginBottom: 8 }}>
          <strong style={{ fontSize: 15, color: "var(--text)", marginRight: "auto" }}>{t("plan.title")}</strong>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            aria-label={t("plan.refresh")}
            style={{ ...buttonStyle, opacity: refreshing ? 0.6 : 1 }}
          >
            {t("plan.refresh")}
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {data && data.projects.length > 1 ? (
            <select value={projectId} onChange={handleProjectChange} aria-label={t("plan.project")} style={controlStyle}>
              {data.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name} — {project.path}
                </option>
              ))}
            </select>
          ) : null}
          <select value={filter} onChange={handleFilterChange} aria-label={t("plan.filter")} style={controlStyle}>
            <option value="all">{t("plan.filterAll")}</option>
            <option value="zero">{t("plan.filterZero")}</option>
            <option value="partial">{t("plan.filterPartial")}</option>
            <option value="complete">{t("plan.filterComplete")}</option>
          </select>
          <input
            type="search"
            value={query}
            onChange={handleQueryChange}
            placeholder={t("plan.search")}
            aria-label={t("plan.search")}
            style={{ ...controlStyle, flex: 1, minWidth: 120 }}
          />
        </div>
      </header>
      <main style={{ flex: 1 }}>{renderBody()}</main>
    </div>
  );
}