/**
 * Tab identity for the Project Plan Manager panel. One deterministic tab per
 * workspace, so switching between workspaces reuses the same in-app tab.
 */

export interface PlanTab {
  id: string;
  cwd: string;
}

export function newPlanTab(cwd: string): PlanTab {
  return { id: `plan:${cwd}`, cwd };
}