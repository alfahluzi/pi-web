## Objective

Opt-in local diagnostics for deterministic fingerprints of strict-JSON observed effective prompt objects and associated usage; assistant/result content is never fingerprinted. Fingerprints are not wire bytes or provider payload guarantees. Approved amendment permits implementation using installed SDK 1.5.0. Exact shared API, serializer, identity semantics, and integration recipe live in `implementation-contract.md`.

## Scope

- In: bounded fail-open local recorder, offline analyzer, per-session stream integration, and fake-only verification.
- Out: raw prompt/tool/result persistence, provider-cause claims, dependency/network/build/service changes, and live/paid calls.

## Sources

- Repo-root documents: `../../AGENTS.md`, `../../docs/agents/sessions.md`.
- Package metadata and lock: `../../package.json`, `../../package-lock.json`.
- Shared implementation contract: `implementation-contract.md`.
- Historical frozen schema and SDK evidence: `schema.md`, `sdk-evidence.md`. Historical reference only, not phase_1 instructions. Their SDK/operator gate, chunk framing and event/API schema are superseded; `implementation-contract.md` alone governs phase_1 conflicts. Do not reopen cleared SDK gate or modify frozen artifacts.

## Done when

- Approved phase_1 implementation uses installed SDK 1.5.0. Completion requires bounded recorder/analyzer, per-session stream wrapper with unchanged outputs/errors, fake-only checks, privacy limits, no raw persistence, and no dependency/network/service changes.
- Focused tests, `node_modules/.bin/tsc --noEmit`, targeted installed ESLint, and Git scope review (including untracked files) complete and findings recorded.
