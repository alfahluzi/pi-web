import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { normalizePinnedIds, togglePinnedId } = await jiti.import("./session-pin-order.ts");
const { getSessionPinsPath, readPinnedSessionIds, writePinnedSessionIds } = await jiti.import("./session-pins.ts");

function tempPinsPath() {
  return join(mkdtempSync(join(tmpdir(), "pi-web-pins-")), "agent", "pi-web-pinned-sessions.json");
}

test("lives in the pi agent directory", () => {
  assert.equal(getSessionPinsPath("/home/me/.pi/agent"), "/home/me/.pi/agent/pi-web-pinned-sessions.json");
});

test("toggling pins newest-first and unpinning never leaves a duplicate", () => {
  assert.deepEqual(togglePinnedId([], "a", true), ["a"]);
  assert.deepEqual(togglePinnedId(["a"], "b", true), ["b", "a"]);
  assert.deepEqual(togglePinnedId(["b", "a"], "b", true), ["b", "a"]);
  assert.deepEqual(togglePinnedId(["b", "a"], "b", false), ["a"]);
  assert.deepEqual(togglePinnedId(["a"], "missing", false), ["a"]);
});

test("normalizes hand-edited files instead of trusting them", () => {
  assert.deepEqual(normalizePinnedIds({ ids: ["a", " a ", "", 3, null, "b", "a"] }), ["a", "b"]);
  assert.deepEqual(normalizePinnedIds({ ids: "a" }), []);
  assert.deepEqual(normalizePinnedIds(null), []);
  assert.deepEqual(normalizePinnedIds(["a"]), []);
});

test("round-trips through the sidecar file", () => {
  const pinsPath = tempPinsPath();
  assert.deepEqual(readPinnedSessionIds(pinsPath), []);
  assert.deepEqual(writePinnedSessionIds(["b", "a", "b"], pinsPath), ["b", "a"]);
  assert.deepEqual(readPinnedSessionIds(pinsPath), ["b", "a"]);
  assert.equal(JSON.parse(readFileSync(pinsPath, "utf8")).version, 1);
});

test("a malformed or unreadable pins file reads as empty", () => {
  const pinsPath = tempPinsPath();
  writePinnedSessionIds(["a"], pinsPath);
  writeFileSync(pinsPath, "{ not json");
  assert.deepEqual(readPinnedSessionIds(pinsPath), []);
});

test("stops writing after the pin limit", () => {
  const ids = Array.from({ length: 210 }, (_, index) => `session-${index}`);
  assert.equal(normalizePinnedIds({ ids }).length, 200);
});
