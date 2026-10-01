import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

// reader.ts imports through the "@/lib/file-access" alias, which the node test
// runner does not resolve; load it through jiti like the API route tests do.
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { readPpmDashboard } = await jiti.import("./reader.ts");

const root = await mkdtemp(join(tmpdir(), "pi-web-ppm-reader-"));
const project = join(root, "project");
const second = join(root, "second");
const planRoot = join(project, ".ppm", "alpha", "tasks");
await mkdir(planRoot, { recursive: true });
await writeFile(join(project, ".ppm", "alpha", "plan.md"), [
  "# Alpha",
  "Created: 2024-01-15",
  "Last updated: 2024-02-01",
  "",
].join("\n"));
await writeFile(join(planRoot, "phase_1.json"), JSON.stringify({
  phase: "phase_1",
  title: "Phase 1",
  tasks: [
    {
      id: "t1",
      title: "Task 1",
      detail: "Goal: implement\nSteps: code\nVerify: test\nDone when: green",
      status: "todo",
      progress: "",
      agent: "implement",
      files: ["src/a.ts"],
    },
  ],
}));
// Broken JSON: readPlanData must surface this as a plan error, not crash.
await writeFile(join(planRoot, "phase_2.json"), '{ "phase": "phase_2", "tasks": [');
// A second registered project that is not inside the workspace roots.
await mkdir(join(second, ".ppm"), { recursive: true });

const configPath = join(root, "config.json");
await writeFile(configPath, JSON.stringify({
  projects: [
    { name: "fixture", path: project },
    { name: "second", path: second },
  ],
}));

const previousConfig = process.env.PI_WEB_PPM_CONFIG;
process.env.PI_WEB_PPM_CONFIG = configPath;

after(async () => {
  if (previousConfig === undefined) delete process.env.PI_WEB_PPM_CONFIG;
  else process.env.PI_WEB_PPM_CONFIG = previousConfig;
  await rm(root, { recursive: true, force: true });
});

test("reads plan metadata, phases, waves, and critical path from .ppm", () => {
  const dashboard = readPpmDashboard({ cwd: project, scope: "workspace", allowedRoots: new Set([project]) });

  assert.equal(dashboard.currentProjectId, project);
  assert.equal(dashboard.projects.length, 1);
  const [projectData] = dashboard.projects;
  assert.equal(projectData.id, project);
  assert.equal(projectData.path, project);
  assert.equal(projectData.name, "project");
  assert.equal(projectData.error, undefined);

  assert.equal(projectData.plans.length, 1);
  const plan = projectData.plans[0];
  assert.equal(plan.name, "alpha");
  assert.equal(plan.createdAt, "2024-01-15");
  assert.equal(plan.lastUpdated, "2024-02-01");
  // plan.md body is intentionally not part of the payload.
  assert.equal("content" in plan, false);

  // phase_1 parses and gets analysed; phase_2 is broken and lands in plan.errors.
  assert.equal(plan.phases.length, 1);
  const phase = plan.phases[0];
  assert.equal(phase.name, "phase_1");
  assert.equal(phase.title, "Phase 1");
  assert.equal(phase.filePath, join(project, ".ppm", "alpha", "tasks", "phase_1.json"));
  assert.equal(phase.tasks[0].id, "t1");
  assert.deepEqual(phase.wave, { t1: 1 });
  assert.deepEqual(phase.criticalPath, ["t1"]);
  assert.equal(plan.errors.length, 1);
  assert.ok(
    plan.errors[0].startsWith("phase_2: invalid JSON in"),
    `expected a phase_2 invalid-JSON error, got: ${JSON.stringify(plan.errors)}`,
  );
});

test('scope "registered" includes a second registered project only inside allowedRoots', () => {
  // The second registered project is outside the allowed roots: dropped.
  const workspaceOnly = readPpmDashboard({
    cwd: project,
    scope: "registered",
    allowedRoots: new Set([project]),
  });
  assert.equal(workspaceOnly.projects.length, 1);
  assert.equal(workspaceOnly.projects[0].id, project);

  // Once the second project is inside the allowed roots, both are listed.
  const both = readPpmDashboard({
    cwd: project,
    scope: "registered",
    allowedRoots: new Set([project, second]),
  });
  assert.equal(both.projects.length, 2);
  assert.ok(both.projects.some((entry) => entry.id === second));
  assert.ok(both.projects.some((entry) => entry.id === project));
  assert.deepEqual(both.projects.map((entry) => entry.name), ["project", "second"]);
});