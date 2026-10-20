import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { loadLanguageExtension } from "./code-languages.ts";

test("loadLanguageExtension resolves mapped language ids", async () => {
  const typescript = await loadLanguageExtension("typescript");
  const markdown = await loadLanguageExtension("markdown");
  assert.notEqual(typescript, null);
  assert.notEqual(markdown, null);
});

test("loadLanguageExtension returns null for unmapped language ids", async () => {
  assert.equal(await loadLanguageExtension("text"), null);
  assert.equal(await loadLanguageExtension("bash"), null);
});

test("language packages are only imported dynamically", async () => {
  const source = await readFile(new URL("./code-languages.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["']@codemirror\/lang-/);
});