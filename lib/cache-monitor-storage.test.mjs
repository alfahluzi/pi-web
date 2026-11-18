import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  ACTIVE_CAPTURE,
  CAPTURE_RETENTION_MS,
  MAX_CAPTURE_BYTES,
  appendCapture,
  expireCaptures,
} from './cache-monitor-storage.ts';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function record(timestamp_ms) {
  return { schema_version: 1, local_epoch_id: uuid(1), sequence: 0, timestamp_ms, local_invocation_id: uuid(2), local_stream_id: uuid(9), invocation_index: 0, provider: 'other', model_id_hash: null, config_id_hash: null, event_type: 'unknown', association: 'unmatched', fingerprints: { prompt: null }, usage: null, incomplete: false };
}

function line(timestamp_ms) {
  return `${JSON.stringify(record(timestamp_ms))}\n`;
}

async function ownedNames(directory) {
  return (await readdir(directory)).filter(name => /^cache-monitor(?:\.[1-3])?\.jsonl$/.test(name)).sort();
}

test('creates a restrictive directory and capture file on first append', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cache-monitor-storage-'));
  const directory = join(root, 'capture');
  try {
    await appendCapture(directory, line(1000), 1000);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const active = join(directory, ACTIVE_CAPTURE);
    assert.equal((await stat(active)).mode & 0o777, 0o600);
    assert.equal(await readFile(active, 'utf8'), line(1000));
    await appendCapture(directory, line(1001), 1001);
    assert.equal(await readFile(active, 'utf8'), line(1000) + line(1001));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rotates into exactly four bounded 0600 files without rewriting record timestamps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-storage-'));
  try {
    const oldest = 1_000_000;
    const now = oldest + CAPTURE_RETENTION_MS - 1;
    const unit = `${JSON.stringify(record(oldest))}\n`;
    const added = Buffer.byteLength(line(now));
    const copies = Math.floor((MAX_CAPTURE_BYTES - added) / Buffer.byteLength(unit)) + 1;
    assert.ok(copies * Buffer.byteLength(unit) <= MAX_CAPTURE_BYTES);
    for (const name of [ACTIVE_CAPTURE, 'cache-monitor.1.jsonl', 'cache-monitor.2.jsonl', 'cache-monitor.3.jsonl']) {
      await writeFile(join(directory, name), unit.repeat(copies));
    }
    await writeFile(join(directory, 'unrelated.bin'), 'untouched');
    await appendCapture(directory, line(now), now);
    assert.deepEqual(await ownedNames(directory), ['cache-monitor.1.jsonl', 'cache-monitor.2.jsonl', 'cache-monitor.3.jsonl', ACTIVE_CAPTURE].sort());
    for (const name of await ownedNames(directory)) {
      assert.ok((await stat(join(directory, name))).size <= MAX_CAPTURE_BYTES, `${name} stays bounded`);
      assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600, `${name} is mode 0600`);
    }
    assert.ok((await readFile(join(directory, 'cache-monitor.3.jsonl'), 'utf8')).includes(JSON.stringify(record(oldest))), 'rotation keeps the old record timestamp');
    const activeRows = (await readFile(join(directory, ACTIVE_CAPTURE), 'utf8')).split('\n').filter(Boolean);
    assert.equal(activeRows.length, 1);
    assert.equal(JSON.parse(activeRows[0]).timestamp_ms, now);
    assert.equal(await readFile(join(directory, 'unrelated.bin'), 'utf8'), 'untouched');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('reports the oldest expiry and deletes each capture at its exact boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-storage-'));
  try {
    await writeFile(join(directory, ACTIVE_CAPTURE), line(1000) + line(2000));
    await writeFile(join(directory, 'cache-monitor.1.jsonl'), line(3000));
    assert.equal(await expireCaptures(directory, 1000 + CAPTURE_RETENTION_MS - 1), 1000 + CAPTURE_RETENTION_MS);
    assert.equal(await expireCaptures(directory, 1000 + CAPTURE_RETENTION_MS), 3000 + CAPTURE_RETENTION_MS);
    assert.deepEqual(await ownedNames(directory), ['cache-monitor.1.jsonl']);
    assert.equal(await expireCaptures(directory, 3000 + CAPTURE_RETENTION_MS), Infinity);
    assert.deepEqual(await ownedNames(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('rechecks expiry before append and recreates the active capture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-storage-'));
  try {
    const boundary = 1000 + CAPTURE_RETENTION_MS;
    await writeFile(join(directory, ACTIVE_CAPTURE), line(1000));
    await appendCapture(directory, line(boundary), boundary);
    const content = await readFile(join(directory, ACTIVE_CAPTURE), 'utf8');
    assert.equal(content, line(boundary));
    const rows = content.trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].timestamp_ms, boundary, 'expired record is gone, not rotated forward');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('rejects malformed, future, oversized and symlinked captures without modifying them', async () => {
  const fixtures = [
    ['malformed', '{"invalid":true}\n', 1000],
    ['future', line(2000), 1000],
    ['truncated', `${JSON.stringify(record(1000))}`, 1000],
    ['blank record', line(1000) + '\n', 1000],
    ['oversized file', 'x'.repeat(MAX_CAPTURE_BYTES + 1), 1000],
  ];
  for (const [name, content, clock] of fixtures) {
    const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-storage-'));
    try {
      const path = join(directory, ACTIVE_CAPTURE);
      await writeFile(path, content);
      await assert.rejects(expireCaptures(directory, clock), name);
      await assert.rejects(appendCapture(directory, line(clock), clock), name);
      assert.equal(await readFile(path, 'utf8'), content, `${name} is untouched`);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-storage-'));
  try {
    const target = join(directory, 'unrelated.txt');
    await writeFile(target, 'untouched');
    await symlink(target, join(directory, ACTIVE_CAPTURE));
    await assert.rejects(expireCaptures(directory, 1000), /identity changed|regular file|ELOOP/);
    await assert.rejects(appendCapture(directory, line(1000), 1000));
    assert.equal(await readFile(target, 'utf8'), 'untouched');
    assert.ok((await readdir(directory)).includes(ACTIVE_CAPTURE), 'symlink is not replaced');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('ignores captures outside the owned rotation range and unrelated files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-storage-'));
  try {
    await writeFile(join(directory, 'cache-monitor.4.jsonl'), 'unrelated');
    await writeFile(join(directory, 'notes.txt'), 'unrelated');
    assert.equal(await expireCaptures(directory, 1000 + CAPTURE_RETENTION_MS * 2), Infinity);
    await appendCapture(directory, line(1000), 1000);
    assert.equal(await readFile(join(directory, 'cache-monitor.4.jsonl'), 'utf8'), 'unrelated');
    assert.equal(await readFile(join(directory, 'notes.txt'), 'utf8'), 'unrelated');
    assert.deepEqual(await ownedNames(directory), [ACTIVE_CAPTURE]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('bounds directory enumeration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-storage-'));
  try {
    for (let index = 0; index < 17; index++) await writeFile(join(directory, `entry-${index}`), '');
    await assert.rejects(expireCaptures(directory, 1000), /too many directory entries/);
    await assert.rejects(appendCapture(directory, line(1000), 1000), /too many directory entries/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('FIFO capture does not block storage scans or appends', () => {
  const script = String.raw`
    import { execFileSync } from 'node:child_process';
    import { mkdtemp, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-storage-fifo-'));
    try {
      execFileSync('mkfifo', [join(directory, 'cache-monitor.jsonl')]);
      const { appendCapture, expireCaptures } = await import('./lib/cache-monitor-storage.ts');
      await expireCaptures(directory, 1000).catch(() => undefined);
      await appendCapture(directory, '{"x":1}\n', 1000).catch(() => undefined);
    } finally { await rm(directory, { recursive: true, force: true }); }
  `;
  const result = spawnSync('node', ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000, cwd: projectRoot });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('rejects a path swap at the append open boundary and preserves the replacement', () => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import * as fsPromises from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const originalOpen = fsPromises.open;
    let swaps = 0;
    fs.promises.open = async (path, flags, ...rest) => {
      if (!swaps && (flags & fs.constants.O_WRONLY) !== 0) {
        swaps++;
        await rename(path, path + '.old');
        await writeFile(path, 'replacement must survive');
      }
      return originalOpen(path, flags, ...rest);
    };
    syncBuiltinESMExports();
    const { appendCapture } = await import('./lib/cache-monitor-storage.ts');
    const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-storage-swap-'));
    try {
      const active = join(directory, 'cache-monitor.jsonl');
      await writeFile(active, '');
      await appendCapture(directory, '{"placeholder":true}\n', 1000).catch(() => undefined);
      assert.equal(swaps, 1);
      assert.equal(await readFile(active, 'utf8'), 'replacement must survive');
    } finally { await rm(directory, { recursive: true, force: true }); }
  `;
  const result = spawnSync('node', ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000, cwd: projectRoot });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
