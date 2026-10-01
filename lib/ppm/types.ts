// Payload types for the .ppm plan-manager dashboard, mirroring what the
// reference CLI exposes via its /api/tasks endpoint.

export type PpmStatus = "todo" | "in_progress" | "completed" | "fail";

export interface PpmTask {
  id: string;
  title: string;
  detail: string;
  progress: string;
  status: PpmStatus;
  pre_request?: string[];
  files?: string[];
  agent?: string;
}

export interface PpmPhase {
  name: string;
  title: string;
  filePath: string;
  tasks: PpmTask[];
  errors: string[];
  warnings: string[];
  wave: Record<string, number>;
  criticalPath: string[];
}

export interface PpmPlan {
  name: string;
  createdAt: string | null;
  lastUpdated: string | null;
  errors: string[];
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
  currentProjectId: string | null;
  projects: PpmProject[];
}