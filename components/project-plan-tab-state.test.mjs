import assert from "node:assert/strict";
import test from "node:test";
import { newPlanTab } from "./project-plan-tab-state.ts";

test("newPlanTab is deterministic per cwd", () => {
  const tab = newPlanTab("/workspace/project");
  assert.deepEqual(newPlanTab("/workspace/project"), tab);
  assert.equal(tab.cwd, "/workspace/project");
  assert.equal(tab.id, "plan:/workspace/project");
});

test("newPlanTab produces distinct ids across workspaces", () => {
  const a = newPlanTab("/workspace/a");
  const b = newPlanTab("/workspace/b");
  assert.notEqual(a.id, b.id);
  assert.ok(a.id.startsWith("plan:"));
  assert.ok(b.id.startsWith("plan:"));
});