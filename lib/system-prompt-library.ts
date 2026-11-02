import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SystemPromptInfo, SystemPromptsResponse } from "./api-types";

/**
 * Reads the prompt library and the per-session state of the
 * `pi-system-prompt-manager` extension
 * (git:github.com/tombystrican/pi-system-prompt-manager), so the composer can
 * offer its prompts next to the model picker.
 *
 * Only reads live here. A pick in the composer sends the extension's own
 * `/sysprompt <name>` command to the session, which keeps the extension the
 * single writer of both files: its footer status, its notify and the state it
 * applies at the next `before_agent_start` all move with it, exactly as in the
 * TUI. Writing the JSON ourselves would need a lock the extension does not take
 * and would leave its status stale.
 *
 * Library (`~/.pi/agent/system-prompts.json`):
 *   "<name>": { description?, text, mode?: "append"|"prepend"|"replace", models?: string[] }
 * State (`~/.pi/agent/system-prompt-state.json`), per session with a `default`
 * fallback, plus the pre-per-session flat shape:
 *   { default: { enabled, active }, sessions: { "<session id>": { enabled, active } } }
 *
 * A missing, unreadable or hand-broken file means "nothing to pick", never an
 * error: the extension's own `readJson` behaves the same way.
 */

export const SYSTEM_PROMPT_LIBRARY_FILE = "system-prompts.json";
export const SYSTEM_PROMPT_STATE_FILE = "system-prompt-state.json";

/** The ids pi writes: a UUID, or a wrapper's temporary key. Never a path. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

interface PromptEntry {
  description?: string;
  text: string;
  mode: "append" | "prepend" | "replace";
  models?: string[];
}

interface PromptState {
  enabled: boolean;
  active: string | null;
}

const OFF: PromptState = { enabled: false, active: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** The library in file order. Entries without usable text are left out: the extension applies nothing for them. */
export function readSystemPromptLibrary(agentDir: string): SystemPromptInfo[] {
  return Object.entries(readLibraryEntries(agentDir)).map(([name, entry]) => ({
    name,
    description: typeof entry.description === "string" && entry.description.trim() ? entry.description : null,
    mode: entry.mode === "replace" || entry.mode === "prepend" ? entry.mode : "append",
    models: Array.isArray(entry.models)
      ? entry.models.filter((model): model is string => typeof model === "string" && model.length > 0)
      : null,
  }));
}

/** The library with its text, as the extension reads it. */
function readLibraryEntries(agentDir: string): Record<string, PromptEntry> {
  const raw = readJsonFile(join(agentDir, SYSTEM_PROMPT_LIBRARY_FILE));
  if (!isRecord(raw)) return {};

  const entries: Record<string, PromptEntry> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!name.trim() || !isRecord(entry)) continue;
    if (typeof entry.text !== "string" || !entry.text.trim()) continue;
    entries[name] = {
      description: typeof entry.description === "string" ? entry.description : undefined,
      text: entry.text,
      mode: entry.mode === "replace" || entry.mode === "prepend" ? entry.mode : "append",
      models: Array.isArray(entry.models)
        ? entry.models.filter((model): model is string => typeof model === "string" && model.length > 0)
        : undefined,
    };
  }
  return entries;
}

function toPromptState(value: unknown): PromptState | null {
  if (!isRecord(value)) return null;
  return {
    enabled: value.enabled === true,
    active: typeof value.active === "string" && value.active ? value.active : null,
  };
}

/**
 * The state in effect for one session: its own entry, else the global
 * `default` (the pre-per-session flat file counts as that default). `scoped`
 * says the answer came from the session's own entry, so the composer can tell
 * a session's choice from the one new sessions inherit.
 */
export function resolveSystemPromptState(
  agentDir: string,
  sessionId: string | null,
): { state: PromptState; scoped: boolean } {
  const raw = readJsonFile(join(agentDir, SYSTEM_PROMPT_STATE_FILE));
  if (!isRecord(raw)) return { state: OFF, scoped: false };

  if (!isRecord(raw.sessions) && ("enabled" in raw || "active" in raw)) {
    return { state: toPromptState(raw) ?? OFF, scoped: false };
  }

  const sessions = isRecord(raw.sessions) ? raw.sessions : {};
  const key = sessionId && SESSION_ID_PATTERN.test(sessionId) ? sessionId : null;
  // Own properties only: `__proto__` passes the id pattern and would otherwise
  // answer with Object.prototype, reading as an empty session entry.
  const own = key && Object.hasOwn(sessions, key) ? toPromptState(sessions[key]) : null;
  if (own) return { state: own, scoped: true };
  return { state: (Object.hasOwn(raw, "default") ? toPromptState(raw.default) : null) ?? OFF, scoped: false };
}

export function buildSystemPromptsResponse(agentDir: string, sessionId: string | null): SystemPromptsResponse {
  const { state, scoped } = resolveSystemPromptState(agentDir, sessionId);
  return {
    prompts: readSystemPromptLibrary(agentDir),
    enabled: state.enabled,
    active: state.active,
    sessionScoped: scoped,
  };
}

/** The prompt a session runs with, the way the extension would apply it. */
export interface SelectedSystemPrompt {
  name: string;
  description: string | null;
  mode: "append" | "prepend" | "replace";
  text: string;
}

/**
 * The prompt this session runs with: its own choice, else the global default,
 * and only when the extension would apply it (enabled, and the name still in
 * the library). `null` means the session runs on pi's own prompt.
 */
export function readSelectedSystemPrompt(agentDir: string, sessionId: string | null): SelectedSystemPrompt | null {
  const { state } = resolveSystemPromptState(agentDir, sessionId);
  if (!state.enabled || !state.active) return null;
  const entry = readLibraryEntries(agentDir)[state.active];
  if (!entry) return null;
  return {
    name: state.active,
    description: entry.description?.trim() ? entry.description : null,
    mode: entry.mode,
    text: entry.text,
  };
}

/**
 * The prompt as the exported history shows it: which one it was, how it joins
 * pi's own prompt, and its text. The name comes first, so the export's
 * ten-line preview says which prompt the session ran with.
 */
export function formatSelectedSystemPrompt(prompt: SelectedSystemPrompt): string {
  const label = prompt.description ? `${prompt.name} — ${prompt.description}` : prompt.name;
  const mode = prompt.mode === "replace"
    ? "replace — it replaces pi's own system prompt"
    : prompt.mode === "prepend"
      ? "prepend — it is added before pi's own system prompt"
      : "append — it is added after pi's own system prompt";
  return `System prompt: ${label}\nMode: ${mode}\n\n${prompt.text}`;
}
