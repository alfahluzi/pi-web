import assert from "node:assert/strict";
import test from "node:test";
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
} from "./project-plan-model.ts";

const task = (overrides = {}) => ({
  id: "T1",
  title: "Implement parser",
  detail: "Parse the grammar",
  progress: "",
  status: "todo",
  ...overrides,
});

const phase = (name, tasks, overrides = {}) => ({ name, title: name, tasks, ...overrides });

const plan = (overrides = {}) => ({
  name: "Build",
  createdAt: null,
  lastUpdated: null,
  phases: [],
  ...overrides,
});

const ctx = (statusById, phaseState = "current", current = "p1") => ({
  statusById: new Map(Object.entries(statusById)),
  phaseState,
  current,
});

test("stats counts completed tasks and rounds the percent", () => {
  const result = stats([
    phase("a", [task({ status: "completed" }), task({ status: "in_progress" }), task({ id: "T3", status: "todo" })]),
    phase("b", [task({ id: "T4", status: "completed" })]),
  ]);
  assert.deepEqual(result, { completed: 2, total: 4, percent: 50 });
});

test("stats rounds 1 of 3 up to 33%", () => {
  const result = stats([phase("a", [task({ status: "completed" }), task({ id: "T2" }), task({ id: "T3" })])]);
  assert.equal(result.percent, 33);
});

test("stats of empty phase list is 0/0/0", () => {
  assert.deepEqual(stats([]), { completed: 0, total: 0, percent: 0 });
});

test("completionClass buckets 100, 0 and everything between", () => {
  assert.equal(completionClass(100), "complete");
  assert.equal(completionClass(0), "zero");
  assert.equal(completionClass(1), "partial");
  assert.equal(completionClass(50), "partial");
  assert.equal(completionClass(99), "partial");
});

test("currentPhaseName returns the first phase with a non-completed task", () => {
  const p = plan({
    phases: [
      phase("1", [task({ status: "completed" })]),
      phase("2", [task({ status: "in_progress" })]),
      phase("3", [task()]),
    ],
  });
  assert.equal(currentPhaseName(p), "2");
});

test("currentPhaseName is null when every task is completed", () => {
  const p = plan({ phases: [phase("1", [task({ status: "completed" })]), phase("2", [task({ status: "completed" })])] });
  assert.equal(currentPhaseName(p), null);
});

test("phaseState marks current / waiting-after / done-before", () => {
  const p = plan({ phases: [phase("1", []), phase("2", []), phase("3", [])] });
  assert.equal(phaseState(p, "1", "2"), "done");
  assert.equal(phaseState(p, "2", "2"), "current");
  assert.equal(phaseState(p, "3", "2"), "waiting");
});

test("phaseState with a null current phase is always done", () => {
  const p = plan({ phases: [phase("1", []), phase("2", [])] });
  assert.equal(phaseState(p, "1", null), "done");
  assert.equal(phaseState(p, "2", null), "done");
});

test("taskBadge is null for non-todo tasks", () => {
  assert.equal(taskBadge(task({ status: "completed" }), ctx({})), null);
  assert.equal(taskBadge(task({ status: "in_progress" }), ctx({})), null);
  assert.equal(taskBadge(task({ status: "fail" }), ctx({})), null);
});

test("taskBadge reports waitingPhase for a todo task in a waiting phase", () => {
  assert.deepEqual(taskBadge(task(), ctx({}, "waiting", "p2")), {
    variant: "waiting",
    kind: "waitingPhase",
    current: "p2",
  });
});

test("taskBadge reports ready once every pre_request dependency is completed", () => {
  const t = task({ pre_request: ["A", "B"] });
  assert.deepEqual(taskBadge(t, ctx({ A: "completed", B: "completed" })), { variant: "ready", kind: "ready" });
});

test("taskBadge reports parallel for tasks without pre_request dependencies", () => {
  assert.deepEqual(taskBadge(task(), ctx({})), { variant: "parallel", kind: "parallel" });
  assert.deepEqual(taskBadge(task({ pre_request: [] }), ctx({})), { variant: "parallel", kind: "parallel" });
});

test("taskBadge reports blocked with the unmet dependencies", () => {
  const t = task({ pre_request: ["A", "B"] });
  assert.deepEqual(taskBadge(t, ctx({ A: "completed", B: "todo" })), { variant: "blocked", kind: "blocked", ids: ["B"] });
});

