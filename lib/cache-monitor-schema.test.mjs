import test from 'node:test';
import assert from 'node:assert/strict';
import { ZERO_ID, isValidPersistedRecord, isValidUsage, parseCapture, validatePersistedRecord } from './cache-monitor-schema.ts';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = 'a'.repeat(64);

function record() {
  return {
    schema_version: 1,
    local_epoch_id: uuid(1),
    local_invocation_id: uuid(2),
    local_stream_id: uuid(9),
    sequence: 0,
    invocation_index: 0,
    timestamp_ms: 1000,
    provider: 'other',
    model_id_hash: null,
    config_id_hash: null,
    event_type: 'request',
    association: 'paired',
    fingerprints: { prompt: { hmac_sha256: digest, bytes: 10, complete: true } },
    usage: null,
    incomplete: false,
  };
}

function sentinelRecord() {
  return { ...record(), local_invocation_id: ZERO_ID, local_stream_id: ZERO_ID, event_type: 'unknown', association: 'unmatched', fingerprints: { prompt: null } };
}

test('accepts the exact persisted record and rejects extra or missing top-level keys', () => {
  const exact = record();
  assert.deepEqual(validatePersistedRecord(exact, 1000), exact);
  assert.equal(isValidPersistedRecord({ ...exact, extra: 1 }, 1000), false);
  for (const key of Object.keys(exact)) {
    const missing = { ...exact };
    delete missing[key];
    assert.equal(isValidPersistedRecord(missing, 1000), false, `missing ${key}`);
  }
  assert.throws(() => validatePersistedRecord({ ...exact, extra: 1 }, 1000), /invalid capture record/);
  assert.equal(isValidPersistedRecord([], 1000), false);
  assert.equal(isValidPersistedRecord(null, 1000), false);
});

test('rejects invalid identities, enums, sequences and timestamps against the supplied clock', () => {
  const invalid = [
    ['schema_version', 2],
    ['local_epoch_id', 'not-a-uuid'],
    ['local_epoch_id', ZERO_ID],
    ['local_invocation_id', 'not-a-uuid'],
    ['sequence', -1],
    ['sequence', 1.5],
    ['invocation_index', -1],
    ['timestamp_ms', -1],
    ['timestamp_ms', 1001],
    ['timestamp_ms', 1.5],
    ['provider', 'azure'],
    ['event_type', 'payload'],
    ['association', 'paired_response'],
    ['model_id_hash', 'A'.repeat(64)],
    ['config_id_hash', 'a'.repeat(63)],
    ['incomplete', 'false'],
  ];
  for (const [key, value] of invalid) {
    assert.equal(isValidPersistedRecord({ ...record(), [key]: value }, 1000), false, `${key}=${String(value)}`);
  }
  assert.equal(isValidPersistedRecord(record(), 1000), true, 'timestamp_ms === now is accepted');
  assert.equal(isValidPersistedRecord({ ...record(), model_id_hash: digest, config_id_hash: digest }, 1000), true);
});

test('requires sentinel ids only on unknown records and never on paired events', () => {
  assert.equal(isValidPersistedRecord(sentinelRecord(), 1000), true);
  const invalid = [
    { ...sentinelRecord(), local_stream_id: uuid(2) },
    { ...sentinelRecord(), local_invocation_id: uuid(2) },
    { ...sentinelRecord(), event_type: 'request', fingerprints: { prompt: { hmac_sha256: digest, bytes: 0, complete: true } } },
    { ...sentinelRecord(), event_type: 'response', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 } },
    { ...sentinelRecord(), association: 'paired' },
    { ...sentinelRecord(), fingerprints: { prompt: { hmac_sha256: digest, bytes: 0, complete: true } } },
  ];
  for (const [index, candidate] of invalid.entries()) {
    assert.equal(isValidPersistedRecord(candidate, 1000), false, `sentinel fixture ${index}`);
  }
});

