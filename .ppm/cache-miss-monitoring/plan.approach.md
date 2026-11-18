## Current state

- Baseline HEAD: `26afab1ba66677ca8ed62f03bc7263a098622a53`.
- At adjustment: package and lock pin SDK 1.5.0; installed version 1.5.0. Historical phase_0 (3/3) remains frozen; phase_1 baseline 0/4. No execution authorized here.
- SDK response headers are never logged. Local invocation/epoch/stream IDs are not SDK IDs; ambiguous retries remain unknown. SDK 1.5.0 source proves per-session injection: `dist/core/sdk.js:75` reads `options.modelRuntime`, `:271` calls `modelRuntime.streamSimple`; `dist/core/agent-session-services.js:133` uses `options.services.modelRuntime`. TASK-004 uses a per-session Proxy intercepting only `streamSimple`; no shared mutation.
- Audit found recorder TypeScript errors TS2339 at line 97, missing deadline cleanup, ignored `drain:false`, and insecure/unbounded filesystem reads. Analyzer audit found zero-ID sentinel rejection, sequence gaps spanning epochs, nonnull hashes not required, and missing comparison suppression for gaps, incomplete data, and conflicting metadata. Add regression coverage for each before fixes.
- Prior tests: recorder 3 and analyzer 5 pass. Current `tsc` fails two TS2339 errors. `npm run lint` timed out after 300s on existing `.next-old-20261026-130819` generated chunks. No implementation/dependency changes in this plan revision.

## Design

- Keep phase_0 artifacts and evidence frozen. `schema.md` and `sdk-evidence.md` are historical reference only, not active phase_1 specifications. Approved `implementation-contract.md` alone governs phase_1 conflicts, superseding old schema/API, chunk framing and SDK/operator gates. No SDK gate remains open; no SDK synchronization or implementation is part of this adjustment.
- Split recorder follow-up into TASK-003 (recorder fingerprint/API/typecheck) and TASK-008 (bounded secure filesystem, retention, shutdown), with 008 after 003.
- Split analyzer follow-up into TASK-005 (secure validation/read bounds) and TASK-009 (comparison semantics and regression coverage), with 009 after 005.
- Keep TASK-004 integration after TASK-008. Keep TASK-006 final verification after TASK-003, TASK-004, TASK-005, TASK-008, and TASK-009.
- Preserve failed task statuses and progress as audit history; no execution or status changes during this adjustment.

## Phases

### phase_0: Frozen evidence and schema

Historical completed evidence/schema phase; 3/3 completed. Frozen, not modified.

### phase_1: Bounded implementation and verification

Recorder and analyzer correction lanes run independently: TASK-003 and TASK-005. Their bounded filesystem/shutdown and comparison follow-ups run in parallel after their respective prerequisites: TASK-008 after TASK-003; TASK-009 after TASK-005. TASK-004 integrates after TASK-008. TASK-006 closes after TASK-003, TASK-004, TASK-005, TASK-008, and TASK-009 with focused checks and scope review.
