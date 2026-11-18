import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, mkdir, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCacheMonitor } from './cache-monitor.ts';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const testDirectory = fileURLToPath(new URL('.', import.meta.url));

async function rowsIn(directory) {
  const files = (await readdir(directory)).filter(name => name.startsWith('cache-monitor'));
  return (await Promise.all(files.map(async name => (await readFile(join(directory, name), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)))).flat();
}

test('queue overflow marks next accepted record as telemetry gap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-'));
  try {
    const monitor = createCacheMonitor({ enabled: true, directory, randomUUID: () => uuid(1) });
    for (let i = 0; i < 65; i++) monitor.markUnknown(null, 'unmatched');
    let rows = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      rows = await rowsIn(directory);
      if (rows.length >= 64) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(rows.length, 64);
    monitor.markUnknown(null, 'unmatched');
    await monitor.close();
    rows = await rowsIn(directory);
    assert.equal(rows.length, 65);
    assert.equal(rows.at(-1).association, 'telemetry_gap');
    assert.equal(rows.at(-1).incomplete, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('startup retention expires autonomously on deadline after clock advance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-'));
  try {
    const path = join(directory, 'cache-monitor.jsonl');
    const expired = { schema_version: 1, local_epoch_id: uuid(1), sequence: 0, timestamp_ms: 1_000, local_invocation_id: uuid(2), local_stream_id: uuid(9), invocation_index: 0, provider: 'other', model_id_hash: null, config_id_hash: null, event_type: 'unknown', association: 'unmatched', fingerprints: { prompt: null }, usage: null, incomplete: false };
    await writeFile(path, `${JSON.stringify(expired)}\n`);
    let clock = 1_000 + 7 * 24 * 60 * 60 * 1000 - 100;
    const monitor = createCacheMonitor({ enabled: true, directory, now: () => clock, randomUUID: () => uuid(10) });
    await new Promise(resolve => setTimeout(resolve, 150));
    clock += 100;
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal((await readdir(directory)).includes('cache-monitor.jsonl'), false);
    await monitor.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('rotation keeps four bounded files and retains original oldest expiry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-'));
  try {
    const age = 7 * 24 * 60 * 60 * 1000;
    let now = age + 10_000_000;
    const sample = { schema_version: 1, local_epoch_id: uuid(1), sequence: 0, timestamp_ms: now - age + 1, local_invocation_id: uuid(2), local_stream_id: uuid(9), invocation_index: 0, provider: 'other', model_id_hash: null, config_id_hash: null, event_type: 'unknown', association: 'unmatched', fingerprints: { prompt: null }, usage: null, incomplete: false };
    const row = JSON.stringify(sample);
    const unit = `${row}\n`;
    // Fill each file to within a few KB of the cap and append a record larger than
    // the remaining headroom so the append is guaranteed to rotate.
    const count = Math.floor((1024 * 1024 - 600) / Buffer.byteLength(unit)) + 1;
    for (const name of ['cache-monitor.jsonl', 'cache-monitor.1.jsonl', 'cache-monitor.2.jsonl', 'cache-monitor.3.jsonl']) {
      await writeFile(join(directory, name), unit.repeat(count));
    }
    const unrelated = join(directory, 'unrelated.bin');
    await writeFile(unrelated, 'untouched');
    const monitor = createCacheMonitor({ enabled: true, directory, now: () => now, randomUUID: () => uuid(10) });
    for (let index = 0; index < 2; index++) {
      const handle = monitor.beginInvocation({ localStreamId: uuid(9), invocationIndex: index, provider: 'other' });
      monitor.recordRequest(handle, { payload: { trigger: true, index } });
    }
    await monitor.close();
    const names = (await readdir(directory)).filter(name => /^cache-monitor(?:\.[1-3])?\.jsonl$/.test(name));
    assert.equal(names.length, 4);
    for (const name of names) assert.ok((await stat(join(directory, name))).size <= 1024 * 1024);
    assert.equal(await readFile(unrelated, 'utf8'), 'untouched');
    assert.ok(names.includes('cache-monitor.3.jsonl'));
    assert.ok((await readFile(join(directory, 'cache-monitor.3.jsonl'), 'utf8')).includes(String(now - age + 1)));
    assert.ok(!(await readFile(join(directory, 'cache-monitor.jsonl'), 'utf8')).includes(String(now - age + 1)), 'the old active file was rotated out of the active path');
    now += age + 2;
    const expiryMonitor = createCacheMonitor({ enabled: true, directory, now: () => now, randomUUID: () => uuid(20) });
    await expiryMonitor.close();
    assert.equal((await readdir(directory)).filter(name => /^cache-monitor(?:\.[1-3])?\.jsonl$/.test(name)).length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('FIFO capture does not block startup or close', () => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
    import { mkdtemp, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-fifo-'));
    try {
      execFileSync('mkfifo', [join(directory, 'cache-monitor.jsonl')]);
      const { createCacheMonitor } = await import('./lib/cache-monitor.ts');
      const monitor = createCacheMonitor({ enabled: true, directory });
      await monitor.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  `;
  const result = spawnSync('node', ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('replacement at append open boundary is rejected and preserved', () => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import * as fsPromises from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const originalOpen = fsPromises.open;
    let swapped = false;
    fs.promises.open = async (path, flags, ...rest) => {
      if (!swapped && (flags & fs.constants.O_WRONLY) !== 0) {
        swapped = true;
        await rename(path, path + '.old');
        await writeFile(path, 'replacement must survive');
      }
      return originalOpen(path, flags, ...rest);
    };
    syncBuiltinESMExports();
    const { createCacheMonitor } = await import('./lib/cache-monitor.ts');
    const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-swap-'));
    try {
      await writeFile(join(directory, 'cache-monitor.jsonl'), '');
      const monitor = createCacheMonitor({ enabled: true, directory, now: () => 1_000 });
      const handle = monitor.beginInvocation({ localStreamId: '00000000-0000-4000-8000-000000000009', invocationIndex: 0, provider: 'other' });
      monitor.recordRequest(handle, { payload: { safe: true } });
      await monitor.close();
      assert.equal(swapped, true);
      assert.equal(await readFile(join(directory, 'cache-monitor.jsonl'), 'utf8'), 'replacement must survive');
    } finally { await rm(directory, { recursive: true, force: true }); }
  `;
  const result = spawnSync('node', ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('startup ignores numbered captures outside owned rotation range', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-'));
  try {
    const path = join(directory, 'cache-monitor.4.jsonl');
    await writeFile(path, 'unrelated');
    const monitor = createCacheMonitor({ enabled: true, directory, randomUUID: () => uuid(1) });
    await monitor.close();
    assert.equal(await readFile(path, 'utf8'), 'unrelated');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('startup retention deletes exact seven-day expiry using record timestamp', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-'));
  try {
    const path = join(directory, 'cache-monitor.jsonl');
    const expired = { schema_version: 1, local_epoch_id: uuid(1), sequence: 0, timestamp_ms: 1000, local_invocation_id: uuid(2), local_stream_id: uuid(9), invocation_index: 0, provider: 'other', model_id_hash: null, config_id_hash: null, event_type: 'unknown', association: 'unmatched', fingerprints: { prompt: null }, usage: null, incomplete: false };
    await writeFile(path, `${JSON.stringify(expired)}\n`);
    const monitor = createCacheMonitor({ enabled: true, directory, now: () => 1000 + 7 * 24 * 60 * 60 * 1000, randomUUID: () => uuid(10) });
    monitor.beginInvocation({ localStreamId: uuid(9), invocationIndex: 0, provider: 'other' });
    await monitor.close();
    assert.equal((await readdir(directory)).includes('cache-monitor.jsonl'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('close drain false discards records not started and is idempotent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-'));
  try {
    const monitor = createCacheMonitor({ enabled: true, directory, randomUUID: () => uuid(1) });
    const handle = monitor.beginInvocation({ localStreamId: uuid(9), invocationIndex: 0, provider: 'other' });
    monitor.recordRequest(handle, { payload: { safe: true } });
    await monitor.close({ drain: false });
    await monitor.close({ drain: true });
    assert.deepEqual(await rowsIn(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('startup rejects malformed and future captures without overwriting them', async () => {
  for (const [suffix, content, clock] of [['bad', '{"invalid":true}\n', 1000], ['future', JSON.stringify({ schema_version: 1, local_epoch_id: uuid(1), sequence: 0, timestamp_ms: 2000 }) + '\n', 1000]]) {
    const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-'));
    try {
      const path = join(directory, 'cache-monitor.jsonl');
      await writeFile(path, content);
      const monitor = createCacheMonitor({ enabled: true, directory, now: () => clock, randomUUID: () => uuid(10) });
      const handle = monitor.beginInvocation({ localStreamId: uuid(9), invocationIndex: 0, provider: 'other' });
      monitor.recordRequest(handle, { payload: { safe: true } });
      await monitor.close();
      assert.equal(await readFile(path, 'utf8'), content, suffix);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('startup rejects oversized owned files without allocating unbounded reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-'));
  try {
    const path = join(directory, 'cache-monitor.jsonl');
    await writeFile(path, 'x'.repeat(1024 * 1024 + 1));
    const monitor = createCacheMonitor({ enabled: true, directory, randomUUID: () => uuid(1) });
    const handle = monitor.beginInvocation({ localStreamId: uuid(9), invocationIndex: 0, provider: 'other' });
    monitor.recordRequest(handle, { payload: { safe: true } });
    await monitor.close();
    assert.equal((await stat(path)).size, 1024 * 1024 + 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('append retention deletes at exact boundary after clock jump', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-'));
  try {
    const expiry = 1_000 + 7 * 24 * 60 * 60 * 1000;
    let clock = expiry - 5;
    const path = join(directory, 'cache-monitor.jsonl');
    const expired = { schema_version: 1, local_epoch_id: uuid(1), sequence: 0, timestamp_ms: 1_000, local_invocation_id: uuid(2), local_stream_id: uuid(9), invocation_index: 0, provider: 'other', model_id_hash: null, config_id_hash: null, event_type: 'unknown', association: 'unmatched', fingerprints: { prompt: null }, usage: null, incomplete: false };
    await writeFile(path, `${JSON.stringify(expired)}\n`);
    const monitor = createCacheMonitor({ enabled: true, directory, now: () => clock, randomUUID: () => uuid(10) });
    clock = expiry;
    const handle = monitor.beginInvocation({ localStreamId: uuid(9), invocationIndex: 0, provider: 'other' });
    monitor.recordRequest(handle, { payload: { safe: true } });
    await monitor.close();
    const rows = await rowsIn(directory);
    assert.equal((await readdir(directory)).includes('cache-monitor.jsonl'), true);
    assert.ok(rows.some(row => row.timestamp_ms === expiry));
    assert.ok(!rows.some(row => row.timestamp_ms === 1_000));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('startup validates exact nested schema before appending', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-'));
  try {
    const malformed = { schema_version: 1, local_epoch_id: uuid(1), sequence: 0, timestamp_ms: 1, local_invocation_id: uuid(2), local_stream_id: uuid(9), invocation_index: 0, provider: 'other', model_id_hash: null, config_id_hash: null, event_type: 'unknown', association: 'unmatched', fingerprints: { prompt: { hmac_sha256: 'not-a-digest', bytes: -1, complete: true } }, usage: null, incomplete: false };
    const path = join(directory, 'cache-monitor.jsonl');
    await writeFile(path, `${JSON.stringify(malformed)}\n`);
    const monitor = createCacheMonitor({ enabled: true, directory, randomUUID: () => uuid(10) });
    await monitor.close();
    assert.equal(await readFile(path, 'utf8'), `${JSON.stringify(malformed)}\n`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('close waits for active writes in both drain modes and blocks later writes', () => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { mkdtemp, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const { open: originalOpen } = fs.promises;
    let release;
    let entered;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    let writes = 0;
    fs.promises.open = async (...args) => {
      const handle = await originalOpen(...args);
      return new Proxy(handle, { get(target, key) {
        if (key === 'writeFile') return async (...writeArgs) => {
          writes++;
          if (writes === 1) { entered(); await gate; }
          return target.writeFile(...writeArgs);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }});
    };
    syncBuiltinESMExports();
    const activeTimers = new Set();
    for (const name of ['setTimeout', 'setInterval']) {
      const original = globalThis[name];
      globalThis[name] = (...args) => {
        const handle = original(...args);
        activeTimers.add(handle);
        const clearName = name === 'setTimeout' ? 'clearTimeout' : 'clearInterval';
        const clearOriginal = globalThis[clearName];
        globalThis[clearName] = timer => { activeTimers.delete(timer); return clearOriginal(timer); };
        handle.unref = () => handle;
        return handle;
      };
    }
    const { createCacheMonitor } = await import('./lib/cache-monitor.ts');
    const mode = process.argv[1] === 'true';
    const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-close-'));
    const monitor = createCacheMonitor({ enabled: true, directory });
    monitor.markUnknown(null, 'unmatched');
    await started;
    monitor.markUnknown(null, 'unmatched');
    let settled = false;
    const closing = monitor.close({ drain: mode }).then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    release();
    await closing;
    assert.equal(activeTimers.size, 0);
    const before = writes;
    monitor.markUnknown(null, 'unmatched');
    await monitor.close({ drain: true });
    assert.equal(writes, before);
    assert.equal(writes, mode ? 2 : 1);
    await rm(directory, { recursive: true, force: true });
  `;
  for (const drain of [true, false]) {
    const directory = spawnSync('node', ['--experimental-strip-types', '--input-type=module', '-e', script, String(drain), testDirectory], { encoding: 'utf8', timeout: 20_000 });
    assert.equal(directory.status, 0, directory.stderr || directory.stdout);
  }
});

test('close drain true persists all queued records; close blocks later work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-'));
  try {
    let next = 1;
    const monitor = createCacheMonitor({ enabled: true, directory, randomUUID: () => uuid(next++) });
    for (let i = 0; i < 20; i++) {
      const handle = monitor.beginInvocation({ localStreamId: uuid(9), invocationIndex: i, provider: 'other' });
      monitor.recordRequest(handle, { payload: { i } });
    }
    await monitor.close({ drain: true });
    const rows = await rowsIn(directory);
    assert.equal(rows.length, 20);
    assert.equal(monitor.beginInvocation({ localStreamId: uuid(9), invocationIndex: 21, provider: 'other' }), null);
    await monitor.close({ drain: false });
    assert.equal((await rowsIn(directory)).length, 20);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('startup rejects symlinked owned captures and leaves target intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-'));
  const target = join(directory, 'unrelated.txt');
  try {
    await writeFile(target, 'untouched');
    await symlink(target, join(directory, 'cache-monitor.jsonl'));
    const monitor = createCacheMonitor({ enabled: true, directory, randomUUID: () => uuid(1) });
    await monitor.close();
    assert.equal(await readFile(target, 'utf8'), 'untouched');
    assert.equal((await readdir(directory)).includes('cache-monitor.jsonl'), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('dedicated directory and capture modes are restrictive', async () => {
  const directory = join(await mkdtemp(join(tmpdir(), 'cache-monitor-')), 'capture');
  try {
    const monitor = createCacheMonitor({ enabled: true, directory, randomUUID: () => uuid(1) });
    const handle = monitor.beginInvocation({ localStreamId: uuid(9), invocationIndex: 0, provider: 'other' });
    monitor.recordRequest(handle, { payload: { safe: true } });
    await monitor.close();
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, 'cache-monitor.jsonl'))).mode & 0o777, 0o600);
  } finally { await rm(join(directory, '..'), { recursive: true, force: true }); }
});

test('disabled recorder creates no directory and allocates no handle', async () => {
  const directory = join(tmpdir(), `cache-monitor-${process.pid}-${Date.now()}`);
  const monitor = createCacheMonitor({ enabled: false, directory });
  assert.equal(monitor.localEpochId, null);
  assert.equal(monitor.beginInvocation({ localStreamId: uuid(1), invocationIndex: 0, provider: 'other' }), null);
  await monitor.close();
  await assert.rejects(stat(directory));
});

test('records exact bounded schema, domain-separated fingerprints and releases handles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-'));
  try {
    let next = 1;
    const monitor = createCacheMonitor({ enabled: true, directory, now: () => 1000, randomUUID: () => uuid(next++) });
    const handle = monitor.beginInvocation({ localStreamId: uuid(9), invocationIndex: 0, provider: 'openai', modelId: 'secret-model', configId: 'secret-config' });
    assert.ok(handle);
    monitor.recordRequest(handle, { payload: { z: 1, a: 'private prompt' } });
    monitor.recordResponse(handle, { usage: { input_tokens: 12, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: null } });
    assert.ok(monitor.beginInvocation({ localStreamId: uuid(9), invocationIndex: 1, provider: 'openai' }));
    await monitor.close();
    const rows = await rowsIn(directory);
    assert.equal(rows.length, 2);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['association','config_id_hash','event_type','fingerprints','incomplete','invocation_index','local_epoch_id','local_invocation_id','local_stream_id','model_id_hash','provider','schema_version','sequence','timestamp_ms','usage'].sort());
    assert.deepEqual(rows.map(row => row.sequence), [0, 1]);
    assert.equal(rows[0].event_type, 'request');
    assert.equal(rows[0].fingerprints.prompt.bytes, Buffer.byteLength('{"a":"private prompt","z":1}'));
    assert.match(rows[0].fingerprints.prompt.hmac_sha256, /^[0-9a-f]{64}$/);
    assert.equal(rows[1].fingerprints.prompt, null);
    assert.equal(rows[1].usage.cache_read_tokens, 0);
    const text = (await Promise.all((await readdir(directory)).map(name => readFile(join(directory, name), 'utf8')))).join('');
    assert.ok(!text.includes('private prompt') && !text.includes('secret-model') && !text.includes('secret-config'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid serialization and usage produce incomplete/null evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-'));
  try {
    const monitor = createCacheMonitor({ enabled: true, directory, randomUUID: () => uuid(1) });
    const handle = monitor.beginInvocation({ localStreamId: uuid(9), invocationIndex: 0, provider: 'other' });
    let getterCalled = false;
    const payload = Object.defineProperty({}, 'secret', { enumerable: true, get() { getterCalled = true; return 'x'; } });
    monitor.recordRequest(handle, { payload });
    monitor.recordResponse(handle, { usage: { input_tokens: -1, output_tokens: 1, cache_read_tokens: null, cache_write_tokens: null } });
    await monitor.close();
    const rows = await rowsIn(directory);
    assert.equal(getterCalled, false);
    assert.equal(rows[0].association, 'incomplete_fingerprint');
    assert.equal(rows[0].fingerprints.prompt, null);
    assert.equal(rows[1].usage, null);
    assert.equal(rows[1].incomplete, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('pending cap releases on unknown and response; null unknown uses sentinel', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-'));
  try {
    let next = 1;
    const monitor = createCacheMonitor({ enabled: true, directory, randomUUID: () => uuid(next++) });
    const handles = Array.from({ length: 64 }, (_, i) => monitor.beginInvocation({ localStreamId: uuid(100), invocationIndex: i, provider: 'other' }));
    assert.ok(handles.every(Boolean));
    assert.equal(monitor.beginInvocation({ localStreamId: uuid(100), invocationIndex: 64, provider: 'other' }), null);
    monitor.markUnknown(handles[0], 'unmatched');
    assert.ok(monitor.beginInvocation({ localStreamId: uuid(100), invocationIndex: 65, provider: 'other' }));
    monitor.markUnknown(null, 'unmatched');
    await monitor.close();
    const rows = await rowsIn(directory);
    const unknown = rows.find(row => row.event_type === 'unknown' && row.local_invocation_id === '00000000-0000-0000-0000-000000000000');
    assert.ok(unknown);
    assert.equal(unknown.local_stream_id, '00000000-0000-0000-0000-000000000000');
    assert.equal(unknown.local_epoch_id, monitor.localEpochId);
    assert.equal(unknown.fingerprints.prompt, null);
    assert.equal(rows.some(row => row.event_type === 'unknown' && row.association === 'unmatched'), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('canonicalization bounds key strings, depth, nodes, total size and rejects unsafe values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-'));
  try {
    const monitor = createCacheMonitor({ enabled: true, directory, randomUUID: () => uuid(1) });
    const payloads = [ { ['k'.repeat(64 * 1024 + 1)]: 1 }, (() => { let value = null; for (let i = 0; i < 33; i++) value = [value]; return value; })(), Array.from({ length: 10001 }, () => null), { a: 'x'.repeat(64 * 1024), b: 'x'.repeat(64 * 1024) }, { get secret() { throw new Error('getter must not run'); } }, Object.defineProperty({}, 'secret', { enumerable: true, get() { throw new Error('getter must not run'); } }), { ['__proto__']: 1 }, new Date(), [undefined], (() => { const x = {}; x.self = x; return x; })(), Object.defineProperty({}, Symbol('s'), { value: 1 }) ];
    for (let i = 0; i < payloads.length; i++) {
      const handle = monitor.beginInvocation({ localStreamId: uuid(9), invocationIndex: i, provider: 'other' });
      monitor.recordRequest(handle, { payload: payloads[i] });
    }
    await monitor.close();
    const rows = await rowsIn(directory);
    assert.equal(rows.length, payloads.length);
    assert.ok(rows.every(row => row.fingerprints.prompt === null && row.incomplete));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('usage requires exact own data-key schema and invalid input never invokes getters', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-'));
  try {
    const monitor = createCacheMonitor({ enabled: true, directory, randomUUID: () => uuid(1) });
    const invalid = [ {}, { input_tokens: 1 }, Object.assign(Object.create({}), { input_tokens: 1, output_tokens: 1, cache_read_tokens: null, cache_write_tokens: null }), Object.defineProperty({ output_tokens: 1, cache_read_tokens: null, cache_write_tokens: null }, 'input_tokens', { enumerable: true, get() { throw new Error('getter must not run'); } }) ];
    for (let i = 0; i < invalid.length; i++) {
      const handle = monitor.beginInvocation({ localStreamId: uuid(9), invocationIndex: i, provider: 'other' });
      monitor.recordResponse(handle, { usage: invalid[i] });
    }
    await monitor.close();
    const rows = await rowsIn(directory);
    assert.equal(rows.length, invalid.length);
    assert.ok(rows.every(row => row.usage === null && row.incomplete));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('canonical sorting, HMAC domain and epoch separation', async () => {
  const dirs = await Promise.all([mkdtemp(join(tmpdir(), 'cache-monitor-')), mkdtemp(join(tmpdir(), 'cache-monitor-'))]);
  try {
    let next = 1;
    const firstMonitor = createCacheMonitor({ enabled: true, directory: dirs[0], randomUUID: () => uuid(next++) });
    for (const payload of [{ z: 1, a: 2 }, { a: 2, z: 1 }]) {
      const handle = firstMonitor.beginInvocation({ localStreamId: uuid(9), invocationIndex: next, provider: 'other', modelId: 'same' });
      firstMonitor.recordRequest(handle, { payload });
    }
    await firstMonitor.close();
    const [a, sorted] = await rowsIn(dirs[0]);
    next = 11;
    const secondMonitor = createCacheMonitor({ enabled: true, directory: dirs[1], randomUUID: () => uuid(next++) });
    const handle = secondMonitor.beginInvocation({ localStreamId: uuid(9), invocationIndex: 0, provider: 'other', modelId: 'same' });
    secondMonitor.recordRequest(handle, { payload: { z: 1, a: 2 } });
    await secondMonitor.close();
    const [b] = await rowsIn(dirs[1]);
    assert.equal(a.fingerprints.prompt.hmac_sha256, sorted.fingerprints.prompt.hmac_sha256);
    assert.notEqual(a.model_id_hash, a.fingerprints.prompt.hmac_sha256);
    assert.notEqual(a.local_epoch_id, b.local_epoch_id);
    assert.notEqual(a.fingerprints.prompt.hmac_sha256, b.fingerprints.prompt.hmac_sha256);
  } finally { await Promise.all(dirs.map(directory => rm(directory, { recursive: true, force: true }))); }
});

test('throwing UUID source fails open for invocation allocation', async () => {
  let calls = 0;
  const monitor = createCacheMonitor({ enabled: true, directory: '/unused', randomUUID: () => { if (++calls > 1) throw new Error('rng failed'); return uuid(1); } });
  assert.doesNotThrow(() => assert.equal(monitor.beginInvocation({ localStreamId: uuid(9), invocationIndex: 0, provider: 'other' }), null));
  await monitor.close();
});

test('arrays reject non-index own properties and accessors without invoking getters', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-'));
  try {
    let getterCalled = false;
    const withDataExtra = [1]; Object.defineProperty(withDataExtra, 'extra', { value: 2 });
    const withGetterExtra = [1]; Object.defineProperty(withGetterExtra, 'extra', { get() { getterCalled = true; return 2; } });
    const monitor = createCacheMonitor({ enabled: true, directory, randomUUID: () => uuid(1) });
    for (const [i, payload] of [withDataExtra, withGetterExtra].entries()) {
      const handle = monitor.beginInvocation({ localStreamId: uuid(9), invocationIndex: i, provider: 'other' });
      monitor.recordRequest(handle, { payload });
    }
    await monitor.close();
    const rows = await rowsIn(directory);
    assert.equal(getterCalled, false);
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.fingerprints.prompt === null && row.incomplete));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('canonical total limit counts array punctuation and rejects boundary overflow', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-'));
  try {
    const monitor = createCacheMonitor({ enabled: true, directory, randomUUID: () => uuid(1) });
    const payload = Array(3).fill('x'.repeat(43688));
    const handle = monitor.beginInvocation({ localStreamId: uuid(9), invocationIndex: 0, provider: 'other' });
    monitor.recordRequest(handle, { payload });
    await monitor.close();
    const [row] = await rowsIn(directory);
    assert.equal(Buffer.byteLength(JSON.stringify(payload)), 131074);
    assert.equal(row.fingerprints.prompt, null);
    assert.equal(row.incomplete, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('multiple null-handle unknown sentinels persist and round-trip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-'));
  try {
    const monitor = createCacheMonitor({ enabled: true, directory, randomUUID: () => uuid(1) });
    for (let i = 0; i < 3; i++) monitor.markUnknown(null, 'unmatched');
    await monitor.close();
    const rows = await rowsIn(directory);
    assert.equal(rows.length, 3);
    assert.ok(rows.every(row => row.local_invocation_id === '00000000-0000-0000-0000-000000000000' && row.local_stream_id === '00000000-0000-0000-0000-000000000000'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('startup rejects mixed and event-incompatible persisted sentinel IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-'));
  try {
    const base = { schema_version: 1, local_epoch_id: uuid(1), sequence: 0, timestamp_ms: 1, local_invocation_id: '00000000-0000-0000-0000-000000000000', local_stream_id: '00000000-0000-0000-0000-000000000000', invocation_index: 0, provider: 'other', model_id_hash: null, config_id_hash: null, event_type: 'unknown', association: 'unmatched', fingerprints: { prompt: null }, usage: null, incomplete: false };
    const invalid = [
      { ...base, local_stream_id: uuid(2) },
      { ...base, event_type: 'request' },
      { ...base, event_type: 'response', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 } },
      { ...base, event_type: 'unknown', association: 'paired' },
      { ...base, event_type: 'response', local_invocation_id: uuid(3), local_stream_id: uuid(2), fingerprints: { prompt: { hmac_sha256: 'a'.repeat(64), bytes: 131073, complete: true } } },
    ];
    for (const [i, record] of invalid.entries()) {
      const path = join(directory, 'cache-monitor.jsonl');
      const content = `${JSON.stringify(record)}\n`;
      await writeFile(path, content);
      const monitor = createCacheMonitor({ enabled: true, directory, randomUUID: () => uuid(10) });
      await monitor.close();
      const current = await readFile(path, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      assert.ok(current === null || current.startsWith(content), `fixture ${i} has no added records`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('oversized canonical payload is rejected whole', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-monitor-'));
  try {
    const monitor = createCacheMonitor({ enabled: true, directory, randomUUID: () => uuid(1) });
    const handle = monitor.beginInvocation({ localStreamId: uuid(9), invocationIndex: 0, provider: 'other' });
    monitor.recordRequest(handle, { payload: 'x'.repeat(128 * 1024) });
    await monitor.close();
    const [row] = await rowsIn(directory);
    assert.equal(row.fingerprints.prompt, null);
    assert.equal(row.incomplete, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
