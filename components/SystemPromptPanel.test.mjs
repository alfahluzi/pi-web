import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { SystemPromptPanelView } = await jiti.import("./SystemPromptPanel.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

// Resolved labels, so a missing key is a test failure rather than real copy.
const LABELS = {
  "system.prompt": "System prompt",
  "system.copy": "Copy",
  "system.copied": "Copied",
  "system.expand": "Expand",
  "system.collapse": "Collapse",
  "system.empty": "EMPTY",
  "system.load": "NOT-LOADED",
  "system.loading": "LOADING",
};
const translate = (key) => LABELS[key] ?? `MISSING:${key}`;

function renderPanel(props = {}) {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(SystemPromptPanelView, {
        loading: false,
        prompt: null,
        translate,
        expanded: false,
        copied: false,
        onCopy() {},
        onToggle() {},
        ...props,
      }),
    ),
  );
  // Every render also guards the stub: no key the panel uses may be unresolved.
  assert.doesNotMatch(html, /MISSING:/);
  return html;
}

const toolsPrompt = "<tools>\n- read: Read file contents\n- bash: Run\n</tools>";

test("wrapper tags become labelled sections over real markdown", () => {
  const html = renderPanel({ prompt: toolsPrompt });
  assert.match(html, /class="system-prompt-section-name">tools</);
  assert.match(html, /<ul>/);
  assert.match(html, /<li>read: Read file contents<\/li>/);
});

test("a wrapper tag never leaks as an element or as escaped text", () => {
  const html = renderPanel({ prompt: toolsPrompt });
  assert.doesNotMatch(html, /<tools/);
  assert.doesNotMatch(html, /&lt;tools/);
});

test("the header holds the title and exactly two buttons", () => {
  const html = renderPanel({ prompt: toolsPrompt });
  assert.match(html, /class="system-prompt-title">System prompt</);
  const buttons = html.match(/<button[^>]*>/g) ?? [];
  assert.equal(buttons.length, 2);
  assert.equal((html.match(/<button type="button"/g) ?? []).length, 2);
  assert.equal((html.match(/class="system-prompt-button"/g) ?? []).length, 2);
  for (const button of buttons) assert.doesNotMatch(button, /disabled/);
});

test("an unloaded prompt disables both buttons and keeps the Copy label", () => {
  const html = renderPanel({ prompt: null });
  const buttons = html.match(/<button[^>]*>/g) ?? [];
  assert.equal(buttons.length, 2);
  for (const button of buttons) assert.match(button, /disabled=""/);
  assert.match(html, /class="system-prompt-button"[^>]*>Copy</);
});

test("expansion is announced and only adds the height class and Collapse label", () => {
  const collapsed = renderPanel({ prompt: toolsPrompt });
  assert.match(collapsed, /aria-expanded="false"/);
  assert.doesNotMatch(collapsed, /system-prompt-panel is-expanded/);
  assert.match(collapsed, />Expand</);

  const expanded = renderPanel({ prompt: toolsPrompt, expanded: true });
  assert.match(expanded, /aria-expanded="true"/);
  assert.match(expanded, /class="system-prompt-panel is-expanded"/);
  assert.match(expanded, />Collapse</);
  assert.doesNotMatch(expanded, />Expand</);
});

test("the empty and loading branch keeps its three-way text", () => {
  assert.match(renderPanel({ prompt: "" }), /class="system-prompt-empty">EMPTY</);
  assert.match(renderPanel({ prompt: null, loading: true }), /class="system-prompt-empty">LOADING</);
  assert.match(renderPanel({ prompt: null, loading: false }), /class="system-prompt-empty">NOT-LOADED</);
});

test("keepLineBreaks follows the segment's line orientation, never its depth", () => {
  const skill = renderPanel({ prompt: "<skill>\nname: pdf\ndescription: Read PDFs\nlocation: /x/SKILL.md\n</skill>" });
  assert.match(skill, /<br\/?>/);

  const prose = renderPanel({ prompt: "this line is a sentence\nand this is another line" });
  assert.doesNotMatch(prose, /<br\/?>/);
});
