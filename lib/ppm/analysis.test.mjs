import assert from "node:assert/strict";
import test from "node:test";

// analysis.ts is pure (no imports), so the test runner's --experimental-strip-types
// can import it directly, matching lib/git-changes.test.mjs.
async function loadSubject() {
  return import("./analysis.ts");
}

test("serial chain produces width-1 waves, a critical path, and a fully-serial warning", async () => {
  const { waves, criticalPath, lintPhase } = await loadSubject();
  const phase = {
    tasks: [
      { id: "a", detail: "Goal: A\nVerify: test", agent: "implement", pre_request: [] },
      { id: "b", detail: "Goal: B\nVerify: test", agent: "implement", pre_request: ["a"] },
    ],
  };

  assert.deepEqual(waves(phase).map((wave) => wave.map((task) => task.id)), [["a"], ["b"]]);
  assert.deepEqual(criticalPath(phase), ["a", "b"]);

  const lint = lintPhase(phase);
  assert.deepEqual(lint.errors, []);
  assert.ok(
    lint.warnings.some((warning) => warning.startsWith("fully serial (2 tasks, width 1)")),
    `expected a fully-serial warning, got: ${JSON.stringify(lint.warnings)}`,
  );
});

test("concurrent tasks sharing a file produce a lint error", async () => {
  const { waves, fileConflicts, lintPhase } = await loadSubject();
  const phase = {
    tasks: [
      { id: "a", detail: "Goal: A", agent: "implement", files: ["src/a.ts"] },
      { id: "b", detail: "Goal: B", agent: "implement", files: ["src/a.ts"] },
    ],
  };

  assert.deepEqual(waves(phase).map((wave) => wave.map((task) => task.id)), [["a", "b"]]);
  assert.deepEqual(fileConflicts(phase), [{ a: "a", b: "b", shared: ["src/a.ts"] }]);

  const lint = lintPhase(phase);
  assert.ok(
    lint.errors.some((error) => error ===
      "a and b can run concurrently but share files: src/a.ts (add pre_request or move shared files to one task)"),
    `expected a shared-files error, got: ${JSON.stringify(lint.errors)}`,
  );
});

test("parallel pair without a closing task produce a lint warning", async () => {
  const { lintPhase } = await loadSubject();
  const phase = {
    tasks: [
      { id: "a", detail: "Goal: A", agent: "implement", files: ["src/a.ts"] },
      { id: "b", detail: "Goal: B", agent: "implement", files: ["src/b.ts"] },
    ],
  };

  const lint = lintPhase(phase);
  assert.deepEqual(lint.errors, []);
  assert.ok(
    lint.warnings.some((warning) => warning ===
      "parallel work has no closing integration/verify task (one task whose pre_request covers all others)"),
    `expected a missing-closing-task warning, got: ${JSON.stringify(lint.warnings)}`,
  );
});