import assert from "node:assert/strict";
import test from "node:test";
import {
  isSafePanelRelativePath,
  normalizePanelRelativePath,
  parseWebPanelManifest,
  resolvePanelAssetPath,
  webPanelAssetUrl,
} from "./web-panel-manifest.ts";

test("parseWebPanelManifest accepts a valid manifest", () => {
  const { panels, errors } = parseWebPanelManifest({
    panels: [
      {
        id: "plan",
        title: "Project Plan",
        icon: "clipboard",
        entry: "panel/index.html",
        order: 3,
      },
    ],
  });
  assert.deepEqual(errors, []);
  assert.equal(panels.length, 1);
  assert.deepEqual(panels[0], {
    id: "plan",
    title: "Project Plan",
    entry: "panel/index.html",
    icon: "clipboard",
    iconSvgPath: undefined,
    order: 3,
  });
});

test("parseWebPanelManifest defaults the title to the id", () => {
  const { panels } = parseWebPanelManifest({ panels: [{ id: "plan", entry: "index.html" }] });
  assert.equal(panels[0].title, "plan");
  assert.equal(panels[0].order, undefined);
});

test("parseWebPanelManifest ignores an unknown icon name", () => {
  const { panels } = parseWebPanelManifest({
    panels: [{ id: "plan", entry: "index.html", icon: "definitely-not-an-icon" }],
  });
  assert.equal(panels[0].icon, undefined);
});

test("parseWebPanelManifest keeps a safe custom icon path and drops an unsafe one", () => {
  const safe = parseWebPanelManifest({
    panels: [{ id: "a", entry: "index.html", iconSvgPath: "M4 4h16v16H4z" }],
  });
  assert.equal(safe.panels[0].iconSvgPath, "M4 4h16v16H4z");

  const unsafe = parseWebPanelManifest({
    panels: [{ id: "b", entry: "index.html", iconSvgPath: '"/><script>alert(1)</script>' }],
  });
  assert.equal(unsafe.panels[0].iconSvgPath, undefined);
});

test("parseWebPanelManifest rejects malformed entries without throwing", () => {
  const { panels, errors } = parseWebPanelManifest({
    panels: [
      { id: "Has Spaces", entry: "index.html" },
      { id: "abs", entry: "/etc/passwd.html" },
      { id: "escape", entry: "../outside.html" },
      { id: "nothtml", entry: "panel.txt" },
      { id: "dupe", entry: "a.html" },
      { id: "dupe", entry: "b.html" },
    ],
  });
  assert.deepEqual(panels.map((panel) => panel.id), ["dupe"]);
  assert.equal(errors.length, 5);
});

test("parseWebPanelManifest tolerates a missing or non-object piWeb field", () => {
  assert.deepEqual(parseWebPanelManifest(undefined), { panels: [], errors: [] });
  assert.deepEqual(parseWebPanelManifest({}), { panels: [], errors: [] });
  assert.equal(parseWebPanelManifest([]).errors.length, 1);
  assert.equal(parseWebPanelManifest({ panels: "nope" }).errors.length, 1);
});

test("isSafePanelRelativePath rejects traversal and absolute paths", () => {
  assert.equal(isSafePanelRelativePath("panel/index.html"), true);
  assert.equal(isSafePanelRelativePath("./panel/index.html"), true);
  assert.equal(isSafePanelRelativePath("panel\\index.html"), true);
  assert.equal(isSafePanelRelativePath("../secret.html"), false);
  assert.equal(isSafePanelRelativePath("a/../../b.html"), false);
  assert.equal(isSafePanelRelativePath("/etc/passwd.html"), false);
  assert.equal(isSafePanelRelativePath("C:/windows/win.ini"), false);
  assert.equal(isSafePanelRelativePath("panel//index.html"), false);
  assert.equal(isSafePanelRelativePath(""), false);
});

test("resolvePanelAssetPath stays inside the package root", () => {
  const root = "/packages/my-panel";
  assert.equal(resolvePanelAssetPath(root, "panel/index.html"), "/packages/my-panel/panel/index.html");
  assert.equal(resolvePanelAssetPath(root, "./panel/app.js"), "/packages/my-panel/panel/app.js");
  assert.equal(resolvePanelAssetPath(root, "../other/index.html"), null);
  assert.equal(resolvePanelAssetPath(root, "/etc/passwd.html"), null);
  assert.equal(resolvePanelAssetPath(root, ""), null);
});

test("normalizePanelRelativePath normalizes separators and a leading ./", () => {
  assert.equal(normalizePanelRelativePath(".\\panel\\index.html"), "panel/index.html");
  assert.equal(normalizePanelRelativePath("./panel/index.html"), "panel/index.html");
});

test("webPanelAssetUrl encodes each path segment", () => {
  assert.equal(webPanelAssetUrl("plan", "panel/index.html"), "/api/web-panels/plan/panel/index.html");
  assert.equal(webPanelAssetUrl("my panel", "a b/c.html"), "/api/web-panels/my%20panel/a%20b/c.html");
});
