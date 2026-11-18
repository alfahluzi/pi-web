## Risks

- Object serialization rejection/overflow yields incomplete telemetry, never request failure. Local IDs could be mistaken for SDK IDs; field naming and reports must identify them as Pi Web local. Retry ambiguity precludes provider-request comparisons.
- HMAC equality can reveal within-epoch linkage. Short-lived memory-only key, explicit opt-in, local restrictive files, retention and deletion instructions.
- Chunk boundaries are bytes, not provider tokens. Report incomplete/capped fingerprint evidence; avoid token-prefix claims.
- Gaps, incomplete records, and conflicting metadata can produce false comparisons. Suppress comparisons unless identity, hashes, epoch/stream, and sequence evidence meet contract; regression-test zero IDs and epoch-scoped gaps.
- Unsafe or unbounded filesystem reads risk local data exposure/resource exhaustion. Enforce bounded enumeration, no-follow/safe file handling, strict validation, and fail-open diagnostics.
- Missing cleanup or ignored `drain:false` risks retention violations and shutdown hangs/data leakage. Test deadline cleanup, queue discard, idempotent close, and no writes after close.
- Fail-open recorder risks dropped diagnostics; never block/fail generation. Type errors block verification until resolved.
- Rollback: turn off `PI_WEB_CACHE_MONITOR`, remove recorder integration, and delete dedicated capture directory. No schema/infra migration.

## Open questions

- None. User-approved fixes and split task boundaries are specified; no SDK gate remains open.
