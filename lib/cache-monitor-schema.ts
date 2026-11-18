// Persisted-record schema for the cache monitor. This module is pure: it must not
// touch the filesystem, the clock, or crypto so it can be tested in isolation.

export type ProviderEnum = 'openai' | 'anthropic' | 'google' | 'other';
export type Usage = { input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null };
export type PromptFingerprint = { hmac_sha256: string; bytes: number; complete: boolean };
export type EventType = 'request' | 'response' | 'unknown';
export type Association = 'paired' | 'unmatched' | 'retry_ambiguous' | 'telemetry_gap' | 'context_reset' | 'incomplete_fingerprint';
export type PersistedRecord = Readonly<{
  schema_version: 1;
  local_epoch_id: string;
  local_invocation_id: string;
  local_stream_id: string;
  sequence: number;
  invocation_index: number;
  timestamp_ms: number;
  provider: ProviderEnum;
  model_id_hash: string | null;
  config_id_hash: string | null;
  event_type: EventType;
  association: Association;
  fingerprints: Readonly<{ prompt: PromptFingerprint | null }>;
  usage: Usage | null;
  incomplete: boolean;
}>;

export const SCHEMA_VERSION = 1;
// Reserved all-zero UUID marker for unknown events without a live local handle.
export const ZERO_ID = '00000000-0000-0000-0000-000000000000';
export const MAX_RECORD_BYTES = 16 * 1024;
export const MAX_FINGERPRINT_BYTES = 128 * 1024;
export const MAX_USAGE_TOKENS = 2_147_483_647;
export const PROVIDERS: readonly ProviderEnum[] = ['openai', 'anthropic', 'google', 'other'];
export const EVENT_TYPES: readonly EventType[] = ['request', 'response', 'unknown'];
export const ASSOCIATIONS: readonly Association[] = [
  'paired',
  'unmatched',
  'retry_ambiguous',
  'telemetry_gap',
  'context_reset',
  'incomplete_fingerprint',
];

const PROVIDER_SET: ReadonlySet<string> = new Set(PROVIDERS);
const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);
const ASSOCIATION_SET: ReadonlySet<string> = new Set(ASSOCIATIONS);
const RECORD_KEYS = [
  'association',
  'config_id_hash',
  'event_type',
  'fingerprints',
  'incomplete',
  'invocation_index',
  'local_epoch_id',
  'local_invocation_id',
  'local_stream_id',
  'model_id_hash',
  'provider',
  'schema_version',
  'sequence',
  'timestamp_ms',
  'usage',
];
const FINGERPRINT_KEYS = ['bytes', 'complete', 'hmac_sha256'];
const PROMPT_KEYS = ['prompt'];
const USAGE_KEYS = ['cache_read_tokens', 'cache_write_tokens', 'input_tokens', 'output_tokens'];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

function fail(detail: string): never {
  throw new Error(`invalid capture record: ${detail}`);
}

export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && value !== ZERO_ID && UUID_V4.test(value);
}

export function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isBoundedToken(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_USAGE_TOKENS);
}

export function isValidUsage(value: unknown): value is Usage | null {
  if (value === null) return true;
  if (!isPlainObject(value) || !hasExactKeys(value, USAGE_KEYS)) return false;
  return USAGE_KEYS.every(key => isBoundedToken(value[key]));
}

export function isValidPromptFingerprint(value: unknown): value is PromptFingerprint {
  if (!isPlainObject(value) || !hasExactKeys(value, FINGERPRINT_KEYS)) return false;
  const bytes = value.bytes;
  return isHash(value.hmac_sha256) && typeof bytes === 'number' && Number.isInteger(bytes) && bytes >= 0 && bytes <= MAX_FINGERPRINT_BYTES && value.complete === true;
}

export function isValidFingerprints(value: unknown): value is { prompt: PromptFingerprint | null } {
  if (!isPlainObject(value) || !hasExactKeys(value, PROMPT_KEYS)) return false;
  return value.prompt === null || isValidPromptFingerprint(value.prompt);
}

// Throws instead of returning a result so callers cannot accidentally persist an
// unvalidated record. `now` is supplied by the caller because the module is pure.
export function validatePersistedRecord(value: unknown, now: number): PersistedRecord {
  if (!isPlainObject(value) || !hasExactKeys(value, RECORD_KEYS)) fail('top-level keys');
  if (value.schema_version !== SCHEMA_VERSION) fail('schema_version');
  if (!isUuidV4(value.local_epoch_id)) fail('local_epoch_id');
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0) fail('sequence');
  if (!Number.isSafeInteger(value.timestamp_ms) || (value.timestamp_ms as number) < 0 || (value.timestamp_ms as number) > now) fail('timestamp_ms');
  if (!Number.isSafeInteger(value.invocation_index) || (value.invocation_index as number) < 0) fail('invocation_index');
  if (typeof value.provider !== 'string' || !PROVIDER_SET.has(value.provider)) fail('provider');
  if (!(value.model_id_hash === null || isHash(value.model_id_hash))) fail('model_id_hash');
  if (!(value.config_id_hash === null || isHash(value.config_id_hash))) fail('config_id_hash');
  if (typeof value.event_type !== 'string' || !EVENT_TYPE_SET.has(value.event_type)) fail('event_type');
  if (typeof value.association !== 'string' || !ASSOCIATION_SET.has(value.association)) fail('association');
  if (typeof value.incomplete !== 'boolean') fail('incomplete');

  const fingerprints = value.fingerprints;
  if (!isValidFingerprints(fingerprints)) fail('fingerprints');
  const usage = value.usage;
  if (!isValidUsage(usage)) fail('usage');
  const prompt = fingerprints.prompt;

  const sentinelInvocation = value.local_invocation_id === ZERO_ID;
  const sentinelStream = value.local_stream_id === ZERO_ID;
  if (sentinelInvocation !== sentinelStream) fail('mixed sentinel ids');
  if (sentinelInvocation) {
    if (value.event_type !== 'unknown' || value.association === 'paired' || usage !== null || prompt !== null) fail('sentinel record');
  } else if (!isUuidV4(value.local_invocation_id) || !isUuidV4(value.local_stream_id)) {
    fail('local ids');
  }

  if (value.event_type !== 'request' && prompt !== null) fail('non-request fingerprint');
  if (value.association === 'paired' && value.event_type === 'unknown') fail('paired unknown');
  // A request only loses its fingerprint via an explicit incomplete/gap association.
  if (value.event_type === 'request' && prompt === null && value.association !== 'incomplete_fingerprint' && value.association !== 'telemetry_gap') fail('request fingerprint association');

  return value as PersistedRecord;
}

export function isValidPersistedRecord(value: unknown, now: number): boolean {
  try {
    validatePersistedRecord(value, now);
    return true;
  } catch {
    return false;
  }
}

// An empty capture file is valid JSONL (it exists before its first append); any
// other content must be newline-terminated, bounded and schema-valid.
export function parseCapture(content: string, now: number): PersistedRecord[] {
  if (content === '') return [];
  if (!content.endsWith('\n')) fail('capture is not newline terminated');
  const records: PersistedRecord[] = [];
  for (const line of content.slice(0, -1).split('\n')) {
    if (Buffer.byteLength(line, 'utf8') + 1 > MAX_RECORD_BYTES) fail('oversized capture record');
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail('capture record is not JSON');
    }
    records.push(validatePersistedRecord(parsed, now));
  }
  return records;
}
