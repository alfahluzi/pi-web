import type { SessionFamily } from "./session-family";

/** Fixed row height; `SessionItem` renders at exactly this height. */
export const SESSION_ROW_HEIGHT = 54;
/** Compact section label above the pinned block. */
export const PINNED_SECTION_HEADER_HEIGHT = 28;

const VIRTUAL_OVERSCAN = 8;

export type SessionListRow =
  | { kind: "pinnedHeader"; key: "pinned-header" }
  | { kind: "family"; family: SessionFamily };

export function sessionListRowHeight(row: SessionListRow): number {
  return row.kind === "pinnedHeader" ? PINNED_SECTION_HEADER_HEIGHT : SESSION_ROW_HEIGHT;
}

/**
 * Pinned families first in pin order, then the rest in their existing
 * most-recent-activity order. Only family roots are pin targets: subagent rows
 * have no row of their own, so a pinned child id would strand the family.
 * `families` is already scoped to the active workspace, so a pin from another
 * project stays out of this list.
 */
export function buildSessionListRows(
  families: readonly SessionFamily[],
  pinnedIds: readonly string[],
): SessionListRow[] {
  const pinOrder = new Map<string, number>();
  pinnedIds.forEach((id, index) => {
    if (!pinOrder.has(id)) pinOrder.set(id, index);
  });

  const pinned: Array<{ family: SessionFamily; order: number }> = [];
  const rest: SessionFamily[] = [];
  for (const family of families) {
    const order = pinOrder.get(family.root.id);
    if (order === undefined) rest.push(family);
    else pinned.push({ family, order });
  }
  pinned.sort((a, b) => a.order - b.order);

  const rows: SessionListRow[] = [];
  if (pinned.length > 0) rows.push({ kind: "pinnedHeader", key: "pinned-header" });
  for (const entry of pinned) rows.push({ kind: "family", family: entry.family });
  for (const family of rest) rows.push({ kind: "family", family });
  return rows;
}

/** Prefix sums: `offsets[i]` is the top of row `i`, `offsets[length]` the total height. */
export function sessionListOffsets(heights: readonly number[]): number[] {
  const offsets = new Array<number>(heights.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < heights.length; index += 1) {
    offsets[index + 1] = offsets[index] + Math.max(0, heights[index]);
  }
  return offsets;
}

/** Index of the row containing `position` (clamped to the list range). */
function rowAtPosition(offsets: readonly number[], position: number): number {
  const last = offsets.length - 2;
  if (last < 0) return -1;
  let low = 0;
  let high = last;
  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    if (offsets[mid] <= position) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Rows to mount for a windowed list whose rows have different heights. Mirrors
 * the fixed-height `getSessionListIndices` in SessionSidebar: overscan above
 * and below, plus the focused row so an inline rename survives scrolling.
 */
export function getVirtualRowIndices(
  heights: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  focusedIndex = -1,
): number[] {
  const count = heights.length;
  if (count === 0) return [];
  const viewport = viewportHeight || 600;
  const offsets = sessionListOffsets(heights);
  const first = Math.max(0, Math.min(rowAtPosition(offsets, Math.max(0, scrollTop)), count - 1));
  const start = Math.max(0, first - VIRTUAL_OVERSCAN);

  let end = first;
  while (end < count && offsets[end] < scrollTop + viewport) end += 1;
  end = Math.min(count, end + VIRTUAL_OVERSCAN);

  const indices = Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset);
  if (focusedIndex >= 0 && focusedIndex < start) indices.unshift(focusedIndex);
  if (focusedIndex >= end && focusedIndex < count) indices.push(focusedIndex);
  return indices;
}
