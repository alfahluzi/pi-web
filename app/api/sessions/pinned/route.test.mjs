import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const postStart = source.indexOf("export async function POST");
const postBlock = source.slice(postStart);
assert.notEqual(postStart, -1, "POST handler not found");

test("GET and POST both bypass caches", () => {
  assert.match(source, /export async function GET\(\)/);
  assert.match(source, /"Cache-Control": "no-store"/);
  assert.match(source, /export async function POST\(req: Request\)/);
  assert.match(source, /export const dynamic = "force-dynamic"/);
});

test("POST validates the toggle before touching the pins file", () => {
  const sessionIdGuard = postBlock.indexOf("sessionId is required");
  const pinnedGuard = postBlock.indexOf("pinned must be a boolean");
  const write = postBlock.indexOf("writePinnedSessionIds");
  assert.ok(sessionIdGuard >= 0 && pinnedGuard >= 0, "missing request validation");
  assert.ok(sessionIdGuard < write && pinnedGuard < write, "validation must precede the write");
  assert.match(postBlock, /togglePinnedId\(readPinnedSessionIds\(\), sessionId, body\.pinned\)/);
});

test("the response echoes the stored list so the client can drop optimistic state", () => {
  assert.match(postBlock, /NextResponse\.json\(\{ pinnedSessionIds \}/);
});
