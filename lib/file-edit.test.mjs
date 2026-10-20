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
  FILE_EDIT_TOO_LARGE_ERROR,
  MAX_FILE_EDIT_BYTES,
  fileRevision,
  validateFileEditInput,
} = await jiti.import("./file-edit.ts");
const { writeFileAtomicSync } = await jiti.import("./atomic-file.ts");
const { TEXT_PREVIEW_MAX_BYTES } = await jiti.import("./file-types.ts");

const OVER_PREVIEW = { size: TEXT_PREVIEW_MAX_BYTES + 1, revision: "rev" };
const NORMAL = { size: 10, revision: "rev" };

test("reports the file as too large before validating the body", () => {
  assert.deepEqual(validateFileEditInput(null, OVER_PREVIEW), {
    ok: false,
    status: 413,
    error: FILE_EDIT_TOO_LARGE_ERROR,
  });
});

test("rejects a null body with 400", () => {
  assert.deepEqual(validateFileEditInput(null, NORMAL), {
    ok: false,
    status: 400,
    error: "Expected { content, baseRevision }",
  });
});

test("rejects a non-object body with 400", () => {
  assert.deepEqual(validateFileEditInput("not-an-object", NORMAL), {
    ok: false,
    status: 400,
    error: "Expected { content, baseRevision }",
  });
});

test("rejects a non-string content with 400", () => {
  assert.deepEqual(validateFileEditInput({ content: 42, baseRevision: "rev" }, NORMAL), {
    ok: false,
    status: 400,
    error: "Expected { content, baseRevision }",
  });
});

test("rejects a non-string baseRevision with 400", () => {
  assert.deepEqual(validateFileEditInput({ content: "hi", baseRevision: 7 }, NORMAL), {
    ok: false,
    status: 400,
    error: "Expected { content, baseRevision }",
  });
});

test("rejects content over MAX_FILE_EDIT_BYTES with 413", () => {
  const content = "a".repeat(MAX_FILE_EDIT_BYTES + 1);
  assert.deepEqual(validateFileEditInput({ content, baseRevision: "rev" }, NORMAL), {
    ok: false,
    status: 413,
    error: FILE_EDIT_TOO_LARGE_ERROR,
  });
});

test("rejects NUL bytes with 415", () => {
  assert.deepEqual(
    validateFileEditInput({ content: "a\u0000b", baseRevision: "rev" }, NORMAL),
    { ok: false, status: 415, error: "Binary files cannot be edited" },
  );
});

test("rejects a stale baseRevision with 409", () => {
  assert.deepEqual(validateFileEditInput({ content: "hi", baseRevision: "old" }, NORMAL), {
    ok: false,
    status: 409,
    error: "File changed on disk",
  });
});

test("returns the content when every check passes", () => {
  assert.deepEqual(validateFileEditInput({ content: "hello\n", baseRevision: "rev" }, NORMAL), {
    ok: true,
    content: "hello\n",
  });
});

test("formats a synthetic stat as a revision string", () => {
  assert.equal(
    fileRevision({ mtimeMs: 1699999999123.9, size: 4096, ino: 8675309 }),
    "1699999999123:4096:8675309",
  );
});

test("atomically writes content while preserving the mode and leaking no temp file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-edit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "note.txt");

  writeFileAtomicSync(file, "hello\n", 0o644);

  assert.equal(fs.readFileSync(file, "utf8"), "hello\n");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  }
  assert.deepEqual(fs.readdirSync(dir), ["note.txt"]);
});