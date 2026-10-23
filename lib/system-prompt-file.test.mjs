import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const {
  SYSTEM_PROMPT_TARGETS,
  applySystemPromptWrite,
  deleteSystemPromptFile,
  isSystemPromptTarget,
  readSystemPromptFile,
  statSystemPromptEntry,
  systemPromptEntryState,
  systemPromptFileName,
  systemPromptPath,
  writeSystemPromptFile,
} = await jiti.import("./system-prompt-file.ts");

function agentDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-system-prompt-"));
}

test("accepts only the two files pi reads as its prompt", () => {
  for (const target of SYSTEM_PROMPT_TARGETS) assert.equal(isSystemPromptTarget(target), true);
  for (const value of ["", "system.md", "SYSTEM.md", "append ", 0, null, undefined, {}]) {
    assert.equal(isSystemPromptTarget(value), false);
  }
  assert.equal(systemPromptFileName("system"), "SYSTEM.md");
  assert.equal(systemPromptFileName("append"), "APPEND_SYSTEM.md");
  assert.equal(systemPromptPath("/agent", "append"), path.join("/agent", "APPEND_SYSTEM.md"));
});

test("classifies what lstat found, refusing anything but a regular file", () => {
  assert.equal(systemPromptEntryState({ isFile: true, isSymbolicLink: false, isDirectory: false }), "file");
  assert.equal(systemPromptEntryState({ isFile: false, isSymbolicLink: true, isDirectory: false }), "symlink");
  assert.equal(systemPromptEntryState({ isFile: false, isSymbolicLink: false, isDirectory: true }), "directory");
  assert.equal(systemPromptEntryState({ isFile: false, isSymbolicLink: false, isDirectory: false }), "special");
});

test("a missing file reads as empty with an empty revision", () => {
  const dir = agentDir();
  const file = readSystemPromptFile(dir, "system");
  assert.equal(file.exists, false);
  assert.equal(file.content, "");
  assert.equal(file.revision, "");
  assert.equal(file.blocked, null);
  assert.equal(statSystemPromptEntry(systemPromptPath(dir, "system")).state, "missing");
});

test("a write creates the directory and a file pi can read, and the revision moves", () => {
  const dir = path.join(agentDir(), "nested", "agent");
  const first = writeSystemPromptFile(dir, "system", "You are terse.\n");
  assert.equal(first.ok, true);
  assert.equal(first.exists, true);
  assert.notEqual(first.revision, "");

  const read = readSystemPromptFile(dir, "system");
  assert.equal(read.content, "You are terse.\n");
  assert.equal(read.revision, first.revision);
  assert.equal(read.size, Buffer.byteLength("You are terse.\n"));

  const second = writeSystemPromptFile(dir, "system", "You are still terse.\n");
  assert.equal(second.ok, true);
  assert.notEqual(second.revision, first.revision);
});

test("a write keeps the mode an existing file has", () => {
  const dir = agentDir();
  const file = systemPromptPath(dir, "append");
  fs.writeFileSync(file, "old\n", { mode: 0o600 });
  const written = writeSystemPromptFile(dir, "append", "new\n");
  assert.equal(written.ok, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("a save whose revision is stale is refused instead of overwriting", () => {
  const dir = agentDir();
  const file = systemPromptPath(dir, "system");
  fs.writeFileSync(file, "first\n");
  const stale = readSystemPromptFile(dir, "system").revision;
  fs.writeFileSync(file, "changed by someone else\n");

  const refused = applySystemPromptWrite(dir, "system", { content: "mine\n", baseRevision: stale });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 409);
  assert.match(refused.error, /changed on disk/i);
  assert.equal(fs.readFileSync(file, "utf8"), "changed by someone else\n");
});

test("a save creates the file only when the client saw it missing", () => {
  const dir = agentDir();
  const refused = applySystemPromptWrite(dir, "system", { content: "mine\n", baseRevision: "1:2:3" });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 409);

  const created = applySystemPromptWrite(dir, "system", { content: "mine\n", baseRevision: "" });
  assert.equal(created.ok, true);
  assert.equal(fs.readFileSync(systemPromptPath(dir, "system"), "utf8"), "mine\n");
});

test("a save without a revision, with a NUL byte or too large is refused", () => {
  const dir = agentDir();
  writeSystemPromptFile(dir, "system", "x\n");
  const revision = readSystemPromptFile(dir, "system").revision;

  assert.equal(applySystemPromptWrite(dir, "system", { content: "x" }).status, 400);
  assert.equal(applySystemPromptWrite(dir, "system", { content: "a\u0000b", baseRevision: revision }).status, 415);
  const huge = "x".repeat(1024 * 1024 + 1);
  assert.equal(applySystemPromptWrite(dir, "system", { content: huge, baseRevision: revision }).status, 413);
  assert.equal(fs.readFileSync(systemPromptPath(dir, "system"), "utf8"), "x\n");
});

test("a symbolic link is reported and never written through", () => {
  const dir = agentDir();
  const target = path.join(dir, "real.md");
  fs.writeFileSync(target, "real\n");
  fs.symlinkSync(target, systemPromptPath(dir, "system"));

  const read = readSystemPromptFile(dir, "system");
  assert.equal(read.blocked, "symlink");
  assert.equal(read.content, "");

  const refused = applySystemPromptWrite(dir, "system", { content: "mine\n", baseRevision: read.revision });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 403);
  assert.equal(fs.readFileSync(target, "utf8"), "real\n");
  assert.equal(deleteSystemPromptFile(dir, "system").ok, false);
});

test("resetting deletes the file, and deleting a missing one is not an error", () => {
  const dir = agentDir();
  writeSystemPromptFile(dir, "system", "mine\n");
  assert.deepEqual(deleteSystemPromptFile(dir, "system"), { ok: true, exists: false });
  assert.equal(fs.existsSync(systemPromptPath(dir, "system")), false);
  assert.deepEqual(deleteSystemPromptFile(dir, "system"), { ok: true, exists: false });
});

test("a file larger than the read cap is reported, not read", () => {
  const dir = agentDir();
  const file = systemPromptPath(dir, "system");
  fs.writeFileSync(file, "x".repeat(256 * 1024 + 1));
  const read = readSystemPromptFile(dir, "system");
  assert.equal(read.tooLarge, true);
  assert.equal(read.content, "");
  assert.equal(read.exists, true);
  assert.equal(applySystemPromptWrite(dir, "system", { content: "mine\n", baseRevision: read.revision }).status, 413);
});
