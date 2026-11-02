import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  SYSTEM_PROMPT_LIBRARY_FILE,
  SYSTEM_PROMPT_STATE_FILE,
  buildSystemPromptsResponse,
  formatSelectedSystemPrompt,
  readSelectedSystemPrompt,
  readSystemPromptLibrary,
  resolveSystemPromptState,
} = await jiti.import("./system-prompt-library.ts");

function agentDir(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-sysprompt-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === "string" ? content : JSON.stringify(content, null, 2), "utf8");
  }
  return dir;
}

test("reads the library in file order with its modes and scope", () => {
  const dir = agentDir({
    [SYSTEM_PROMPT_LIBRARY_FILE]: {
      surgical: { description: "Minimal diffs", text: "Prefer small diffs", mode: "append" },
      strict: { text: "Be strict", mode: "replace", models: ["anthropic/claude-x", 7, ""] },
      preface: { text: "Read this first", mode: "prepend" },
      malformed: { description: "no text" },
      blank: { text: "   " },
      notAnObject: "text",
    },
  });

  assert.deepEqual(readSystemPromptLibrary(dir), [
    { name: "surgical", description: "Minimal diffs", mode: "append", models: null },
    { name: "strict", description: null, mode: "replace", models: ["anthropic/claude-x"] },
    { name: "preface", description: null, mode: "prepend", models: null },
  ]);
});

test("a missing or unparsable library has nothing to pick", () => {
  assert.deepEqual(readSystemPromptLibrary(agentDir()), []);
  assert.deepEqual(readSystemPromptLibrary(agentDir({ [SYSTEM_PROMPT_LIBRARY_FILE]: "{ nope" })), []);
  assert.deepEqual(readSystemPromptLibrary(agentDir({ [SYSTEM_PROMPT_LIBRARY_FILE]: [] })), []);
});

test("a session's own entry wins over the default", () => {
  const dir = agentDir({
    [SYSTEM_PROMPT_STATE_FILE]: {
      default: { enabled: true, active: "surgical" },
      sessions: { "s-1": { enabled: false, active: "strict" } },
    },
  });

  assert.deepEqual(resolveSystemPromptState(dir, "s-1"), {
    state: { enabled: false, active: "strict" },
    scoped: true,
  });
  assert.deepEqual(resolveSystemPromptState(dir, "unknown"), {
    state: { enabled: true, active: "surgical" },
    scoped: false,
  });
  assert.deepEqual(resolveSystemPromptState(dir, null), {
    state: { enabled: true, active: "surgical" },
    scoped: false,
  });
});

test("the pre-per-session flat state reads as the default", () => {
  const dir = agentDir({ [SYSTEM_PROMPT_STATE_FILE]: { enabled: true, active: "concise" } });
  assert.deepEqual(resolveSystemPromptState(dir, "s-1"), {
    state: { enabled: true, active: "concise" },
    scoped: false,
  });
});

test("no state file, or one whose entry is unusable, is off", () => {
  assert.deepEqual(resolveSystemPromptState(agentDir(), "s-1"), { state: { enabled: false, active: null }, scoped: false });
  const dir = agentDir({
    [SYSTEM_PROMPT_STATE_FILE]: { default: { enabled: true, active: "surgical" }, sessions: { "s-1": null } },
  });
  assert.deepEqual(resolveSystemPromptState(dir, "s-1"), { state: { enabled: true, active: "surgical" }, scoped: false });
});

test("a session id that could collide with a prototype key falls back to the default", () => {
  const dir = agentDir({
    [SYSTEM_PROMPT_STATE_FILE]: {
      default: { enabled: true, active: "surgical" },
      sessions: { "s-1": { enabled: true, active: "strict" } },
    },
  });
  assert.deepEqual(resolveSystemPromptState(dir, "__proto__"), {
    state: { enabled: true, active: "surgical" },
    scoped: false,
  });
  assert.deepEqual(resolveSystemPromptState(dir, "constructor"), {
    state: { enabled: true, active: "surgical" },
    scoped: false,
  });
});

test("the response joins the library with the state one session uses", () => {
  const dir = agentDir({
    [SYSTEM_PROMPT_LIBRARY_FILE]: { surgical: { text: "Prefer small diffs" }, strict: { text: "Be strict" } },
    [SYSTEM_PROMPT_STATE_FILE]: {
      default: { enabled: false, active: null },
      sessions: { "s-1": { enabled: true, active: "strict" } },
    },
  });

  assert.deepEqual(buildSystemPromptsResponse(dir, "s-1"), {
    prompts: [
      { name: "surgical", description: null, mode: "append", models: null },
      { name: "strict", description: null, mode: "append", models: null },
    ],
    enabled: true,
    active: "strict",
    sessionScoped: true,
  });
});

test("the selected prompt is the one the session runs with", () => {
  const dir = agentDir({
    [SYSTEM_PROMPT_LIBRARY_FILE]: {
      surgical: { description: "Minimal diffs", text: "Prefer small diffs", mode: "append" },
      strict: { text: "Be strict", mode: "replace" },
    },
    [SYSTEM_PROMPT_STATE_FILE]: {
      default: { enabled: false, active: null },
      sessions: { "s-1": { enabled: true, active: "surgical" } },
    },
  });

  assert.deepEqual(readSelectedSystemPrompt(dir, "s-1"), {
    name: "surgical",
    description: "Minimal diffs",
    mode: "append",
    text: "Prefer small diffs",
  });
  assert.equal(readSelectedSystemPrompt(dir, "s-2"), null);
});

test("a disabled, nameless or removed prompt means the session runs on pi's own", () => {
  const off = agentDir({
    [SYSTEM_PROMPT_LIBRARY_FILE]: { surgical: { text: "Prefer small diffs" } },
    [SYSTEM_PROMPT_STATE_FILE]: { default: { enabled: false, active: "surgical" } },
  });
  assert.equal(readSelectedSystemPrompt(off, "s-1"), null);

  const removed = agentDir({
    [SYSTEM_PROMPT_LIBRARY_FILE]: {},
    [SYSTEM_PROMPT_STATE_FILE]: { default: { enabled: true, active: "gone" } },
  });
  assert.equal(readSelectedSystemPrompt(removed, "s-1"), null);
});

test("the exported text names the prompt and how it joins pi's own", () => {
  assert.equal(
    formatSelectedSystemPrompt({ name: "surgical", description: "Minimal diffs", mode: "append", text: "Prefer small diffs" }),
    "System prompt: surgical — Minimal diffs\nMode: append — it is added after pi's own system prompt\n\nPrefer small diffs",
  );
  assert.equal(
    formatSelectedSystemPrompt({ name: "strict", description: null, mode: "replace", text: "Be strict" }),
    "System prompt: strict\nMode: replace — it replaces pi's own system prompt\n\nBe strict",
  );
});
