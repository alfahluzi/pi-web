# Cache Monitor Privacy and Offline Analysis Contract

## Status and gate

This document defines a standalone bounded contract; it does not establish SDK capabilities or prove event association. No capture or integration of any kind is available or authorized until TASK-001 records exact target-source evidence and the operator separately authorizes and completes runtime alignment to pinned SDK 1.5.0. No install, update, or restart is authorized by this contract. Only after that gate, any fields and matching must be limited to TASK-001 proof; if request/response association is unproven, a future authorized implementation may report payload-only or uncorrelated evidence as unknown. SDK `onResponse({status, headers})` supplies neither usage nor IDs; never persist its headers or infer IDs.

## Opt-in and privacy

Capture is enabled only when `PI_WEB_CACHE_MONITOR=1`; default is off. When off, create no capture directory, key, or record. Validate environment value exactly. Recorder is observational and fail-open: serialization, permission, queue, rotation, retention, and disk failures drop diagnostics and never change callback inputs/outputs, block requests, or fail generation. Do not log diagnostic payloads or errors containing sensitive values.

Persist only the allowlisted fields below. Never persist prompt text, tool calls/results, endpoint or URL, headers, filesystem paths, arbitrary model/config strings, or raw payload bytes. Hash arbitrary custom model/config identifiers before persistence. Reject unknown keys and invalid values. Missing means unknown, never zero. Do not treat status or headers as usage, identity, or evidence of cache behavior.

## Record schema (JSONL)

Each line is one JSON object. Reject unknown fields and invalid types/ranges. Required fields: `schema_version`, `provider`, `event_type`, `seq`, `timestamp_ms`, `outcome`, `incomplete`, and `fingerprints`. Optional fields: `epoch_id`, `request_id`, `attempt_id`, `session_id`, `model_id_hash`, `config_id_hash`, `cache_read`, `cache_write`, `input_tokens`, `output_tokens`. Omitted optional values are unknown, never zero. Fields:

| Field | Requirement; type and bound | Meaning |
|---|---|---|
| `schema_version` | required; integer, exactly `1` | Record format version. |
| `epoch_id`, `request_id`, `attempt_id`, `session_id` | optional; string, 1–64 ASCII `[A-Za-z0-9_-]` | Pseudonymous IDs only if exact source proves they exist and the relevant association; otherwise omit. Never fabricate. |
| `provider` | required; `openai`, `anthropic`, `google`, `other` | Fixed enum; no provider-specific free text. |
| `event_type` | required; `request`, `response`, `reset` | Fixed enum; no unlisted event kinds. |
| `seq` | required; integer, 0–2^31−1 | Local sequence where available; not identity or association evidence. |
| `timestamp_ms` | required; integer, 0–2^53−1 | Epoch milliseconds; never use timestamps/order alone to match. |
| `model_id_hash`, `config_id_hash` | optional; null or exactly 64 lowercase hexadecimal characters | Optional hashes only; arbitrary source strings are never persisted. |
| `cache_read`, `cache_write`, `input_tokens`, `output_tokens` | optional; null or integer, 0–2^31−1 | Include only when directly observed and proven; otherwise null/omitted. Never derive from response status/headers. |
| `outcome` | required; fixed enum below | Evidence classification, not provider-cause assertion. |
| `incomplete` | required; boolean | True if any bounded capture input was dropped/truncated. |
| `fingerprints` | required; array, at most 128 entries (empty when none) | Allowlisted category/chunk index/HMAC only, as defined below. |

Allowed `outcome` values: `observed_client_payload_delta`, `unchanged_observed_payload_low_cache`, `insufficient_evidence`, `telemetry_gap`, `context_reset`, `unmatched_response`, `retry_ambiguous`. Missing or ambiguous association, duplicate/retry without proven identity, missing observation hook, or epoch boundary must remain unknown using the corresponding gap/reset/unmatched/ambiguous label. Do not infer response association from timestamps or order.

