import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./FileEditor.tsx", import.meta.url), "utf8");

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test("FileEditor creates exactly one EditorView and destroys it on cleanup", () => {
  assert.equal(count(source, "new EditorView("), 1);
  assert.equal(count(source, "view.destroy()"), 1);
});

test("FileEditor keeps the document in CodeMirror instead of React state", () => {
  assert.doesNotMatch(source, /useState\(/);
  assert.match(source, /EditorView\.updateListener\.of\(/);
  assert.match(source, /update\.docChanged/);
  assert.match(source, /onChangeRef\.current\(update\.state\.doc\.toString\(\)\)/);
});

test("FileEditor wires the Mod-s save keybinding without a form submit", () => {
  assert.match(source, /key:\s*"Mod-s"/);
  assert.match(source, /preventDefault:\s*true/);
  assert.match(source, /onSaveRef\.current\?\.\(\)/);
  assert.match(source, /\.\.\.defaultKeymap/);
  assert.match(source, /\.\.\.historyKeymap/);
  assert.match(source, /indentWithTab/);
  assert.match(source, /searchKeymap/);
});

test("FileEditor guards line wrapping behind the wrapLines prop", () => {
  assert.match(source, /wrapLinesRef\.current\s*\?\s*EditorView\.lineWrapping\s*:\s*\[\]/);
  assert.match(source, /wrapLines\s*\?\s*EditorView\.lineWrapping\s*:\s*\[\]/);
});

test("FileEditor lazily loads language extensions through a compartment", () => {
  assert.match(
    source,
    /import\s*\{\s*loadLanguageExtension\s*\}\s*from\s*"@\/lib\/code-languages"/,
  );
  assert.match(source, /loadLanguageExtension\(languageRef\.current\)/);
  assert.match(source, /new Compartment\(\)/);
  assert.match(source, /languageCompartment\.reconfigure/);
  assert.match(source, /wrapCompartment\.reconfigure/);
});

test("FileEditor builds its own theme from CSS variables", () => {
  assert.match(source, /EditorView\.theme\(/);
  assert.match(source, /var\(--bg\)/);
  assert.match(source, /var\(--text\)/);
  assert.match(source, /var\(--font-mono\)/);
  assert.match(source, /var\(--bg-selected\)/);
  assert.doesNotMatch(source, /theme-one-dark/);
});