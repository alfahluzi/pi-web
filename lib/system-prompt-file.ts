import { lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "./atomic-file";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";
import { fileRevision, validateFileEditInput } from "./file-edit";
import { readRegularFileText } from "./regular-file";

/**
 * Settings › System prompt edits the two files pi reads as its prompt from the
 * agent directory: `SYSTEM.md` replaces the whole default prompt, and
 * `APPEND_SYSTEM.md` adds text to it (`docs/configuration.md` in the SDK).
 *
 * The route resolves them from `getAgentDir()`, so a client never names a path:
 * `PI_CODING_AGENT_DIR` moves both files with the rest of the agent directory.
 */
export const SYSTEM_PROMPT_TARGETS = ["system", "append"] as const;
export type SystemPromptTarget = (typeof SYSTEM_PROMPT_TARGETS)[number];

const FILE_NAMES: Record<SystemPromptTarget, string> = {
  system: "SYSTEM.md",
  append: "APPEND_SYSTEM.md",
};

/** A new file pi reads; the agent directory itself is excluded from the file browser, not from the server. */
const NEW_FILE_MODE = 0o644;

export function isSystemPromptTarget(value: unknown): value is SystemPromptTarget {
  return typeof value === "string" && (SYSTEM_PROMPT_TARGETS as readonly string[]).includes(value);
}

export function systemPromptFileName(target: SystemPromptTarget): string {
  return FILE_NAMES[target];
}

export function systemPromptPath(agentDir: string, target: SystemPromptTarget): string {
  return join(agentDir, FILE_NAMES[target]);
}

/** What `lstat` says about the entry, which decides whether it may be written at all. */
export type SystemPromptEntryState = "missing" | "file" | "symlink" | "directory" | "special";

export function systemPromptEntryState(info: {
  isFile: boolean;
  isSymbolicLink: boolean;
  isDirectory: boolean;
}): SystemPromptEntryState {
  if (info.isSymbolicLink) return "symlink";
  if (info.isFile) return "file";
  if (info.isDirectory) return "directory";
  return "special";
}

/**
 * A file that does not exist yet answers with an empty revision, so the write
 * that finds one there is a conflict rather than a silent overwrite of
 * whatever created it.
 */
export function statSystemPromptEntry(path: string): {
  state: SystemPromptEntryState;
  mode: number;
  size: number;
  revision: string;
} {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "missing", mode: NEW_FILE_MODE, size: 0, revision: "" };
    }
    throw error;
  }
  const state = systemPromptEntryState({
    isFile: info.isFile(),
    isSymbolicLink: info.isSymbolicLink(),
    isDirectory: info.isDirectory(),
  });
  const revision = fileRevision({ mtimeMs: info.mtimeMs, size: info.size, ino: info.ino });
  return { state, mode: info.mode & 0o777, size: info.size, revision };
}

export interface SystemPromptFileRead {
  path: string;
  exists: boolean;
  /** Empty when the entry is not a regular file, or larger than the read cap. */
  content: string;
  revision: string;
  size: number;
  tooLarge: boolean;
  /** Set when the path holds something other than a regular file, so the panel can say what it found. */
  blocked: Exclude<SystemPromptEntryState, "missing" | "file"> | null;
}

export function readSystemPromptFile(agentDir: string, target: SystemPromptTarget): SystemPromptFileRead {
  const path = systemPromptPath(agentDir, target);
  const stat = statSystemPromptEntry(path);
  if (stat.state === "missing") {
    return { path, exists: false, content: "", revision: "", size: 0, tooLarge: false, blocked: null };
  }
  if (stat.state !== "file") {
    return { path, exists: true, content: "", revision: stat.revision, size: stat.size, tooLarge: false, blocked: stat.state };
  }
  if (stat.size > TEXT_PREVIEW_MAX_BYTES) {
    return { path, exists: true, content: "", revision: stat.revision, size: stat.size, tooLarge: true, blocked: null };
  }
  return {
    path,
    exists: true,
    content: readRegularFileText(path, TEXT_PREVIEW_MAX_BYTES) ?? "",
    revision: stat.revision,
    size: stat.size,
    tooLarge: false,
    blocked: null,
  };
}

export interface SystemPromptWrite {
  ok: true;
  content: string;
  revision: string;
  exists: boolean;
}

export interface SystemPromptRefusal {
  ok: false;
  status: number;
  error: string;
}

const BLOCKED_MESSAGES: Record<Exclude<SystemPromptEntryState, "missing" | "file">, string> = {
  symlink: "The file is a symbolic link; edit its target instead",
  directory: "The path is a directory",
  special: "The path is not a regular file",
};

/** Writes the file atomically, keeping an existing file's mode bits. */
export function writeSystemPromptFile(
  agentDir: string,
  target: SystemPromptTarget,
  content: string,
): SystemPromptWrite | SystemPromptRefusal {
  const path = systemPromptPath(agentDir, target);
  const before = statSystemPromptEntry(path);
  if (before.state !== "missing" && before.state !== "file") {
    return { ok: false, status: 403, error: BLOCKED_MESSAGES[before.state] };
  }
  mkdirSync(agentDir, { recursive: true });
  writeFileAtomicSync(path, content, before.mode);
  const after = statSystemPromptEntry(path);
  return { ok: true, content, revision: after.revision, exists: after.state === "file" };
}

/**
 * A save as the route receives it: `baseRevision` is the revision the panel
 * read, so a file the agent or another tab changed meanwhile answers 409
 * instead of being overwritten, exactly as `/api/files` does.
 */
export function applySystemPromptWrite(
  agentDir: string,
  target: SystemPromptTarget,
  body: unknown,
): SystemPromptWrite | SystemPromptRefusal {
  const current = statSystemPromptEntry(systemPromptPath(agentDir, target));
  const checked = validateFileEditInput(body, { size: current.size, revision: current.revision });
  if (!checked.ok) return { ok: false, status: checked.status, error: checked.error };
  return writeSystemPromptFile(agentDir, target, checked.content);
}

/**
 * Deletes the file, which is how pi falls back to its default prompt: an empty
 * `SYSTEM.md` also reads as "no override", but removing it says so plainly.
 */
export function deleteSystemPromptFile(
  agentDir: string,
  target: SystemPromptTarget,
): { ok: true; exists: false } | SystemPromptRefusal {
  const path = systemPromptPath(agentDir, target);
  const before = statSystemPromptEntry(path);
  if (before.state === "missing") return { ok: true, exists: false };
  if (before.state !== "file") {
    return { ok: false, status: 403, error: BLOCKED_MESSAGES[before.state] };
  }
  unlinkSync(path);
  return { ok: true, exists: false };
}
