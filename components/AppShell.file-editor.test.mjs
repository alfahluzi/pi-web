import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const tabBarSource = await readFile(new URL("./TabBar.tsx", import.meta.url), "utf8");

function fileContentBlock() {
  const start = source.indexOf("{/* Only the active viewer");
  const end = source.indexOf("</div>\n      </div>\n    </div>", start);
  assert.notEqual(start, -1, "file content comment not found");
  assert.notEqual(end, -1, "end of file content block not found");
  return source.slice(start, end);
}

function handleCloseFileTabBlock() {
  const start = source.indexOf("const handleCloseFileTab = useCallback(");
  assert.notEqual(start, -1, "handleCloseFileTab not found");
  const end = source.indexOf("}, [fileTabs, terminalTabs, webPanelTabs", start);
  assert.notEqual(end, -1, "end of handleCloseFileTab dependency array not found");
  return source.slice(start, end);
}

test("the active file viewer reports draft changes", () => {
  const block = fileContentBlock();
  assert.match(block, /onDirtyChange=\{\(dirty\) => handleFileDirtyChange\(activeFileTab\.id, dirty\)\}/);
});

test("the panel tab list marks file tabs that have unsaved drafts", () => {
  assert.match(source, /const panelTabs: Tab\[\] = orderPanelTabs\(\[\s*\.\.\.fileTabs\.map\(\(tab\) => \(\{ \.\.\.tab, dirty: dirtyFileTabs\.has\(tab\.id\) \}\)\)/);
});

test("closing a dirty file tab confirms before dropping it", () => {
  const block = handleCloseFileTabBlock();
  const confirmIndex = block.indexOf('window.confirm(translate("i18n.discardUnsavedChanges"))');
  const filterIndex = block.indexOf("prev.filter((t) => t.id !== tabId)");
  assert.notEqual(confirmIndex, -1, "discard confirmation not found");
  assert.notEqual(filterIndex, -1, "file tab filtering not found");
  assert.ok(confirmIndex < filterIndex, "confirmation must run before the tab is filtered out");
  assert.match(block, /if \(dirtyFileTabs\.has\(tabId\) && !window\.confirm\(translate\("i18n\.discardUnsavedChanges"\)\)\) return;/);
});

test("TabBar renders a dirty dot only for dirty tabs", () => {
  const dirtyStart = tabBarSource.indexOf("{tab.dirty ? (");
  assert.notEqual(dirtyStart, -1, "dirty dot conditional not found");
  const dot = tabBarSource.slice(dirtyStart, tabBarSource.indexOf(") : null}", dirtyStart));
  assert.match(dot, /className="tab-dirty-dot"/);
  assert.match(dot, /aria-hidden="true"/);
});