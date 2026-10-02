import assert from "node:assert/strict";
import test from "node:test";
import { newWebPanelTab, reconcileWebPanelTab, webPanelTabId } from "./web-panel-tab-state.ts";

const PANEL = {
  id: "plan",
  title: "Project Plan",
  icon: "clipboard",
  order: 1,
  url: "/api/web-panels/plan/panel/index.html",
  source: "npm:@scope/my-panel",
  scope: "global",
};

test("newWebPanelTab derives a deterministic id per panel", () => {
  const tab = newWebPanelTab(PANEL);
  assert.equal(tab.id, "web-panel:plan");
  assert.equal(tab.id, webPanelTabId("plan"));
  assert.equal(tab.panelId, "plan");
  assert.equal(tab.title, "Project Plan");
  assert.equal(tab.url, PANEL.url);
});

test("reconcileWebPanelTab adopts manifest changes", () => {
  const tab = newWebPanelTab(PANEL);
  const next = reconcileWebPanelTab(tab, {
    ...PANEL,
    title: "Renamed",
    url: "/api/web-panels/plan/index.html",
    icon: "list",
  });
  assert.equal(next.title, "Renamed");
  assert.equal(next.url, "/api/web-panels/plan/index.html");
  assert.equal(next.icon, "list");
});

test("reconcileWebPanelTab keeps a bridge-provided title override", () => {
  const tab = { ...newWebPanelTab(PANEL), titleOverride: "Live title" };
  const next = reconcileWebPanelTab(tab, { ...PANEL, title: "Manifest title" });
  assert.equal(next.title, "Live title");
  assert.equal(next.titleOverride, "Live title");
});
