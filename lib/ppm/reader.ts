// Reads .ppm plan files from disk and builds the dashboard payload, ported 1:1
// from project-plan-manager's bin/commands/setup/helper.js (readConfig,
// planMetadata, readPlanData, readProjectData, dashboardProjects,
// readDashboardData) plus the workspace-root discovery used by the orchestrator.

import fs from "fs";
import os from "os";
import path from "path";
import { isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";
import { criticalPath, lintPhase, waves } from "./analysis";
import { PLAN_PATTERN, PHASE_PATTERN } from "./patterns";
import type { PpmDashboard, PpmPhase, PpmPlan, PpmProject } from "./types";
import { normalizeLegacy, phaseNumber, validatePhase } from "./validate";

const CONFIG_FILE = path.join(os.homedir(), ".config", "project-plan-manager", "config.json");
const CONFIG_ENV = "PI_WEB_PPM_CONFIG";

type ConfigEntry = { name?: unknown; path?: unknown };
type ConfigFile = { projects: ConfigEntry[] };

function configFilePath(): string {
  // Env override (absolute path) keeps tests hermetic; default matches the CLI.
  return process.env[CONFIG_ENV] ?? CONFIG_FILE;
}

function readConfig(file: string): ConfigFile {
  if (!fs.existsSync(file)) return { projects: [] };
  let config: { projects?: unknown };
  try {
    config = JSON.parse(fs.readFileSync(file, "utf8")) as { projects?: unknown };
  } catch (error) {
    throw new Error(`invalid config ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!config || !Array.isArray(config.projects)) throw new Error(`config projects must be an array: ${file}`);
  return config as ConfigFile;
}

// Nearest ancestor of cwd whose `.ppm` directory exists within the allowed roots.
function findWorkspaceProject(cwd: string, allowedRoots: Set<string>): string | null {
  let dir = path.resolve(cwd);
  for (let steps = 0; steps < 64; steps += 1) {
    let isPpmDirectory = false;
    try {
      isPpmDirectory = fs.statSync(path.join(dir, ".ppm")).isDirectory();
    } catch {
      // .ppm absent or unreadable; keep walking up.
    }
    if (isPpmDirectory && isFilePathAllowed(dir, allowedRoots) && isExistingFilePathAllowed(dir, allowedRoots)) {
      return fs.realpathSync(dir);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}

// Registered projects from the config that still exist and are allowed.
function registeredProjects(config: ConfigFile, allowedRoots: Set<string>): { id: string; name: string; path: string }[] {
  const seen = new Set<string>();
  const projects: { id: string; name: string; path: string }[] = [];
  for (const entry of config.projects) {
    if (!entry || typeof entry.path !== "string") continue;
    if (!fs.existsSync(path.join(entry.path, ".ppm"))) continue;
    if (!isFilePathAllowed(entry.path, allowedRoots)) continue;
    if (!isExistingFilePathAllowed(entry.path, allowedRoots)) continue;
    let real: string;
    try {
      real = fs.realpathSync(entry.path);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    const name = typeof entry.name === "string" && entry.name ? entry.name : path.basename(real);
    projects.push({ id: real, name, path: real });
  }
  return projects;
}

// Phase names under <planRoot>/tasks, ordered numerically (phase_2 before phase_10).
function listPhaseNames(planRoot: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(planRoot, "tasks"), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && PHASE_PATTERN.test(entry.name.slice(0, -5)))
    .map((entry) => entry.name.slice(0, -5))
    .sort((a, b) => phaseNumber(a) - phaseNumber(b) || a.localeCompare(b));
}

function planMetadata(content: string): { createdAt: string | null; lastUpdated: string | null } {
  const read = (label: string): string | null => {
    const match = new RegExp(`^\\s*${label}\\s*:\\s*(.*?)\\s*$`, "im").exec(content);
    return match && match[1] ? match[1].trim() : null;
  };
  return { createdAt: read("Created"), lastUpdated: read("Last updated") };
}

function readPhase(taskFile: string, expectedPhase: string): PpmPhase {
  let content: string;
  try {
    content = fs.readFileSync(taskFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`task file not found: ${taskFile}`);
    throw error;
  }
  let phase: unknown;
  try {
    phase = JSON.parse(content);
  } catch (error) {
    throw new Error(`invalid JSON in ${taskFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
  normalizeLegacy(phase);
  validatePhase(phase, expectedPhase);
  return phase as PpmPhase;
}

// Errors are captured per plan/phase so one broken file doesn't take down the whole dashboard.
function readPlanData(plansRoot: string, name: string): PpmPlan {
  const planRoot = path.join(plansRoot, name);
  const errors: string[] = [];
  let content = "";
  try {
    content = fs.readFileSync(path.join(planRoot, "plan.md"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`plan.md: ${error instanceof Error ? error.message : String(error)}`);
  }
  let phases: PpmPhase[] = [];
  try {
    phases = listPhaseNames(planRoot).flatMap((phaseName) => {
      const filePath = path.join(planRoot, "tasks", `${phaseName}.json`);
      try {
        const phase = readPhase(filePath, phaseName);
        // Same analysis as plan_validate / plan_waves so the UI never looks healthier than the CLI says.
        const lint = lintPhase(phase);
        const wave: Record<string, number> = {};
        waves(phase).forEach((tasks, index) => tasks.forEach((task) => { wave[task.id] = index + 1; }));
        return [{
          name: phaseName,
          title: phase.title || phaseName,
          filePath,
          tasks: phase.tasks,
          errors: lint.errors,
          warnings: lint.warnings,
          wave,
          criticalPath: criticalPath(phase),
        }];
      } catch (error) {
        errors.push(`${phaseName}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    });
  } catch (error) {
    errors.push(`tasks: ${error instanceof Error ? error.message : String(error)}`);
  }
  // plan.md content is intentionally NOT included in the payload.
  const metadata = planMetadata(content);
  return { name, createdAt: metadata.createdAt, lastUpdated: metadata.lastUpdated, phases, errors };
}

function readProjectData(root: string, name: string): PpmProject {
  const plansRoot = path.join(root, ".ppm");
  try {
    const plans = fs.readdirSync(plansRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && PLAN_PATTERN.test(entry.name))
      .map((entry) => readPlanData(plansRoot, entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { id: root, name, path: root, plans };
  } catch (error) {
    return { id: root, name, path: root, plans: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export function readPpmDashboard(options: {
  cwd: string;
  scope: "workspace" | "registered";
  allowedRoots: Set<string>;
}): PpmDashboard {
  const config = readConfig(configFilePath());
  const workspaceRoot = findWorkspaceProject(options.cwd, options.allowedRoots);

  let projects: { id: string; name: string; path: string }[];
  if (options.scope === "workspace") {
    projects = workspaceRoot
      ? [{ id: workspaceRoot, name: path.basename(workspaceRoot), path: workspaceRoot }]
      : [];
  } else {
    const byRealpath = new Map<string, { id: string; name: string; path: string }>();
    if (workspaceRoot) {
      byRealpath.set(workspaceRoot, { id: workspaceRoot, name: path.basename(workspaceRoot), path: workspaceRoot });
    }
    for (const project of registeredProjects(config, options.allowedRoots)) {
      if (!byRealpath.has(project.id)) byRealpath.set(project.id, project);
    }
    projects = [...byRealpath.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  }

  return {
    generatedAt: new Date().toISOString(),
    currentProjectId: workspaceRoot,
    projects: projects.map((project) => readProjectData(project.path, project.name)),
  };
}