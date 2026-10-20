import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import ts from "typescript";

const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");

test("large source previews bypass the per-line syntax highlighter", () => {
  assert.match(source, /const SOURCE_HIGHLIGHT_MAX_LINES = 1_000;/);
  assert.match(source, /const useLightweightSource = sourceLines\.length > SOURCE_HIGHLIGHT_MAX_LINES/);

  // Both source trees are memoized so unrelated re-renders (panel open/close,
  // selection changes) reuse them instead of rebuilding every line element.
  assert.match(source, /const highlightedSource = useMemo\(/);

  const lightweightStart = source.indexOf("const lightweightSourceLines = useMemo(");
  const lightweightEnd = source.indexOf("[sourceLines, useLightweightSource, wrapLines]", lightweightStart);
  assert.notEqual(lightweightStart, -1);
  assert.notEqual(lightweightEnd, -1);

  const lightweightSource = source.slice(lightweightStart, lightweightEnd);
  assert.match(lightweightSource, /useLightweightSource \? sourceLines\.map\(\(line, lineIndex\) =>/);
  assert.match(lightweightSource, /className="file-source-line"/);
  assert.match(lightweightSource, /className="file-source-line-content"/);
  assert.match(lightweightSource, /style=\{FILE_LINE_NUMBER_STYLE\}/);

  // The lightweight branch still wins over the syntax highlighter in the JSX.
  const branchStart = source.indexOf(") : useLightweightSource ? (");
  assert.notEqual(branchStart, -1);
  assert.match(source.slice(branchStart), /className="file-source-view is-lightweight"/);
  assert.notEqual(source.indexOf("highlightedSource", branchStart), -1);
});

test("lightweight source rows are skipped for highlighted, diff, and preview views", () => {
  // Execute the source-view calculations without mounting the file-fetching component.
  const file = ts.createSourceFile("FileViewer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const viewer = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "TextFileViewer");
  const calculations = viewer.body.statements.filter((node) =>
    ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
      ["viewerContent", "sourceLines", "language", "isHtml", "isMarkdown", "hasPreview", "canEdit", "effectiveDisplayMode", "useLightweightSource", "lightweightSourceLines"].includes(declaration.name.getText(file)),
    ),
  ).map((node) => node.getText(file)).join("\n");
  const { outputText } = ts.transpileModule(`
    return (data, displayMode, hasGitDiff = false, isDeletedDiff = false, wrapLines = false) => {
      const SOURCE_HIGHLIGHT_MAX_LINES = 1_000;
      const FILE_LINE_NUMBER_STYLE = {};
      ${calculations}
      return lightweightSourceLines;
    };
  `, { compilerOptions: { jsx: ts.JsxEmit.React } });
  const render = new Function("React", "useMemo", outputText)(React, (calculate) => calculate());
  const large = { content: "line\n".repeat(1_000), language: "text" };

  assert.equal(render({ ...large, content: "line\n".repeat(999) }, "source"), null);
  assert.equal(render(large, "diff", true), null);
  assert.equal(render(large, "source", true, true), null);
  for (const language of ["html", "markdown"]) {
    assert.equal(render({ ...large, language }, "preview"), null);
  }
  for (const mode of ["source", "diff", "preview"]) {
    const rows = render(large, mode);
    assert.equal(rows.length, 1_001, `${mode} must retain its source fallback`);
    assert.equal(rows[0].props["data-line-number"], 1);
    assert.equal(rows[0].props.children[1].props.children, "line");
  }
  assert.equal(render(large, "source", false, false, true)[0].props.children[1].props.style.whiteSpace, "pre-wrap");
});

test("markdown preview links carry PDF page fragments", () => {
  assert.match(source, /parsePdfPageFragment/);
  assert.match(source, /onOpenFile\(linkedFile, parsePdfPageFragment\(href\) \?\? undefined\)/);
});

test("file viewer state and display labels expose edit mode", async () => {
  const stateSource = await readFile(new URL("../lib/file-viewer-state.ts", import.meta.url), "utf8");
  assert.match(stateSource, /export type FileViewerDisplayMode = "source" \| "preview" \| "diff" \| "edit";/);
  assert.match(stateSource, /draft\?: string \| null;/);

  assert.match(source, /edit: "Edit",/);
  assert.match(source, /"read" \| "download" \| "meta" \| "preview" \| "watch" \| "write"/);
  assert.match(source, /interface FileData \{[\s\S]*?revision: string;/);
  assert.match(source, /const useLightweightSource = sourceLines\.length > SOURCE_HIGHLIGHT_MAX_LINES\n\s+&& !\(effectiveDisplayMode === "edit"\)/);
});

test("edit mode is gated by canEdit and falls back to source", () => {
  assert.match(source, /const canEdit = !data\?\.truncated && !isDeletedDiff;/);
  assert.match(source, /disabled=\{!canEdit\}/);
  assert.match(source, /t\("i18n\.fileTooLargeToEdit"\)/);
  assert.match(source, /t\("i18n\.edit"\)/);

  // Execute the gating calculations without mounting the file-fetching component.
  const file = ts.createSourceFile("FileViewer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const viewer = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "TextFileViewer");
  const calculations = viewer.body.statements.filter((node) =>
    ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
      ["canEdit", "effectiveDisplayMode"].includes(declaration.name.getText(file)),
    ),
  ).map((node) => node.getText(file)).join("\n");
  const { outputText } = ts.transpileModule(`
    return (data, displayMode, isDeletedDiff = false) => {
      ${calculations}
      return effectiveDisplayMode;
    };
  `, { compilerOptions: { jsx: ts.JsxEmit.React } });
  const compute = new Function(outputText)();

  assert.equal(compute({ content: "x", truncated: false }, "edit", false), "edit");
  assert.equal(compute({ content: "x", truncated: true }, "edit", false), "source");
  assert.equal(compute({ content: "x", truncated: false }, "edit", true), "diff");
});

test("saving PUTs the buffer with its base revision", () => {
  assert.match(source, /getFileApiUrl\(filePath, "write", sourceSessionId\)/);
  assert.match(source, /method: "PUT"/);
  assert.match(source, /body: JSON\.stringify\(\{ content, baseRevision: revisionRef\.current \}\)/);
  assert.match(source, /if \(response\.status === 409\)/);
  assert.match(source, /setBanner\("stale"\)/);
});

test("live change never clobbers a dirty buffer", () => {
  assert.match(source, /const synchronize = \(notifyExternal = false\) => \{\n\s+if \(dirtyRef\.current\) \{\n\s+if \(notifyExternal\) setBanner\("external"\);\n\s+\} else \{\n\s+void fetchContent\(filePath\)\.then/);
  assert.match(source, /es\.addEventListener\("change", \(\) => synchronize\(true\)\)/);
  assert.match(source, /void fetchGitDiff\(filePath\)/);
});

test("draft is persisted in viewer state and cleared on save", () => {
  assert.match(source, /viewerStateRef\.current\.draft = isDirty \? next : null;/);
  assert.match(source, /viewerStateRef\.current\.draft = null;/);
  assert.match(source, /applyDiskContent\(d\.content, d\.revision, false\)/);
});

test("viewer state reset preserves the restored draft across remounts", () => {
  // The useRef initializer must seed the draft so a freshly mounted viewer
  // starts with the tab's persisted draft instead of an undefined draft.
  assert.match(
    source,
    /const viewerStateRef = useRef<FileViewerState>\(\{\n\s+displayMode: requestedInitialDisplayMode,\n\s+wrapLines: initialWrapLines,\n\s+scrollTop: initialScrollTop,\n\s+scrollLeft: initialScrollLeft,\n\s+draft: initialState\?\.draft \?\? null,\n\s+\}\);/,
  );

  // The identity effect rebuilds nextState and assigns it to viewerStateRef;
  // it must carry the draft too, otherwise Strict Mode's double-invoked mount
  // cleanup clobbers the draft before applyDiskContent can restore it.
  assert.match(
    source,
    /const nextState: FileViewerState = \{\n\s+displayMode: requestedInitialDisplayMode,\n\s+wrapLines: initialWrapLines,\n\s+scrollTop: initialScrollTop,\n\s+scrollLeft: initialScrollLeft,\n\s+draft: initialState\?\.draft \?\? null,\n\s+\};/,
  );
});

test("FileEditor renders only in the edit branch", () => {
  assert.match(source, /effectiveDisplayMode === "edit" \? \(\n\s+<FileEditor/);
  assert.equal(source.match(/<FileEditor/g)?.length, 1);
  assert.match(source, /onSave=\{\(\) => void saveFile\(\)\}/);
});
