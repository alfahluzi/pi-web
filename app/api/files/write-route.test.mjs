import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./[...path]/route.ts", import.meta.url), "utf8");
const start = source.indexOf("export async function PUT");
const end = source.indexOf("function createFileBodyStream", start);
assert.notEqual(start, -1, "PUT route not found");
assert.notEqual(end, -1, "PUT route end not found");
const putBlock = source.slice(start, end);

test("PUT handler exists with the expected signature", () => {
  assert.match(
    source,
    /export async function PUT\(\s*request: NextRequest,\s*\{ params \}: \{ params: Promise<\{ path: string\[\] \}> \}\s*\)/,
  );
});

test("PUT enforces the guard order: origin, content type, then filesystem", () => {
  const origin = putBlock.indexOf("isApiRequestAllowed(request)");
  const contentType = putBlock.indexOf("hasJsonContentType(request)");
  const firstFsCall = putBlock.search(/fs\./);

  assert.ok(origin >= 0, "origin check missing");
  assert.ok(contentType >= 0, "content-type check missing");
  assert.ok(firstFsCall >= 0, "filesystem access missing");
  assert.ok(origin < contentType, "origin check must precede content-type check");
  assert.ok(contentType < firstFsCall, "content-type check must precede filesystem access");
});

test("PUT authorizes against roots and existing-path containment", () => {
  assert.match(putBlock, /const allowedRoots = await getAllowedFileRoots\(\)/);
  assert.match(putBlock, /isFilePathAllowed\(filePath, allowedRoots\)/);
  assert.match(putBlock, /isExistingFilePathAllowed\(filePath, allowedRoots\)/);
  assert.doesNotMatch(putBlock, /isFilePathReferencedBySession/);
});

test("PUT refuses symbolic links and non-files", () => {
  assert.match(putBlock, /fs\.lstatSync\(filePath\)/);
  assert.match(putBlock, /if \(lstat\.isSymbolicLink\(\)\)/);
  assert.match(putBlock, /Cannot write through a symbolic link/);
  assert.match(putBlock, /if \(!lstat\.isFile\(\)\)/);
  assert.match(putBlock, /Not a file/);
});

test("PUT validates the edit against the current revision", () => {
  assert.match(putBlock, /const stat = fs\.statSync\(filePath\)/);
  assert.match(putBlock, /const revision = fileRevision\(stat\)/);
  assert.match(putBlock, /await request\.json\(\)\.catch\(\(\) => null\)/);
  assert.match(putBlock, /validateFileEditInput\(body, \{ size: stat\.size, revision \}\)/);
});

test("PUT writes atomically preserving permission bits and returns the next revision", () => {
  assert.match(putBlock, /writeFileAtomicSync\(filePath, validated\.content, stat\.mode & 0o777\)/);
  assert.match(putBlock, /const next = fs\.statSync\(filePath\)/);
  assert.match(putBlock, /revision: fileRevision\(next\)/);
  assert.match(putBlock, /size: next\.size/);
  assert.match(putBlock, /mtime: next\.mtime\.toISOString\(\)/);
});

test("the text read response exposes the revision token", () => {
  assert.match(source, /return NextResponse\.json\(\{ \.\.\.chunk, language, size: stat\.size, revision: fileRevision\(stat\) \}\)/);
});