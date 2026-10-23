"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { sendAgentCommand } from "@/lib/agent-client";
import { shortenPath } from "@/lib/display-path";
import type { SystemPromptTarget } from "@/lib/system-prompt-file";
import { FileEditor } from "./FileEditor";
import {
  ConfigButton,
  ConfigFooter,
  ConfigNotice,
  ConfigPanelShell,
  ConfigScopeTag,
} from "./SettingsUi";

interface TargetState {
  path: string;
  exists: boolean;
  content: string;
  revision: string;
  size: number;
  tooLarge: boolean;
  blocked: "symlink" | "directory" | "special" | null;
  projectFile: { path: string; active: boolean } | null;
}

interface Loaded {
  agentDir: string;
  targets: Record<SystemPromptTarget, TargetState>;
}

type Load =
  | { state: "loading" }
  | { state: "ready"; data: Loaded }
  | { state: "error"; message: string };

interface Props {
  embedded?: boolean;
  /** Only used to report the project's `.pi/SYSTEM.md`, which outranks the global file. */
  cwd: string | null;
  sessionId: string | null;
  onClose: () => void;
  onSessionReloaded: () => void;
}

const fileSizeFormatter = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`);

// The ids the route accepts, listed here rather than imported: its module reads
// the filesystem, which a client bundle must not pull in.
const TARGETS: readonly SystemPromptTarget[] = ["system", "append"];

const BLOCKED_KEYS = {
  symlink: "systemPrompt.blockedSymlink",
  directory: "systemPrompt.blockedDirectory",
  special: "systemPrompt.blockedSpecial",
} as const;

/**
 * Settings › System prompt. pi reads `SYSTEM.md` (replacing the whole default
 * prompt) and `APPEND_SYSTEM.md` (adding to it) from the agent directory at
 * session start, so a save is followed by `reload` on the open chat.
 */
export function SystemPromptConfig({ embedded = false, cwd, sessionId, onClose, onSessionReloaded }: Props) {
  const { t } = useI18n();
  const [target, setTarget] = useState<SystemPromptTarget>("system");
  const [load, setLoad] = useState<Load>({ state: "loading" });
  // Per target, so switching files keeps what was typed in the other one. A
  // target with no entry here shows the file as it was last read or written.
  const [drafts, setDrafts] = useState<Partial<Record<SystemPromptTarget, string>>>({});
  const [saving, setSaving] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const readFile = useCallback(async (signal?: AbortSignal) => {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    const response = await fetch(`/api/system-prompt${query}`, { signal });
    const body = (await response.json().catch(() => ({}))) as {
      agentDir?: string;
      targets?: Array<TargetState & { target: SystemPromptTarget }>;
      error?: string;
    };
    if (!response.ok || body.error || !body.targets || !body.agentDir) {
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }
    const targets = Object.fromEntries(body.targets.map(({ target: id, ...state }) => [id, state])) as Record<
      SystemPromptTarget,
      TargetState
    >;
    return { agentDir: body.agentDir, targets } satisfies Loaded;
  }, [cwd]);

  useEffect(() => {
    const controller = new AbortController();
    void readFile(controller.signal)
      .then((data) => setLoad({ state: "ready", data }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({ state: "error", message: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => controller.abort();
  }, [readFile]);

  const data = load.state === "ready" ? load.data : null;
  const file = data?.targets[target];
  const value = drafts[target] ?? file?.content ?? "";
  const dirty = drafts[target] !== undefined && drafts[target] !== file?.content;
  const editable = !!file && !file.tooLarge && !file.blocked;
  const descriptionId = "system-prompt-target-note";
  const name = target === "system" ? "SYSTEM.md" : "APPEND_SYSTEM.md";

  const fail = (cause: unknown, fallback: string) => {
    setError(cause instanceof Error && cause.message ? cause.message : fallback);
  };

  /** The running chat holds the prompt it started with; `reload` is what picks the file up. */
  const reloadOpenSession = async () => {
    if (!sessionId) return;
    try {
      await sendAgentCommand(sessionId, { type: "reload" });
      onSessionReloaded();
    } catch (cause) {
      setNotice(t("systemPrompt.savedNotApplied", {
        reason: cause instanceof Error ? cause.message : String(cause),
      }));
    }
  };

  const save = async () => {
    if (!data || !file || !editable || saving || !dirty) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    setResetArmed(false);
    try {
      const response = await fetch("/api/system-prompt", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, content: value, baseRevision: file.revision }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        content?: string;
        revision?: string;
        exists?: boolean;
        size?: number;
        error?: string;
      };
      if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
      const saved = {
        ...file,
        content: body.content ?? value,
        revision: body.revision ?? "",
        exists: body.exists ?? true,
        size: body.size ?? file.size,
      };
      setLoad({ state: "ready", data: { ...data, targets: { ...data.targets, [target]: saved } } });
      setDrafts((current) => ({ ...current, [target]: undefined }));
      setNotice(t("systemPrompt.saved"));
      await reloadOpenSession();
    } catch (cause) {
      fail(cause, t("i18n.saveFailed"));
      // A conflicted save leaves this buffer stale: re-read, so the next Save
      // carries the revision that is now on disk.
      if (cause instanceof Error && /changed on disk/i.test(cause.message)) {
        void readFile().then((fresh) => setLoad({ state: "ready", data: fresh })).catch(() => {});
      }
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!data) return;
    if (!resetArmed) {
      setResetArmed(true);
      setNotice(t("systemPrompt.resetConfirm"));
      return;
    }
    setResetArmed(false);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/system-prompt?target=${target}`, { method: "DELETE" });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
      const cleared: TargetState = { ...data.targets[target], exists: false, content: "", revision: "", size: 0 };
      setLoad({ state: "ready", data: { ...data, targets: { ...data.targets, [target]: cleared } } });
      setDrafts((current) => ({ ...current, [target]: undefined }));
      setNotice(t("systemPrompt.resetDone"));
      await reloadOpenSession();
    } catch (cause) {
      fail(cause, t("systemPrompt.resetFailed"));
    }
  };

  const targetNote = target === "system" ? t("systemPrompt.replaceNotice") : t("systemPrompt.appendNotice");

  return (
    <ConfigPanelShell embedded={embedded} title={t("settings.systemPrompt")} onClose={onClose}>
      <div className="system-prompt-body">
        <div className="system-prompt-head">
          <div className="system-prompt-targets" role="group" aria-label={t("settings.systemPrompt")}>
            {TARGETS.map((id) => (
              <button
                key={id}
                type="button"
                className="system-prompt-target"
                aria-pressed={target === id}
                aria-describedby={descriptionId}
                onClick={() => {
                  setTarget(id);
                  setResetArmed(false);
                  setError(null);
                  setNotice(null);
                }}
              >
                {id === "system" ? "SYSTEM.md" : "APPEND_SYSTEM.md"}
              </button>
            ))}
          </div>
          {file && (
            <span className="system-prompt-file">
              <ConfigScopeTag scope="global">{t("systemPrompt.globalScope")}</ConfigScopeTag>
              <code className="system-prompt-path" title={file.path}>{shortenPath(file.path)}</code>
              <span className="system-prompt-size">
                {file.exists ? fileSizeFormatter(file.size) : t("systemPrompt.missing")}
              </span>
            </span>
          )}
        </div>

        <ConfigNotice id={descriptionId}>{targetNote}</ConfigNotice>

        {file?.projectFile?.active && (
          <ConfigNotice>
            {t("systemPrompt.projectOverride", { path: shortenPath(file.projectFile.path) })}
          </ConfigNotice>
        )}
        {file?.blocked && <ConfigNotice>{t(BLOCKED_KEYS[file.blocked])}</ConfigNotice>}
        {file?.tooLarge && <ConfigNotice>{t("systemPrompt.tooLarge", { size: fileSizeFormatter(file.size) })}</ConfigNotice>}
        {load.state === "error" && <ConfigNotice>{t("systemPrompt.loadFailed", { reason: load.message })}</ConfigNotice>}

        <div className="system-prompt-editor">
          {data && editable ? (
            <FileEditor
              value={value}
              language="markdown"
              wrapLines
              readOnly={saving}
              onChange={(next) => {
                setDrafts((current) => ({ ...current, [target]: next }));
                setResetArmed(false);
                // Clearing the file (a reset) replaces the document too, and that
                // echo must not wipe the message that says what happened.
                if (next !== file.content) setNotice(null);
              }}
              onSave={() => void save()}
            />
          ) : (
            <div className="system-prompt-placeholder">
              {load.state === "loading" ? t("i18n.loading") : t("systemPrompt.unavailable", { name })}
            </div>
          )}
        </div>

        {notice && <p className="system-prompt-message" role="status">{notice}</p>}
        {error && <p className="system-prompt-error" role="alert">{error}</p>}

        <ConfigFooter
          status={
            <span className="system-prompt-status">
              {saving ? t("i18n.saving") : dirty ? t("i18n.unsavedChanges") : null}
            </span>
          }
        >
          <ConfigButton
            variant="danger"
            onClick={() => void reset()}
            disabled={!file?.exists || saving}
          >
            {resetArmed ? t("systemPrompt.resetConfirmAction", { name }) : t("systemPrompt.reset")}
          </ConfigButton>
          <ConfigButton
            variant="primary"
            onClick={() => void save()}
            disabled={!editable || !dirty || saving}
          >
            {saving ? t("i18n.saving") : t("i18n.save")}
          </ConfigButton>
        </ConfigFooter>
      </div>
    </ConfigPanelShell>
  );
}