Each fingerprint entry contains exactly `category`, `chunk_index`, and `hmac`. `category` is a fixed allowlist: `system`, `messages`, `tools`, `other`; `chunk_index` is integer 0–31; `hmac` is exactly 64 lowercase hexadecimal characters. Categories describe observed client payload regions only, not provider token boundaries. Maximum 32 chunks per category, each representing at most 4 KiB of bytes; maximum aggregate fingerprint input 128 KiB per event. Byte chunks are not tokens, token prefixes, or provider-internal payload evidence. On any cap/overflow, drop affected chunks/records and set `incomplete=true`; never claim full equality or change from incomplete data.

## Fingerprinting and validation

Use HMAC-SHA-256 only; no unkeyed content hashes. Generate a fresh cryptographically random 32-byte key per capture epoch, keep it in memory only, and never persist or log it. Restart/reset starts a new epoch/key. Text fields use strict UTF-8 with no Unicode normalization; reject malformed UTF-8 and unpaired surrogates. Define `LP(x)` as the four-byte unsigned big-endian byte length of byte string `x`, then `x`; reject lengths above 2^32−1. Define `MAC(tag, fields...) = HMAC-SHA-256(epoch_key, LP(UTF8(tag)) || LP(field1_bytes) || ... )` in the listed order; hexadecimal output is lowercase. Encode textual fields as strict UTF-8, encode `chunk_index` as exactly four unsigned big-endian bytes, and use `chunk_bytes` unchanged as raw bytes. Length-prefix each byte string by its byte length; never UTF-8 encode binary fields.

Frozen domain tags and field order:

- Payload chunk: tag `pi-web-cache-monitor/payload-chunk/v1`; fields `category`, `chunk_index`, `chunk_bytes`. `chunk_bytes` are the exact raw bytes of one already bounded chunk. Category is exact ASCII enum text; chunk index is unsigned 32-bit big-endian bytes. Do not decode, normalize, parse, or reserialize payload chunk bytes.
- Model identifier: tag `pi-web-cache-monitor/model-id/v1`; fields `identifier_bytes`, the exact strict UTF-8 encoding of source identifier before discarding it. Persist only the 64-hex HMAC.
- Config identifier: tag `pi-web-cache-monitor/config-id/v1`; fields `identifier_bytes`, same exact encoding rule, separate domain from model identifiers.

No other HMAC use is defined. Canonical JSON is not used to fingerprint payload. Payload fingerprinting requires a source-proven, deterministic byte representation at the observation point; if source cannot supply exact bytes or identifies only an object without a defined serializer, reject fingerprinting and report unavailable/unknown rather than stringify it. Persist no raw bytes. Strict UTF-8 validation applies only to text fields; raw `chunk_bytes` are arbitrary bytes, may contain invalid UTF-8 or split a multibyte character, and must not be decoded or rejected for that reason. Reject invalid text-field UTF-8/values, unknown keys, malformed hashes, unsafe IDs, and all out-of-range numbers before writing. Do not use a persisted key to compare epochs.

## Resource and file bounds

- Async queue: at most 64 records and 1 MiB total.
- Record: at most 16 KiB serialized JSONL bytes.
- Active JSONL file: at most 1 MiB; rotate across at most 3 files.
- Capture retention: retention deadline is oldest record `timestamp_ms` plus seven days. Recorder must delete expired files, not merely rename/rotate them; rotation never resets expiry. Recorder and analyzer use the same injected/current UTC wall-clock millisecond source, never filesystem timestamps. Analyzer never deletes input files.
- Fingerprint bounds: at most 32 × 4 KiB chunks/category and 128 KiB total/event.
- CLI input: at most 16 files, 1 MiB/file, 4 MiB total, 16 KiB/line.
- CLI report: at most 2 MiB.

Overflow drops diagnostics and marks remaining affected evidence incomplete. Files/directories use mode `0600`/`0700`; permission or storage failure is fail-open and must not weaken privacy by falling back to broader permissions or another location. Rotation and retention must not exceed stated limits.

## Offline CLI contract

