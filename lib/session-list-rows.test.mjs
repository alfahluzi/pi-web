import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  PINNED_SECTION_HEADER_HEIGHT,
  SESSION_ROW_HEIGHT,
  buildSessionListRows,
  getVirtualRowIndices,
  sessionListOffsets,
  sessionListRowHeight,
} = await createJiti(import.meta.url).import("./session-list-rows.ts");

function family(id, modified = "2026-01-01T00:00:00.000Z", subagents = []) {
  return {
    root: { path: `/tmp/${id}.jsonl`, id, cwd: "/tmp", created: modified, modified, messageCount: 1, firstMessage: id },
    subagents,
    latestModified: modified,
  };
}

test("moves pinned families into a labelled section without touching the rest's order", () => {
  const families = [family("a"), family("b"), family("c")];
  const rows = buildSessionListRows(families, ["c", "a"]);
  assert.deepEqual(rows.map((row) => row.kind === "family" ? row.family.root.id : row.key), [
    "pinned-header", "c", "a", "b",
  ]);
  // Pin order, not list order, decides the section.
  assert.deepEqual(buildSessionListRows(families, ["b", "c"]).slice(1, 3).map((row) => row.family.root.id), ["b", "c"]);
});

test("renders no section header when the workspace has no pinned session", () => {
  const families = [family("a"), family("b")];
  assert.deepEqual(buildSessionListRows(families, []).map((row) => row.family.root.id), ["a", "b"]);
  // Pins from another workspace are not in `families`, so they add no header.
  assert.deepEqual(buildSessionListRows(families, ["elsewhere"]).map((row) => row.kind), ["family", "family"]);
});

test("row heights feed the offset table used for absolute positioning", () => {
  const rows = buildSessionListRows([family("a"), family("b")], ["b"]);
  assert.deepEqual(rows.map(sessionListRowHeight), [
    PINNED_SECTION_HEADER_HEIGHT, SESSION_ROW_HEIGHT, SESSION_ROW_HEIGHT,
  ]);
  assert.deepEqual(sessionListOffsets([PINNED_SECTION_HEADER_HEIGHT, SESSION_ROW_HEIGHT, SESSION_ROW_HEIGHT]), [
    0, 28, 82, 136,
  ]);
});

test("windows rows by offset, not by index, so the taller header cannot leave a gap", () => {
  const rows = buildSessionListRows([family("a"), family("b")], ["b"]);
  const heights = rows.map(sessionListRowHeight);
  assert.deepEqual(getVirtualRowIndices(heights, 0, 60), [0, 1, 2]);

  const many = [family("a"), family("b"), ...Array.from({ length: 60 }, (_, index) => family(`s${index}`))];
  const tallRows = buildSessionListRows(many, ["s59"]);
  const tallHeights = tallRows.map(sessionListRowHeight);
  const offsets = sessionListOffsets(tallHeights);
  const firstVisible = getVirtualRowIndices(tallHeights, offsets[20], 54);
  assert.ok(firstVisible.includes(20));
  assert.ok(!firstVisible.includes(0));
  assert.deepEqual(getVirtualRowIndices([], 0, 300), []);
});

test("keeps a focused row mounted when it is outside the window", () => {
  const heights = new Array(100).fill(SESSION_ROW_HEIGHT);
  const indices = getVirtualRowIndices(heights, 0, 54, 99);
  assert.equal(indices.at(-1), 99);
  const topFocused = getVirtualRowIndices(heights, 54 * 60, 54, 0);
  assert.equal(topFocused[0], 0);
});
