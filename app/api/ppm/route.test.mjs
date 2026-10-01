import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "pi-web-ppm-route-"));
const project = join(root, "project");
const outside = join(root, "outside");
const planRoot = join(project, ".ppm", "alpha", "tasks");
await mkdir(planRoot, { recursive: true });
await mkdir(outside);
await writeFile(join(project, ".ppm", "alpha", "plan.md"), "# Alpha\nCreated: 2024-01-15\n");
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
const configPath = join(root, "config.json");
await writeFile(configPath, JSON.stringify({ projects: [{ name: "fixture", path: project }] }));

const previousConfig = process.env.PI_WEB_PPM_CONFIG;
process.env.PI_WEB_PPM_CONFIG = configPath;

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");
const { NextRequest } = await jiti.import("next/server");
const { GET } = await jiti.import("./route.ts");
allowFileRoot(project);

// The route reads request.nextUrl (a NextRequest-only property), so the tests
// build real NextRequest objects instead of plain Request instances.
const request = (url) => new NextRequest(url);

after(async () => {
  if (previousConfig === undefined) delete process.env.PI_WEB_PPM_CONFIG;
  else process.env.PI_WEB_PPM_CONFIG = previousConfig;
  await rm(root, { recursive: true, force: true });
});

test("400 for a relative cwd", async () => {
  const response = await GET(request("http://localhost/api/ppm?cwd=relative/path"));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "cwd must be an absolute path" });
});

test("403 for a cwd outside the allowed roots", async () => {
  const response = await GET(request(`http://localhost/api/ppm?cwd=${encodeURIComponent(outside)}`));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Access denied" });
});

test("200 with the dashboard JSON shape for a .ppm fixture", async () => {
  const response = await GET(request(`http://localhost/api/ppm?cwd=${encodeURIComponent(project)}`));
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(typeof body.generatedAt, "string");
  assert.equal(body.currentProjectId, project);
  assert.equal(body.projects.length, 1);
  assert.equal(body.projects[0].id, project);
  assert.equal(body.projects[0].path, project);
  assert.equal(body.projects[0].name, "project");
  assert.equal(body.projects[0].plans.length, 1);
  assert.equal(body.projects[0].plans[0].name, "alpha");
  assert.equal(body.projects[0].plans[0].phases[0].name, "phase_1");
  assert.equal(body.projects[0].plans[0].phases[0].tasks[0].id, "t1");
});