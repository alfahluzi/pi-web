import test from "node:test";
import assert from "node:assert/strict";

import { getLanguage } from "./file-language.ts";

test("getLanguage maps common extensions", () => {
  assert.equal(getLanguage("src/a.ts"), "typescript");
  assert.equal(getLanguage("a.tsx"), "typescript");
  assert.equal(getLanguage("Dockerfile.dev"), "dockerfile");
  assert.equal(getLanguage(".env.local"), "bash");
  assert.equal(getLanguage("Makefile"), "makefile");
  assert.equal(getLanguage("notes.md"), "markdown");
  assert.equal(getLanguage("unknown.zzz"), "text");
});