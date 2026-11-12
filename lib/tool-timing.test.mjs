import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getToolTiming, parseSleepTotalSec } = await jiti.import("./tool-timing.ts");

test("sums every sleep in a bash command across units", () => {
  assert.equal(parseSleepTotalSec("sleep 2 && echo hi; sleep 1m"), 62);
  assert.equal(parseSleepTotalSec("sleep 0.5"), 0.5);
  assert.equal(parseSleepTotalSec("sleep 1h; sleep 30s"), 3630);
  assert.equal(parseSleepTotalSec("echo sleepy"), 0);
});

test("timing comes only from a timeout arg or a bash sleep", () => {
  assert.deepEqual(getToolTiming("read", { path: "a", timeout: 5 }), { timeoutSec: 5 });
  assert.deepEqual(getToolTiming("bash", { command: "sleep 3 && make", timeout: 60 }), { timeoutSec: 60, sleepSec: 3 });
  assert.deepEqual(getToolTiming("bash", { command: "sleep 3" }), { sleepSec: 3 });
  assert.equal(getToolTiming("read", { command: "sleep 3" }), null);
  assert.equal(getToolTiming("bash", { command: "ls" }), null);
  assert.equal(getToolTiming("bash", null), null);
});
