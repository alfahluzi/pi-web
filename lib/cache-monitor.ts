import { createHmac, randomBytes, randomUUID } from 'node:crypto';
// @ts-expect-error TS5097: tsconfig omits allowImportingTsExtensions, but Node's --experimental-strip-types requires the explicit .ts extension.
import { MAX_RECORD_BYTES, PROVIDERS, ZERO_ID, isUuidV4 } from './cache-monitor-schema.ts';
import type { ProviderEnum, Usage } from './cache-monitor-schema.ts';
// @ts-expect-error TS5097: tsconfig omits allowImportingTsExtensions, but Node's --experimental-strip-types requires the explicit .ts extension.
import { appendCapture, expireCaptures } from './cache-monitor-storage.ts';

export type { ProviderEnum, Usage };

export type InvocationHandle = Readonly<{ localEpochId: string; localInvocationId: string; localStreamId: string; invocationIndex: number; provider: ProviderEnum; modelId: string | null; configId: string | null }>;
export interface CacheMonitor {
  readonly localEpochId: string | null;
  beginInvocation(input: { localStreamId: string; invocationIndex: number; provider: ProviderEnum; modelId?: string | null; configId?: string | null }): InvocationHandle | null;
  recordRequest(handle: InvocationHandle, input: { payload: unknown }): void;
  recordResponse(handle: InvocationHandle, input: { usage?: Usage | null }): void;
  markUnknown(handle: InvocationHandle | null, reason: 'unmatched' | 'retry_ambiguous' | 'telemetry_gap' | 'context_reset' | 'incomplete_fingerprint'): void;
  close(input?: { drain?: boolean }): Promise<void>;
}

const MAX_QUEUE = 64;
const MAX_PENDING = 64;
const MAX_QUEUE_BYTES = 1024 * 1024;
const reasons = { unmatched: 'unmatched', retry_ambiguous: 'retry_ambiguous', telemetry_gap: 'telemetry_gap', context_reset: 'context_reset', incomplete_fingerprint: 'incomplete_fingerprint' } as const;

function canonical(value: unknown): Buffer {
  let nodes = 0, total = 0;
  const seen = new Set<object>();
  function bounded(text: string, stringValue = false): string {
    const size = Buffer.byteLength(text, 'utf8');
    if ((stringValue && size > 64 * 1024) || total + size > 128 * 1024) throw new Error('invalid');
    total += size;
    return text;
  }
  function visit(item: unknown, depth: number): string {
    if (++nodes > 10_000 || depth > 32) throw new Error('invalid');
    if (item === null || typeof item === 'boolean') return bounded(JSON.stringify(item));
    if (typeof item === 'number' && Number.isFinite(item)) return bounded(JSON.stringify(item));
    if (typeof item === 'string') {
      if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item)) throw new Error('invalid');
      return bounded(JSON.stringify(item), true);
    }
    if (!item || typeof item !== 'object' || seen.has(item)) throw new Error('invalid');
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype || Object.getOwnPropertySymbols(item).length) throw new Error('invalid');
        const parts: string[] = [];
        bounded('[');
        for (let i = 0; i < item.length; i++) {
          if (i > 0) bounded(',');
          const d = Object.getOwnPropertyDescriptor(item, String(i));
          if (!d || !('value' in d)) throw new Error('invalid');
          parts.push(visit(d.value, depth + 1));
        }
        if (Object.getOwnPropertyNames(item).some(k => k !== 'length' && (!/^(0|[1-9]\d*)$/.test(k) || Number(k) >= item.length))) throw new Error('invalid');
        bounded(']');
        return `[${parts.join(',')}]`;
      }
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('invalid');
      if (Object.getOwnPropertySymbols(item).length) throw new Error('invalid');
      const keys = Object.keys(item).sort();
      const parts: string[] = [];
      bounded('{');
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (i > 0) bounded(',');
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('invalid');
        const d = Object.getOwnPropertyDescriptor(item, key);
        if (!d || !d.enumerable || !('value' in d)) throw new Error('invalid');
        const encodedKey = JSON.stringify(key);
        if (Buffer.byteLength(key, 'utf8') > 64 * 1024) throw new Error('invalid');
        parts.push(`${bounded(encodedKey, true)}${bounded(':')}${visit(d.value, depth + 1)}`);
      }
      bounded('}');
      return `{${parts.join(',')}}`;
    } finally { seen.delete(item); }
  }
  return Buffer.from(visit(value, 0), 'utf8');
}