Exact invocation: `node scripts/analyze-cache-monitor.mjs <capture-dir>`. The argument is the user-specified directory; do not print or persist its path in report output. Read only bounded JSONL files from that directory. Validate every record against this schema and enforce all file, aggregate, line, record, and report limits before emitting a report. Malformed, unknown-field, invalid, or oversized input exits nonzero to stderr and emits no partial success report. Never echo malformed input or sensitive values in errors.

Output metadata and fingerprints only. Match events only through explicit association proven by exact target source and TASK-001 evidence; never match by timestamp/order. Distinguish correlated payload evidence from uncorrelated payload-only evidence. When any record has `incomplete=true`, report affected evidence with `incomplete_fingerprint`; never claim equality or full change from incomplete fingerprints. Record `outcome` and report labels are distinct classifications: preserve the record's allowed outcome, then derive the report label from evidence completeness and association. Allowed report labels: `observed_client_payload_delta`, `unchanged_observed_payload_low_cache_upstream_or_unobserved`, `insufficient_evidence`, `telemetry_gap`, `context_reset`, `unmatched_response`, `retry_ambiguous`, `incomplete_fingerprint`, and `uncorrelated_payload_only`. No label asserts provider-internal cause; unchanged observed payload with low cache telemetry can only indicate upstream behavior or unobserved causes, not establish either.

## Retention, deletion, and operator controls

Retention deadline is the oldest record `timestamp_ms` plus exactly 7×24×60×60×1000 milliseconds, using UTC wall-clock epoch milliseconds. For proactive deletion, files are retained while `now_ms < deadline` and scheduled for deletion at the deadline; at every cleanup, append, and analyzer validation, `now_ms >= deadline` means expired and the file must be deleted (recorder) or rejected (analyzer). On every enabled recorder startup, before accepting writes, inspect only the dedicated capture directory, parse and validate capture records, reject files with future record timestamps as unsafe (drop diagnostics; do not append to them), and delete expired regular capture files. Before every append or rotation, check expiry; rotation renames/starts a file but never resets its oldest timestamp or extends its deadline. Also schedule periodic expiry cleanup while recorder is running and idle, with each file's oldest-record deadline as a deletion deadline; no new service or process is required. Never retain any file beyond that deadline. Event-loop suspension, process pause, or wall-clock rollback can delay real-time cleanup; upon resume, re-check using current wall clock before any write, delete expired files, and drop diagnostics if checks fail. If clock access, reading timestamps, or cleanup fails, fail open for application behavior but drop diagnostics and do not append or extend retention; retry on the next scheduled check/append. Never use filesystem creation/modification time as a retention clock. When opt-in is off or process is stopped, cleanup cannot run; disclose that expired files are removed on next enabled startup, and users needing immediate deletion must manually delete the dedicated directory. Analyzer is strictly read-only and uses the same clock source and exact boundary: before output, reject malformed/non-regular inputs, files with future record timestamps, and any file where `now_ms >= oldest_timestamp_ms + 7×24×60×60×1000`, with nonzero exit and generic stderr; never delete, alter, or silently omit input. If clock access fails, analyzer exits nonzero without output. Users can stop capture by unsetting `PI_WEB_CACHE_MONITOR` or setting it to anything other than exact `1`. To delete all captured diagnostics immediately, stop the application, then delete the dedicated capture directory specified by the implementation/operator. Deletion also removes stored fingerprints; ephemeral HMAC keys are not on disk. Do not delete or scan arbitrary user directories. Rollback requires disabling the env opt-in, removing the dedicated capture directory, and (after separately authorized implementation) removing recorder integration.

## Implementation gate

No recorder, CLI, or provider integration implementation is authorized by this document. Keep implementation blocked until TASK-001 has recorded source-backed SDK evidence and association limits, and the operator prerequisite (separate authorization and completion of runtime alignment to pinned SDK 1.5.0) is resolved. If proof is absent, omit unsupported fields and keep results uncorrelated/unknown. No dependency changes, live/paid calls, network activity, build, or service restart.
