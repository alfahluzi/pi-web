/**
 * Pure view-model for the Project Plan Manager dashboard.
 * Mirrors the logic of templates/task.html (Project Plan Manager UI reference).
 * No React, no DOM — unit-tested by components/project-plan-model.test.mjs.
 */

export type PpmTaskStatus = "todo" | "in_progress" | "completed" | "fail";

export interface PpmTask {
  id: string;
  title: string;
  detail: string;
  progress: string;
  status: PpmTaskStatus;
  pre_request?: string[];
  files?: string[];
  agent?: string;
}

export interface PpmPhase {
  name: string;
  title: string;
  filePath?: string;
  tasks: PpmTask[];
  errors?: string[];
  warnings?: string[];
  wave?: Record<string, number>;
  criticalPath?: string[];
}

export interface PpmPlan {
  name: string;
  createdAt?: string | null;
  lastUpdated?: string | null;
  errors?: string[];
  phases: PpmPhase[];
}

export interface PpmProject {
  id: string;
  name: string;
  path: string;
  error?: string;
  plans: PpmPlan[];
}

export interface PpmDashboard {
  generatedAt: string;
  currentProjectId?: string | null;
  projects: PpmProject[];
}

export type CompletionClass = "zero" | "partial" | "complete";
export type PhaseState = "current" | "waiting" | "done";
export type PlanFilter = "all" | "zero" | "partial" | "complete";
export type BadgeVariant = "ready" | "blocked" | "stuck" | "parallel" | "waiting" | "current" | "agent" | "wave";

export interface PlanStats {
  completed: number;
  total: number;
  percent: number;
}

export type TaskBadgeInfo =
  | { variant: "waiting"; kind: "waitingPhase"; current: string }
  | { variant: "ready"; kind: "ready" }
  | { variant: "parallel"; kind: "parallel" }
  | { variant: "stuck"; kind: "stuck"; ids: string[] }
  | { variant: "blocked"; kind: "blocked"; ids: string[] };

const list = (value?: string[]): string[] => (Array.isArray(value) ? value : []);

/** Mirror of task.html `stats`: completed count, total, rounded percent. */
export function stats(phases: PpmPhase[]): PlanStats {
  const tasks = (phases ?? []).flatMap((phase) => phase.tasks ?? []);
  const completed = tasks.filter((task) => task.status === "completed").length;
  return {
    completed,
    total: tasks.length,
    percent: tasks.length ? Math.round((completed * 100) / tasks.length) : 0,
  };
}

/** 100 -> complete, 0 -> zero, otherwise partial. */
export function completionClass(percent: number): CompletionClass {
  return percent === 100 ? "complete" : percent === 0 ? "zero" : "partial";
}

/** Mirror of ppm plan_status: first phase that is not fully completed. */
export function currentPhaseName(plan: PpmPlan): string | null {
  const found = (plan.phases ?? []).find((phase) =>
    (phase.tasks ?? []).some((task) => task.status !== "completed"),
  );
  return found?.name ?? null;
}

/** Phases before the current one are done, ones after it are waiting. */
export function phaseState(plan: PpmPlan, phaseName: string, current: string | null): PhaseState {
  if (phaseName === current) return "current";
  if (current) {
    const names = (plan.phases ?? []).map((phase) => phase.name);
    if (names.indexOf(phaseName) > names.indexOf(current)) return "waiting";
  }
  return "done";
}

/**
 * Mirror of task.html TaskBadge: only todo tasks get a badge.
 * Phase order first ("waiting phase"), then pre_request — a failed
 * dependency means "stuck", not merely "blocked".
 */
export function taskBadge(
  task: PpmTask,
  ctx: { statusById: Map<string, string>; phaseState: PhaseState; current: string | null },
): TaskBadgeInfo | null {
  if (task.status !== "todo") return null;
  if (ctx.phaseState === "waiting") {
    return { variant: "waiting", kind: "waitingPhase", current: ctx.current ?? "" };
  }
  const deps = list(task.pre_request);
  const unmet = deps.filter((id) => ctx.statusById.get(id) !== "completed");
  if (unmet.length === 0) {
    return deps.length > 0
      ? { variant: "ready", kind: "ready" }
      : { variant: "parallel", kind: "parallel" };
  }
  const failed = unmet.filter((id) => ctx.statusById.get(id) === "fail");
  if (failed.length > 0) return { variant: "stuck", kind: "stuck", ids: failed };
  return { variant: "blocked", kind: "blocked", ids: unmet };
}

/** Case-insensitive search over id/title/detail/progress/status/agent/files. */
export function matchesQuery(task: PpmTask, query: string): boolean {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return true;
  const haystack = [task.id, task.title, task.detail, task.progress, task.status, task.agent, ...list(task.files)];
  return haystack.some((value) => String(value ?? "").toLowerCase().includes(q));
}

export function filterPlans(plans: PpmPlan[], filter: PlanFilter): PpmPlan[] {
  if (filter === "all") return plans;
  return plans.filter((plan) => completionClass(stats(plan.phases).percent) === filter);
}

/** Ascending completion; ties keep their original order (stable sort). */
export function sortByCompletion<T extends { stats: PlanStats }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.stats.percent - b.stats.percent);
}

/** Highest wave value of a phase; 0 when no waves are defined. */
export function waveCount(phase: PpmPhase): number {
  return Math.max(0, ...Object.values(phase.wave ?? {}));
}

/** plan.errors plus every phase's errors. */
export function planErrorCount(plan: PpmPlan): number {
  return (
    list(plan.errors).length +
    (plan.phases ?? []).reduce((sum, phase) => sum + list(phase.errors).length, 0)
  );
}

export function planExecPrompt(planName: string): string {
  return `Execute ${planName} using Project-Plan-Manager skill`;
}

export function planAuditPrompt(planName: string): string {
  return `Audit ${planName} using Project-Plan-Manager skill`;
}

export function phaseExecPrompt(planName: string, phaseName: string): string {
  return `Execute ${planName} only Phase ${phaseName} using Project-Plan-Manager skill. Phases are sequential; tasks with empty pre_request are parallel-eligible. Act as orchestrator: dispatch each ppm task_ready task to a sub agent matching its agent hint, verify, then mark status.`;
}

export function phaseAuditPrompt(planName: string, phaseName: string): string {
  return `Audit ${planName} only Phase ${phaseName} using Project-Plan-Manager skill. Report briefly`;
}