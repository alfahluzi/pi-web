// Pure pin-order helpers. Kept apart from the sidecar file access in
// `session-pins.ts` so the browser can share them: that module imports
// node:fs, which must never reach a client bundle.
const MAX_PINNED_SESSIONS = 200;

/** Pin order (newest first), duplicates and non-string ids dropped. */
export function normalizePinnedIds(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const ids = (raw as { ids?: unknown }).ids;
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
    if (normalized.length >= MAX_PINNED_SESSIONS) break;
  }
  return normalized;
}

/** Pinning puts the id first so the section keeps a stable newest-pin-first order. */
export function togglePinnedId(
  ids: readonly string[],
  sessionId: string,
  pinned: boolean,
): string[] {
  const rest = ids.filter((id) => id !== sessionId);
  return pinned ? [sessionId, ...rest] : rest;
}
