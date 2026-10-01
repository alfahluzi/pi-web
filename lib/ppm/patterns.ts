// Plan/phase naming patterns and valid value sets, ported 1:1 from
// project-plan-manager's bin/commands/_shared/patterns.js.

export const PLAN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const PHASE_PATTERN = /^phase_[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const VALID_STATUSES = new Set(["todo", "in_progress", "completed", "fail"]);
// Client-agnostic role hints; the orchestrator maps them to whatever sub agents exist.
export const VALID_AGENTS = new Set(["explore", "implement", "review", "verify"]);