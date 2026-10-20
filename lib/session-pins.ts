// Pinned sessions are a pi-web preference, not part of pi's session format: the
// TUI writes and rewrites `.jsonl` files, and a custom transcript entry would
// have to be re-appended on every toggle. A sidecar list keyed by session id
// keeps that out of the file the other runtimes own.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { normalizePinnedIds } from "./session-pin-order";

const PINS_FILE_VERSION = 1;

export function getSessionPinsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web-pinned-sessions.json");
}

/**
 * A missing, malformed, or unreadable pins file means "nothing pinned": the
 * sidebar must still paint when this preference is broken.
 */
export function readPinnedSessionIds(pinsPath = getSessionPinsPath()): string[] {
  try {
    if (!existsSync(pinsPath)) return [];
    return normalizePinnedIds(JSON.parse(readFileSync(pinsPath, "utf8")) as unknown);
  } catch {
    return [];
  }
}

export function writePinnedSessionIds(
  ids: readonly string[],
  pinsPath = getSessionPinsPath(),
): string[] {
  const normalized = normalizePinnedIds({ ids });
  mkdirSync(dirname(pinsPath), { recursive: true });
  writePrivateFileAtomicSync(
    pinsPath,
    `${JSON.stringify({ version: PINS_FILE_VERSION, ids: normalized }, null, "\t")}\n`,
  );
  return normalized;
}
