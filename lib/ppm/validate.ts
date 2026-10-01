// Phase-file validation, ported 1:1 from project-plan-manager's
// bin/commands/_shared/phase.js (pure: no fs access). Error strings are kept
// byte-for-byte identical so the UI matches the CLI output.

import path from "path";
import { PHASE_PATTERN, PLAN_PATTERN, VALID_AGENTS, VALID_STATUSES } from "./patterns";

export { PHASE_PATTERN, PLAN_PATTERN, VALID_AGENTS, VALID_STATUSES };

// Untyped JSON object; every field is narrowed before use.
type Loose = Record<string, unknown>;

export function phaseNumber(name: string): number {
  const match = /^phase_(\d+)$/.exec(name);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

// Legacy normalization applied before validation. fail_desc is folded into
// progress (not dropped) so no failure context is lost.
export function normalizeLegacy(phase: unknown): void {
  const tasks = (phase as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(tasks)) return;
  for (const item of tasks) {
    if (!item || typeof item !== "object") continue;
    const task = item as Loose;
    if (task.progress === undefined) task.progress = "";
    if (task.status === "start") task.status = "todo";
    if ("fail_desc" in task) {
      const legacy = typeof task.fail_desc === "string" ? task.fail_desc.trim() : "";
      if (legacy && typeof task.progress === "string" && !task.progress.includes(legacy))
        task.progress = [task.progress.trim(), `[legacy fail_desc] ${legacy}`].filter(Boolean).join("\n");
      delete task.fail_desc;
    }
  }
}

function validatePreRequest(task: Loose, index: number, ids: Set<string>): void {
  if (!("pre_request" in task)) return;
  const label = `tasks[${index}].pre_request`;
  if (!Array.isArray(task.pre_request)) throw new Error(`${label} must be an array of task ids`);
  const seen = new Set<string>();
  for (const dep of task.pre_request as unknown[]) {
    if (typeof dep !== "string" || !dep.trim()) throw new Error(`${label} entries must be non-empty strings`);
    if (dep === task.id) throw new Error(`${label} cannot reference the task itself: ${dep}`);
    if (!ids.has(dep)) throw new Error(`${label} references unknown task id in same phase: ${dep}`);
    if (seen.has(dep)) throw new Error(`${label} contains duplicate entry: ${dep}`);
    seen.add(dep);
  }
}

function detectCycles(tasks: Loose[]): void {
  const deps = new Map<string, string[]>();
  for (const task of tasks) deps.set(task.id as string, Array.isArray(task.pre_request) ? (task.pre_request as string[]) : []);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const visit = (id: string): void => {
    if (color.get(id) === GRAY) {
      const cycleStart = stack.indexOf(id);
      const cycle = [...stack.slice(cycleStart), id].join(" -> ");
      throw new Error(`pre_request cycle detected: ${cycle}`);
    }
    if (color.get(id) === BLACK) return;
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of deps.get(id) || []) visit(dep);
    stack.pop();
    color.set(id, BLACK);
  };
  for (const id of deps.keys()) color.set(id, WHITE);
  for (const id of deps.keys()) if (color.get(id) === WHITE) visit(id);
}

// Optional ownership list: repo-relative paths, dirs (trailing "/"), or globs (*, **, ?).
function validateFiles(task: Loose, index: number): void {
  if (!("files" in task)) return;
  const label = `tasks[${index}].files`;
  if (!Array.isArray(task.files)) throw new Error(`${label} must be an array of repo-relative paths or globs`);
  const seen = new Set<string>();
  for (const entry of task.files as unknown[]) {
    if (typeof entry !== "string" || !entry.trim()) throw new Error(`${label} entries must be non-empty strings`);
    if (path.isAbsolute(entry) || /^[A-Za-z]:/.test(entry)) throw new Error(`${label} must be repo-relative: ${entry}`);
    if (entry.split(/[\\/]/).includes("..")) throw new Error(`${label} must not contain "..": ${entry}`);
    if (seen.has(entry)) throw new Error(`${label} contains duplicate entry: ${entry}`);
    seen.add(entry);
  }
}

function validateAgent(task: Loose, index: number): void {
  if (!("agent" in task)) return;
  if (!VALID_AGENTS.has(task.agent as string)) throw new Error(`tasks[${index}].agent must be one of ${[...VALID_AGENTS].join("|")}: ${task.agent}`);
}

export function validatePhase(phase: unknown, expectedPhase: string): void {
  if (!phase || typeof phase !== "object" || Array.isArray(phase)) throw new Error("phase file root must be an object");
  const root = phase as Loose;
  if (root.phase !== expectedPhase) throw new Error(`phase field must equal ${expectedPhase}`);
  if (!Array.isArray(root.tasks)) throw new Error("tasks must be an array");
  const tasks = root.tasks as unknown[];
  const ids = new Set<string>();
  tasks.forEach((item, index) => {
    const label = `tasks[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${label} must be an object`);
    const task = item as Loose;
    for (const field of ["id", "title", "detail", "status"]) if (typeof task[field] !== "string" || !(task[field] as string).trim()) throw new Error(`${label}.${field} must be a non-empty string`);
    if (ids.has(task.id as string)) throw new Error(`duplicate task id: ${task.id}`);
    ids.add(task.id as string);
    if (!VALID_STATUSES.has(task.status as string)) throw new Error(`${label}.status is invalid: ${task.status}`);
    if (typeof task.progress !== "string") throw new Error(`${label}.progress must be a string`);
    validateFiles(task, index);
    validateAgent(task, index);
  });
  tasks.forEach((item, index) => validatePreRequest(item as Loose, index, ids));
  detectCycles(tasks.map((item) => item as Loose));
}