test('bounds prompt fingerprints exactly and requires complete lowercase digests', () => {
  const withPrompt = prompt => ({ ...record(), fingerprints: { prompt } });
  assert.equal(isValidPersistedRecord(withPrompt({ hmac_sha256: digest, bytes: 0, complete: true }), 1000), true);
  assert.equal(isValidPersistedRecord(withPrompt({ hmac_sha256: digest, bytes: 131072, complete: true }), 1000), true);
  const invalid = [
    { hmac_sha256: digest, bytes: 131073, complete: true },
    { hmac_sha256: digest, bytes: -1, complete: true },
    { hmac_sha256: digest, bytes: 0.5, complete: true },
    { hmac_sha256: digest, bytes: 0, complete: false },
    { hmac_sha256: 'A'.repeat(64), bytes: 0, complete: true },
    { hmac_sha256: 'a'.repeat(63), bytes: 0, complete: true },
    { hmac_sha256: digest, bytes: 0, complete: true, extra: 1 },
    { hmac_sha256: digest, bytes: 0 },
  ];
  for (const [index, prompt] of invalid.entries()) {
    assert.equal(isValidPersistedRecord(withPrompt(prompt), 1000), false, `fingerprint fixture ${index}`);
  }
  assert.equal(isValidPersistedRecord({ ...record(), fingerprints: {} }, 1000), false);
  assert.equal(isValidPersistedRecord({ ...record(), fingerprints: { prompt: null, other: null } }, 1000), false);
  assert.equal(isValidPersistedRecord({ ...record(), fingerprints: null }, 1000), false);
});

test('keeps fingerprints off response/unknown events and accepts only explicit incomplete/gap requests', () => {
  const base = record();
  assert.equal(isValidPersistedRecord({ ...base, event_type: 'response', association: 'paired' }, 1000), false);
  assert.equal(isValidPersistedRecord({ ...base, event_type: 'unknown', association: 'unmatched' }, 1000), false);
  assert.equal(isValidPersistedRecord({ ...base, event_type: 'unknown', association: 'paired', fingerprints: { prompt: null } }, 1000), false);
  assert.equal(isValidPersistedRecord({ ...base, event_type: 'request', association: 'paired', fingerprints: { prompt: null } }, 1000), false);
  assert.equal(isValidPersistedRecord({ ...base, association: 'incomplete_fingerprint', fingerprints: { prompt: null }, incomplete: true }, 1000), true);
  assert.equal(isValidPersistedRecord({ ...base, association: 'telemetry_gap', fingerprints: { prompt: null }, incomplete: true }, 1000), true);
  assert.equal(isValidPersistedRecord({ ...base, event_type: 'response', fingerprints: { prompt: null }, usage: { input_tokens: 1, output_tokens: null, cache_read_tokens: 0, cache_write_tokens: 2 } }, 1000), true);
});

test('validates usage as null or an exact bounded four-token object', () => {
  const response = { ...record(), event_type: 'response', fingerprints: { prompt: null } };
  assert.equal(isValidUsage(null), true);
  assert.equal(isValidUsage({ input_tokens: 0, output_tokens: 2147483647, cache_read_tokens: null, cache_write_tokens: 1 }), true);
  assert.equal(isValidPersistedRecord({ ...response, usage: null }, 1000), true);
  const invalid = [
    {},
    { input_tokens: 1 },
    { input_tokens: 1, output_tokens: 1, cache_read_tokens: 1, cache_write_tokens: 1, extra: 1 },
    { input_tokens: -1, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null },
    { input_tokens: 2147483648, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null },
    { input_tokens: 1.5, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null },
    { input_tokens: '1', output_tokens: null, cache_read_tokens: null, cache_write_tokens: null },
  ];
  for (const [index, usage] of invalid.entries()) {
    assert.equal(isValidUsage(usage), false, `usage fixture ${index}`);
    assert.equal(isValidPersistedRecord({ ...response, usage }, 1000), false, `record usage fixture ${index}`);
  }
});

test('parses only newline-terminated, bounded, schema-valid JSONL captures', () => {
  const base = record();
  assert.deepEqual(parseCapture('', 1000), []);
  assert.deepEqual(parseCapture(`${JSON.stringify(base)}\n`, 1000), [base]);
  const twoLines = `${JSON.stringify({ ...base, sequence: 0 })}\n${JSON.stringify({ ...base, sequence: 1 })}\n`;
  assert.deepEqual(parseCapture(twoLines, 1000).map(item => item.sequence), [0, 1]);
  assert.throws(() => parseCapture(JSON.stringify(base), 1000), /newline terminated/);
  assert.throws(() => parseCapture('{"invalid":true}\n', 1000), /invalid capture record/);
  assert.throws(() => parseCapture(`${'x'.repeat(16 * 1024)}\n`, 1000), /oversized capture record/);
  assert.throws(() => parseCapture(`${JSON.stringify(base)}\n\n`, 1000), /not JSON/);
  assert.throws(() => parseCapture(`${JSON.stringify(base)}\n`, 999), /timestamp_ms/);
  assert.throws(() => parseCapture(`${JSON.stringify({ ...base, extra: 1 })}\n`, 1000), /top-level keys/);
});
