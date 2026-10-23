import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { comparablePath, isPathAtOrUnderRoot, remapMovedPath, remapUrlCwd } = await jiti.import("./moved-path.ts");

const source = await readFile(new URL("./moved-path.ts", import.meta.url), "utf8");

test("is client-safe", () => {
  assert.doesNotMatch(source, /from "node:|from "(fs|path|os)"|require\(/);
});

test("containment is separator- and case-aware, and not fooled by a shared prefix", () => {
  assert.equal(isPathAtOrUnderRoot("/a/b", "/a/b"), true);
  assert.equal(isPathAtOrUnderRoot("/a/b/c.ts", "/a/b"), true);
  assert.equal(isPathAtOrUnderRoot("/a/bc/d.ts", "/a/b"), false);
  assert.equal(isPathAtOrUnderRoot("/a/b/", "/a/b"), true);
  assert.equal(isPathAtOrUnderRoot("C:\\work\\repo\\a.ts", "c:/work/repo"), true);
  assert.equal(isPathAtOrUnderRoot("C:\\work\\repository\\a.ts", "c:/work/repo"), false);
  assert.equal(isPathAtOrUnderRoot("", "/a"), false);
});

test("remap keeps the tail and the destination's own name", () => {
  assert.equal(remapMovedPath("/old/proj", "/old/proj", "/new/testing/proj"), "/new/testing/proj");
  assert.equal(remapMovedPath("/old/proj/src/a.ts", "/old/proj", "/new/testing/proj"), "/new/testing/proj/src/a.ts");
  assert.equal(remapMovedPath("/elsewhere/a.ts", "/old/proj", "/new/testing/proj"), null);
  assert.equal(remapMovedPath("/old/projbackup/a.ts", "/old/proj", "/new/testing/proj"), null);
});

test("comparablePath normalizes slashes and trailing separators only", () => {
  assert.equal(comparablePath("/a//b/"), "/a/b");
  assert.equal(comparablePath("/a/b"), "/a/b");
  assert.equal(comparablePath("C:\\Work\\Repo\\"), "c:/work/repo");
});

test("remapUrlCwd re-points a panel's cwd query and leaves other URLs alone", () => {
  assert.equal(
    remapUrlCwd("/api/web-panels/planner?cwd=%2Fold%2Fproj&tab=2", "/old/proj", "/new/testing/proj"),
    "/api/web-panels/planner?cwd=%2Fnew%2Ftesting%2Fproj&tab=2",
  );
  assert.equal(remapUrlCwd("/api/web-panels/planner?cwd=%2Felsewhere", "/old/proj", "/new/testing/proj"), null);
  assert.equal(remapUrlCwd("/api/web-panels/planner", "/old/proj", "/new/testing/proj"), null);
});
