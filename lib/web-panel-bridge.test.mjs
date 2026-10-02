import assert from "node:assert/strict";
import test from "node:test";
import { resolveWebPanelPath } from "./web-panel-bridge.ts";

test("relative paths join the active workspace", () => {
  assert.equal(resolveWebPanelPath("package.json", "/work/project"), "/work/project/package.json");
  assert.equal(resolveWebPanelPath("./a/b.md", "/work/project"), "/work/project/a/b.md");
  assert.equal(resolveWebPanelPath("src/", "/work/project/"), "/work/project/src/");
});

test("absolute paths pass through untouched", () => {
  assert.equal(resolveWebPanelPath("/etc/hosts", "/work/project"), "/etc/hosts");
  assert.equal(resolveWebPanelPath("C:\\src\\a.ts", "/work/project"), "C:\\src\\a.ts");
  assert.equal(resolveWebPanelPath("C:/src/a.ts", "/work/project"), "C:/src/a.ts");
  assert.equal(resolveWebPanelPath("\\\\host\\share\\a.ts", "/work/project"), "\\\\host\\share\\a.ts");
});

test("a Windows workspace uses backslash separators", () => {
  assert.equal(resolveWebPanelPath("package.json", "C:\\work\\project"), "C:\\work\\project\\package.json");
});

test("no workspace or empty path is left as-is", () => {
  assert.equal(resolveWebPanelPath("package.json", null), "package.json");
  assert.equal(resolveWebPanelPath("", "/work/project"), "");
  assert.equal(resolveWebPanelPath("   ", "/work/project"), "");
});