test("taskBadge reports stuck when a dependency failed", () => {
  const t = task({ pre_request: ["A", "B"] });
  assert.deepEqual(taskBadge(t, ctx({ A: "fail", B: "in_progress" })), { variant: "stuck", kind: "stuck", ids: ["A"] });
});

test("matchesQuery searches id/title/detail/progress/status/agent/files case-insensitively", () => {
  const t = task({
    id: "T-42",
    title: "Ship parser",
    detail: "Handle async",
    progress: "halfway",
    status: "in_progress",
    agent: "coder",
    files: ["src/parse.ts", "src/token.ts"],
  });
  for (const query of ["t-42", "PARSER", "async", "HALFWAY", "IN_PROGRESS", "Coder", "token.ts"]) {
    assert.equal(matchesQuery(t, query), true, `expected query "${query}" to match`);
  }
  assert.equal(matchesQuery(t, "nope"), false);
});

test("matchesQuery trims and treats an empty query as matching everything", () => {
  const t = task();
  assert.equal(matchesQuery(t, ""), true);
  assert.equal(matchesQuery(t, "   "), true);
});

test("matchesQuery tolerates missing optional fields", () => {
  const t = task({ agent: undefined, files: undefined, pre_request: undefined, detail: undefined });
  assert.equal(matchesQuery(t, "implement"), true); // falls back to title
  assert.equal(matchesQuery(t, "zzz"), false);
});

test("filterPlans keeps only the matching completion class", () => {
  const zero = plan({ name: "z", phases: [phase("p", [task()])] });
  const partial = plan({ name: "p", phases: [phase("p", [task({ status: "completed" }), task()])] });
  const complete = plan({ name: "c", phases: [phase("p", [task({ status: "completed" })])] });
  const all = [zero, partial, complete];
  assert.deepEqual(filterPlans(all, "all"), all);
  assert.deepEqual(filterPlans(all, "zero").map((p) => p.name), ["z"]);
  assert.deepEqual(filterPlans(all, "partial").map((p) => p.name), ["p"]);
  assert.deepEqual(filterPlans(all, "complete").map((p) => p.name), ["c"]);
});

test("sortByCompletion sorts ascending and stays stable for ties", () => {
  const items = [
    { name: "c1", stats: { completed: 0, total: 2, percent: 100 } },
    { name: "b1", stats: { completed: 0, total: 2, percent: 50 } },
    { name: "b2", stats: { completed: 0, total: 2, percent: 50 } },
    { name: "a1", stats: { completed: 0, total: 2, percent: 0 } },
  ];
  assert.deepEqual(sortByCompletion(items).map((item) => item.name), ["a1", "b1", "b2", "c1"]);
});

test("sortByCompletion does not mutate its input", () => {
  const items = [{ name: "x", stats: { completed: 0, total: 1, percent: 0 } }];
  const before = items[0];
  sortByCompletion(items);
  assert.equal(items[0], before);
});

test("waveCount is the max wave value or 0", () => {
  assert.equal(waveCount(phase("p", [], { wave: { a: 2, b: 5, c: 3 } })), 5);
  assert.equal(waveCount(phase("p", [], { wave: {} })), 0);
  assert.equal(waveCount(phase("p", [])), 0);
});

test("planErrorCount sums plan errors and every phase's errors", () => {
  const p = plan({
    errors: ["plan oops", "another plan oops"],
    phases: [phase("a", [], { errors: ["phase oops"] }), phase("b", [], { errors: [] })],
  });
  assert.equal(planErrorCount(p), 3);
  assert.equal(planErrorCount(plan()), 0);
  assert.equal(planErrorCount(plan({ phases: undefined })), 0);
});

test("prompt builders produce the exact strings", () => {
  assert.equal(planExecPrompt("MVP"), "Execute MVP using Project-Plan-Manager skill");
  assert.equal(planAuditPrompt("MVP"), "Audit MVP using Project-Plan-Manager skill");
  assert.equal(
    phaseExecPrompt("MVP", "Build"),
    "Execute MVP only Phase Build using Project-Plan-Manager skill. Phases are sequential; tasks with empty pre_request are parallel-eligible. Act as orchestrator: dispatch each ppm task_ready task to a sub agent matching its agent hint, verify, then mark status.",
  );
  assert.equal(phaseAuditPrompt("MVP", "Build"), "Audit MVP only Phase Build using Project-Plan-Manager skill. Report briefly");
});