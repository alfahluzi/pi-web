"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { SystemPromptInfo } from "@/lib/api-types";
import { SelectorRow } from "./SelectorRow";

/**
 * The composer's system-prompt picker, right of the model picker. It lists the
 * library of the `pi-system-prompt-manager` extension and sets the one this
 * session uses: a pick sends `/sysprompt <name>` to the session (the extension's
 * own command, so it also updates its footer status), and the Off row sends
 * `/sysprompt off`. The row set and the current name come from
 * `GET /api/system-prompts`; pi-web never writes the extension's files.
 *
 * Like the model picker, the menu is `position: fixed` against the button's
 * measured rectangle: the composer's rounded box clips absolutely positioned
 * children, and the button sits at the left edge, so the menu opens left-aligned
 * with the button and flips above/below by the space available.
 */
export interface SystemPromptSelectorProps {
  prompts: SystemPromptInfo[];
  /** The name this session has active, enabled or not. */
  active: string | null;
  /** False when the active prompt is set but switched off. */
  enabled: boolean;
  onChange: (name: string | null) => void;
  busy?: boolean;
  /**
   * The session already exists, so its prompt is settled: `<pi-system-prompt-manager>`
   * applies the choice at the next `before_agent_start`, and this picker is for
   * starting a chat, not for changing one mid-conversation.
   */
  locked?: boolean;
  /** Show the active prompt's name beside the icon; phones keep the icon only. */
  showLabel?: boolean;
}

export function SystemPromptSelector({ prompts, active, enabled, onChange, busy = false, locked = false, showLabel = true }: SystemPromptSelectorProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<{ top: number; right: number; bottom: number; left: number; width: number } | null>(null);

  const currentName = enabled && active ? active : t("chat.systemPromptOff");
  const disabled = busy || locked;

  useEffect(() => {
    if (!open) return;
    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [open]);

  useEffect(() => {
    if (!disabled) return;
    setOpen(false);
  }, [disabled]);

  const choose = (name: string | null) => {
    setOpen(false);
    if (name === (enabled ? active : null)) return;
    onChange(name);
  };

  return (
    <div ref={rootRef} style={{ position: "relative", minWidth: 0, flexShrink: 0 }}>
      <button
        type="button"
        title={locked
          ? t("chat.systemPromptNewSessionOnly", { name: currentName })
          : busy
            ? t("chat.systemPromptSwitching")
            : t("chat.systemPromptChange", { name: currentName })}
        aria-label={locked
          ? t("chat.systemPromptNewSessionOnlyLabel", { name: currentName })
          : t("chat.systemPromptChangeLabel")}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-busy={busy || undefined}
        // Locked is not `disabled`: a disabled button keeps no focus and shows no
        // title, so a keyboard user would never hear why it cannot be used.
        aria-disabled={locked || undefined}
        disabled={busy}
        onClick={(event) => {
          if (disabled) return;
          const rect = event.currentTarget.getBoundingClientRect();
          setAnchorRect({ top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width });
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !open) return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          maxWidth: isMobile ? (showLabel ? 150 : 32) : 170,
          height: 32,
          padding: isMobile ? (showLabel ? "0 8px" : 0) : "8px 12px",
          width: isMobile && !showLabel ? 32 : undefined,
          overflow: "hidden",
          background: open ? "var(--bg-hover)" : "none",
          border: "none",
          borderRadius: 9,
          color: enabled && active ? "var(--text-muted)" : "var(--text-dim)",
          cursor: disabled ? "not-allowed" : "pointer",
          fontSize: 12,
          opacity: busy ? 0.5 : locked ? 0.55 : 1,
          transition: "background 0.12s, color 0.12s",
        }}
        onMouseEnter={(event) => {
          if (disabled) return;
          event.currentTarget.style.background = "var(--bg-hover)";
          event.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(event) => {
          if (disabled) return;
          event.currentTarget.style.background = open ? "var(--bg-hover)" : "none";
          event.currentTarget.style.color = enabled && active ? "var(--text-muted)" : "var(--text-dim)";
        }}
      >
        {busy ? (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" style={{ animation: "spin 0.8s linear infinite", flexShrink: 0 }} aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          </svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <path d="M4 4h9l5 5v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
            <polyline points="13 4 13 9 18 9" />
            <line x1="7" y1="13" x2="13" y2="13" />
            <line x1="7" y1="17" x2="11" y2="17" />
          </svg>
        )}
        {showLabel && (
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentName}</span>
        )}
      </button>

      {open && anchorRect && (() => {
        const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
        const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
        const spaceAbove = anchorRect.top - 8;
        const spaceBelow = viewportHeight - anchorRect.bottom - 8;
        const openAbove = spaceAbove > spaceBelow;
        const maxHeight = Math.max(120, Math.min(openAbove ? spaceAbove : spaceBelow, viewportHeight * 0.6));
        const verticalPosition = openAbove
          ? { bottom: viewportHeight - anchorRect.top + 6 }
          : { top: anchorRect.bottom + 6 };
        const horizontalPosition: CSSProperties = isMobile
          ? { left: 8, right: 8, maxWidth: "calc(100vw - 16px)" }
          : { left: Math.max(8, anchorRect.left), width: "max-content", minWidth: 240, maxWidth: Math.max(240, viewportWidth - anchorRect.left - 8) };

        return (
          <div
            ref={panelRef}
            role="listbox"
            aria-label={t("chat.systemPrompt")}
            style={{
              position: "fixed",
              ...verticalPosition,
              ...horizontalPosition,
              zIndex: 500,
              display: "flex",
              flexDirection: "column",
              maxHeight,
              overflow: "hidden",
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--bg)",
              boxShadow: openAbove ? "0 -4px 16px rgba(0,0,0,0.10)" : "0 4px 16px rgba(0,0,0,0.10)",
            }}
          >
            <div style={{
              flexShrink: 0,
              padding: "6px 12px",
              borderBottom: "1px solid var(--border)",
              color: "var(--text-dim)",
              fontSize: 10,
              fontWeight: 600,
              textTransform: "uppercase",
            }}>
              {t("chat.systemPrompt")}
            </div>
            <div style={{ minHeight: 0, overflowY: "auto" }}>
              {prompts.map((prompt) => (
                <SelectorRow
                  key={prompt.name}
                  active={Boolean(enabled) && prompt.name === active}
                  onSelect={() => choose(prompt.name)}
                >
                  <span title={prompt.description ?? prompt.name} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {prompt.name}
                    {prompt.models && prompt.models.length > 0 && (
                      <span style={{ marginLeft: 6, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                        {prompt.models.join(", ")}
                      </span>
                    )}
                  </span>
                  <span style={{ flexShrink: 0, marginLeft: 10, fontSize: 11, color: "var(--text-dim)" }}>
                    {prompt.description ?? prompt.mode}
                  </span>
                </SelectorRow>
              ))}
            </div>
            <div style={{ borderTop: "1px solid var(--border)" }}>
              <SelectorRow active={!enabled || !active} onSelect={() => choose(null)}>
                <span style={{ flex: 1 }}>{t("chat.systemPromptOff")}</span>
                <span style={{ flexShrink: 0, marginLeft: 10, fontSize: 11, color: "var(--text-dim)" }}>
                  {t("chat.systemPromptOffHint")}
                </span>
              </SelectorRow>
            </div>
            <div style={{
              flexShrink: 0,
              padding: "6px 12px",
              borderTop: "1px solid var(--border)",
              color: "var(--text-dim)",
              fontSize: 10,
            }}>
              {t("chat.systemPromptFooter")}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