function mac(key: Buffer, domain: 'prompt' | 'model' | 'config', data: Buffer): string {
  const tag = Buffer.from(`pi-web-cache-monitor:v1:${domain}`, 'ascii');
  const frame = Buffer.allocUnsafe(8 + tag.length + data.length);
  frame.writeUInt32BE(tag.length, 0); tag.copy(frame, 4); frame.writeUInt32BE(data.length, 4 + tag.length); data.copy(frame, 8 + tag.length);
  return createHmac('sha256', key).update(frame).digest('hex');
}

export function createCacheMonitor(options: { enabled: boolean; directory: string; now?: () => number; randomUUID?: () => string }): CacheMonitor {
  let epochId: string | null = null;
  let key: Buffer | null = null;
  let closed = false;
  let drainOnClose = true;
  let sequence = 0;
  let gap = false;
  const handles = new Map<InvocationHandle, { request: boolean }>();
  const queue: string[] = [];
  let queueBytes = 0;
  let writing: Promise<void> = Promise.resolve();
  let startup: Promise<void> = Promise.resolve();
  let retentionTimer: ReturnType<typeof setTimeout> | undefined;
  let periodicTimer: ReturnType<typeof setInterval> | undefined;
  let closedPromise: Promise<void> | undefined;
  const now = options.now ?? Date.now;
  const makeUuid = options.randomUUID ?? randomUUID;

  function enqueue(base: Record<string, unknown>, pendingOnDrop = false): void {
    if (closed || !epochId || !key) return;
    const stamp = now();
    if (!Number.isSafeInteger(stamp) || stamp < 0) { gap = true; return; }
    const record: Record<string, unknown> = { schema_version: 1, local_epoch_id: epochId, sequence: sequence++, timestamp_ms: stamp, ...base };
    if (gap) { record.association = 'telemetry_gap'; record.incomplete = true; gap = false; }
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > MAX_RECORD_BYTES || queue.length >= MAX_QUEUE || queueBytes + bytes > MAX_QUEUE_BYTES) {
      gap = true;
      if (pendingOnDrop) enqueue({ ...base, event_type: 'unknown', association: 'telemetry_gap', fingerprints: { prompt: null }, usage: null, incomplete: true });
      return;
    }
    queue.push(line);
    queueBytes += bytes;
    pump();
  }

  // Serialize queue drains and retention work on one chain so a scan or rotation
  // never races an append. One drain task empties the whole queue in order.
  function pump(): void {
    writing = writing.then(async () => {
      await startup;
      while (queue.length) {
        if (closed && !drainOnClose) { queue.length = 0; queueBytes = 0; return; }
        const line = queue.shift() as string;
        queueBytes -= Buffer.byteLength(line);
        try { await appendCapture(options.directory, line, now()); } catch { gap = true; }
      }
    }).catch(() => { gap = true; });
  }

  async function scheduleRetention(): Promise<void> {
    if (closed) return;
    if (retentionTimer) { clearTimeout(retentionTimer); retentionTimer = undefined; }
    try {
      const deadline = await expireCaptures(options.directory, now());
      if (closed) return;
      const delay = Math.max(1, Math.min(60 * 1000, deadline - now()));
      retentionTimer = setTimeout(runRetention, delay);
      retentionTimer.unref();
    } catch { gap = true; }
  }

  // Periodic plus deadline timer: bounded rechecks keep retention correct across
  // idle periods and clock jumps. Both timers are unref'd and cleared on close.
  function runRetention(): void {
    if (closed) return;
    writing = writing.then(scheduleRetention).catch(() => { gap = true; });
  }

  if (options.enabled) {
    try {
      const id = makeUuid();
      if (!isUuidV4(id)) throw new Error('invalid UUID');
      epochId = id; key = randomBytes(32);
      periodicTimer = setInterval(runRetention, 60 * 1000);
      periodicTimer.unref();
      startup = scheduleRetention().catch(() => { gap = true; });
    } catch { epochId = null; key = null; }
  }

  function base(handle: InvocationHandle, eventType: string, association: string, prompt: null | { hmac_sha256: string; bytes: number; complete: boolean }, usage: Usage | null, incomplete: boolean): Record<string, unknown> {
    if (!key) return {};
    const model = handle.modelId === null ? null : mac(key, 'model', Buffer.from(handle.modelId, 'utf8'));
    const config = handle.configId === null ? null : mac(key, 'config', Buffer.from(handle.configId, 'utf8'));
    return { local_invocation_id: handle.localInvocationId, local_stream_id: handle.localStreamId, invocation_index: handle.invocationIndex, provider: handle.provider, model_id_hash: model, config_id_hash: config, event_type: eventType, association, fingerprints: { prompt }, usage, incomplete };
  }
  const monitor: CacheMonitor = {
    get localEpochId() { return epochId; },
    beginInvocation(input) {
      if (!epochId || closed || handles.size >= MAX_PENDING || !isUuidV4(input.localStreamId) || !Number.isSafeInteger(input.invocationIndex) || input.invocationIndex < 0 || !PROVIDERS.includes(input.provider)) return null;
      const modelId = input.modelId ?? null, configId = input.configId ?? null;
      if ((modelId !== null && typeof modelId !== 'string') || (configId !== null && typeof configId !== 'string')) return null;
      let id: string;
      try { id = makeUuid(); } catch { return null; }
      if (!isUuidV4(id)) return null;
      const handle = Object.freeze({ localEpochId: epochId, localInvocationId: id, localStreamId: input.localStreamId, invocationIndex: input.invocationIndex, provider: input.provider, modelId, configId });
      handles.set(handle, { request: false }); return handle;
    },
    recordRequest(handle, input) {
      const state = handles.get(handle); if (!state || state.request || !key) return;
      state.request = true;
      let prompt = null, incomplete = false, association = 'paired';
      try { const bytes = canonical(input.payload); prompt = { hmac_sha256: mac(key, 'prompt', bytes), bytes: bytes.length, complete: true }; }
      catch { incomplete = true; association = 'incomplete_fingerprint'; }
      enqueue(base(handle, 'request', association, prompt, null, incomplete), true);
    },
    recordResponse(handle, input) {
      if (!handles.has(handle)) return;
      let usage: Usage | null = null, incomplete = false;
      if (input.usage !== undefined && input.usage !== null) {
        const candidate = input.usage as unknown;
        const keys = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'];
        if (candidate && typeof candidate === 'object' && Object.getPrototypeOf(candidate) === Object.prototype && Object.getOwnPropertySymbols(candidate).length === 0 && Object.keys(candidate).sort().join(',') === keys.slice().sort().join(',')) {
          const values: Record<string, unknown> = {};
          for (const k of keys) {
            const descriptor = Object.getOwnPropertyDescriptor(candidate, k);
            if (!descriptor?.enumerable || !('value' in descriptor)) { incomplete = true; break; }
            values[k] = descriptor.value;
          }
          if (!incomplete && Object.values(values).every(v => v === null || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 2147483647))) usage = values as Usage; else incomplete = true;
        } else incomplete = true;
      }
      enqueue(base(handle, 'response', 'paired', null, usage, incomplete)); handles.delete(handle);
    },
    markUnknown(handle, reason) {
      if (handle && !handles.has(handle)) return;
      if (handle) { enqueue(base(handle, 'unknown', reasons[reason] ?? 'unmatched', null, null, reason === 'incomplete_fingerprint')); handles.delete(handle); }
      else enqueue({ local_invocation_id: ZERO_ID, local_stream_id: ZERO_ID, invocation_index: 0, provider: 'other', model_id_hash: null, config_id_hash: null, event_type: 'unknown', association: reasons[reason], fingerprints: { prompt: null }, usage: null, incomplete: false });
    },
    async close(input = {}) {
      if (closedPromise) return closedPromise;
      closed = true;
      drainOnClose = input.drain !== false;
      if (!drainOnClose) { queue.length = 0; queueBytes = 0; }
      if (periodicTimer) clearInterval(periodicTimer);
      if (retentionTimer) clearTimeout(retentionTimer);
      periodicTimer = undefined; retentionTimer = undefined;
      handles.clear();
      closedPromise = (async () => { await startup; await writing; queue.length = 0; queueBytes = 0; if (key) key.fill(0); key = null; })();
      return closedPromise;
    },
  };
  return monitor;
}
