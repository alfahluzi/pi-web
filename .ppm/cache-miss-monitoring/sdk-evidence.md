# TASK-001 — SDK evidence and integration boundary

Baseline: `26afab1ba66677ca8ed62f03bc7263a098622a53`.

## Independently checked versions

- `package.json:54`: exact dependency pin `@earendil-works/pi-coding-agent: 1.5.0`.
- `package-lock.json:1119-1122`: `node_modules/@earendil-works/pi-coding-agent` lock entry version `1.5.0` and its resolved tarball.
- `node_modules/@earendil-works/pi-coding-agent/package.json:3`: installed package reports version `1.2.0`. Read-only runtime check: `node -p "require('./node_modules/@earendil-works/pi-coding-agent/package.json').version"` → `1.2.0`.

Versions mismatch. Inspected SDK therefore cannot establish pinned 1.5.0 behavior. Runtime gate remains OPEN. Operator must separately authorize and schedule synchronization to already-pinned 1.5.0. This task cannot authorize, perform, or close that prerequisite. No install, update, restart, or target 1.2.0 is authorized or assumed.

## Checked declarations and limits

- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`, `ProviderConfig.streamSimple`: says custom providers invoke `options.onPayload` before sending and `options.onResponse` after receiving response/before consuming body; optional `onProviderStreamEvent(data, model)` is adapter-owned.
- `node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`, “Subscribing to events”: documents `session.subscribe()` events and their session/run lifecycle; it does not establish provider request-to-response IDs or retries mapping.
- `docs/agents/sessions.md`, `startRpcSession()` lifecycle: identifies pi-web's wrapper boundary, not a provider stream-entry hook.

Installed declarations and docs describe only installed 1.2.0. They do not prove that callback response status/headers contain usage or request IDs; none are claimed here. `onResponse({status, headers})` alone is not usage or request-ID evidence. Headers must not be logged. Exact 1.5.0 callback types/source and any request/response association remain unverified.

## Integration boundary

No verified real stream-entry wrapper is established by checked sources for the planned pi-web integration. Provider integration is BLOCKED. No request-level correlation, IDs, or inferred retry/attempt associations are available. Payload-only/uncorrelated behavior is also unavailable pending target-version evidence and authorization; do not fabricate identifiers or infer association from time/order. `lib/rpc-manager.ts` is only a candidate application boundary, not evidence of provider stream association.

This SDK evidence is separate from schema ownership; TASK-002 owns schema. Existing task IDs and statuses remain unchanged.

## Verification record

Read-only inspection only. Compared `package.json`, `package-lock.json`, and installed package metadata. No dependency or source changes made. Project docs checked: `AGENTS.md`, `docs/agents/sessions.md`; installed SDK docs checked: `node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`.
