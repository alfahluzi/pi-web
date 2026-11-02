import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const {
  JsonTree,
  JSON_TREE_MAX_CHARS,
  JSON_TREE_MAX_NODES,
  asJsonTreeValue,
} = await jiti.import("./JsonTree.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function toHtml(value) {
  return renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(JsonTree, { value })),
  );
}

function nest(depth) {
  let value = "leaf";
  for (let i = 0; i < depth; i++) value = { [`level${i}`]: value };
  return value;
}

test("only objects and arrays become a tree", () => {
  assert.equal(asJsonTreeValue(null, 2), null);
  assert.equal(asJsonTreeValue("text", 6), null);
  assert.equal(asJsonTreeValue(42, 2), null);
  assert.deepEqual(asJsonTreeValue([], 2), []);
});

test("a payload past the text budget keeps the raw view", () => {
  const value = { path: "/tmp/a.txt" };
  assert.deepEqual(asJsonTreeValue(value, 100), value);
  assert.equal(asJsonTreeValue(value, JSON_TREE_MAX_CHARS + 1), null);
});

test("a payload past the node budget keeps the raw view", () => {
  const wide = {};
  for (let i = 0; i <= JSON_TREE_MAX_NODES; i++) wide[`key${i}`] = i;
  assert.equal(asJsonTreeValue(wide, 100), null);
  const small = {};
  for (let i = 0; i < 10; i++) small[`key${i}`] = i;
  assert.deepEqual(asJsonTreeValue(small, 100), small);
});

test("a payload nested deeper than 32 levels keeps the raw view", () => {
  assert.equal(asJsonTreeValue(nest(40), 100), null);
});

test("renders a top-level key with its scalar value", () => {
  const html = toHtml({ path: "/tmp/report.txt" });
  assert.match(html, /path/);
  assert.match(html, /\/tmp\/report\.txt/);
});

test("a folded container hides its own children", () => {
  const html = toHtml({ outer: { middle: { hidden: "secret" } } });
  assert.match(html, /outer/);
  assert.match(html, /middle/);
  assert.match(html, /\{\u2026\}/);
  assert.doesNotMatch(html, /hidden/);
  assert.doesNotMatch(html, /secret/);
  assert.match(html, /aria-expanded="false"/);
});

test("a folded array is marked as one and keeps its indexes", () => {
  const itemHtml = toHtml([`item text`]);
  assert.match(itemHtml, /item text/);
  assert.match(itemHtml, />0</);
  assert.match(toHtml({ list: [[1, 2]] }), /\[\u2026\]/);
});

test("a long string is cut at 300 characters", () => {
  const text = "x".repeat(400);
  const html = toHtml({ blob: text });
  assert.match(html, new RegExp(`${"x".repeat(300)}…`));
  assert.doesNotMatch(html, new RegExp(`x{301}…`));
});

test("an empty object renders {} and no toggle", () => {
  const html = toHtml({});
  assert.match(html, /\{\}/);
  assert.doesNotMatch(html, /aria-expanded/);
  assert.doesNotMatch(html, /<button/);
});
