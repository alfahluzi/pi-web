import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  PROJECT_TARGET_MAX_LENGTH,
  expandProjectTarget,
  isPathAtOrUnder,
  mapPathUnderRoot,
  projectDestinationPath,
  sessionProjectDirName,
} = await jiti.import("./project-move-paths.ts");

const HOME = "/home/person";

test("expandProjectTarget: ~ and absolute paths, nothing else", () => {
  assert.equal(expandProjectTarget("~/Documents/testing", HOME), "/home/person/Documents/testing");
  assert.equal(expandProjectTarget("  ~/Documents/testing  ", HOME), "/home/person/Documents/testing");
  assert.equal(expandProjectTarget("~", HOME), "/home/person");
  assert.equal(expandProjectTarget("/srv/projects", HOME), "/srv/projects");
  assert.equal(expandProjectTarget("~/a/../b", HOME), "/home/person/b");
  assert.equal(expandProjectTarget("/srv/../srv/x", HOME), "/srv/x");
});

test("expandProjectTarget: relative, empty and oversized input is refused", () => {
  assert.equal(expandProjectTarget("", HOME), null);
  assert.equal(expandProjectTarget("   ", HOME), null);
  assert.equal(expandProjectTarget("Documents/testing", HOME), null);
  assert.equal(expandProjectTarget("./testing", HOME), null);
  assert.equal(expandProjectTarget(`/${"a".repeat(PROJECT_TARGET_MAX_LENGTH)}`, HOME), null);
});

test("isPathAtOrUnder: the folder itself and its children, not a name that merely starts like it", () => {
  assert.equal(isPathAtOrUnder("/a/b", "/a/b"), true);
  assert.equal(isPathAtOrUnder("/a/b/c", "/a/b"), true);
  assert.equal(isPathAtOrUnder("/a/bc", "/a/b"), false);
  assert.equal(isPathAtOrUnder("/a", "/a/b"), false);
  assert.equal(isPathAtOrUnder("/a/b/../b/c", "/a/b"), true);
});

test("mapPathUnderRoot: keeps the tail, refuses what is outside", () => {
  assert.equal(mapPathUnderRoot("/a/b", "/a/b", "/c/d"), "/c/d");
  assert.equal(mapPathUnderRoot("/a/b/packages/web", "/a/b", "/c/d"), "/c/d/packages/web");
  assert.equal(mapPathUnderRoot("/a/bc", "/a/b", "/c/d"), null);
  assert.equal(mapPathUnderRoot("/a", "/a/b", "/c/d"), null);
});

test("projectDestinationPath: the project keeps its own name", () => {
  assert.equal(projectDestinationPath("/home/person/Documents/testing", "/home/person/Documents/pi-web"), "/home/person/Documents/testing/pi-web");
  assert.equal(projectDestinationPath("/home/person/Documents/testing/", "/home/person/Documents/pi-web/"), "/home/person/Documents/testing/pi-web");
});

test("sessionProjectDirName: pi's encoding of a cwd", () => {
  assert.equal(sessionProjectDirName("/home/person/Documents/pi-web"), "--home-person-Documents-pi-web--");
  assert.equal(sessionProjectDirName("/tmp"), "--tmp--");
  // A colon (a Windows drive) becomes a dash too, as the SDK does.
  assert.equal(sessionProjectDirName("C:\\work\\repo"), "--C--work-repo--");
});
