"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MarkdownBody } from "./MarkdownBody";
import { copyText } from "@/lib/clipboard";
import { parseSystemPrompt } from "@/lib/system-prompt-markdown";

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface Props {
  loading: boolean;
  prompt: string | null;
  translate: Translate;
}

interface ViewProps extends Props {
  expanded: boolean;
  copied: boolean;
  onCopy: () => void;
  onToggle: () => void;
}

/** How long the Copy button reads "Copied", matching the message actions. */
const COPY_FEEDBACK_MS = 1500;

export function SystemPromptPanel({ loading, prompt, translate }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimeoutRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (copiedTimeoutRef.current !== null) window.clearTimeout(copiedTimeoutRef.current);
  }, []);

  // Copy takes the raw prompt, not the segmented or escaped markdown.
  const handleCopy = () => {
    copyText(prompt ?? "").then(() => {
      setCopied(true);
      if (copiedTimeoutRef.current !== null) window.clearTimeout(copiedTimeoutRef.current);
      copiedTimeoutRef.current = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    });
  };

  return (
    <SystemPromptPanelView
      loading={loading}
      prompt={prompt}
      translate={translate}
      expanded={expanded}
      copied={copied}
      onCopy={handleCopy}
      onToggle={() => setExpanded((value) => !value)}
    />
  );
}

/** The panel for any load and expansion state, without the copy timer; exported for tests. */
export function SystemPromptPanelView({ loading, prompt, translate, expanded, copied, onCopy, onToggle }: ViewProps) {
  // Parsed here so the segment strings stay stable and each `MarkdownBody`
  // skips its parse when AppShell re-renders this panel.
  const segments = useMemo(() => (prompt ? parseSystemPrompt(prompt) : []), [prompt]);

  return (
    <section
      className={expanded ? "system-prompt-panel is-expanded" : "system-prompt-panel"}
      aria-label={translate("system.prompt")}
    >
      <div className="system-prompt-header">
        <span className="system-prompt-title">{translate("system.prompt")}</span>
        <div className="system-prompt-actions">
          <button type="button" className="system-prompt-button" onClick={onCopy} disabled={!prompt}>
            {copied ? translate("system.copied") : translate("system.copy")}
          </button>
          <button
            type="button"
            className="system-prompt-button"
            onClick={onToggle}
            aria-expanded={expanded}
            disabled={!prompt}
          >
            {expanded ? translate("system.collapse") : translate("system.expand")}
          </button>
        </div>
      </div>

      <div className="system-prompt-scroll">
        {prompt ? (
          segments.map((segment, index) =>
            segment.kind === "section" ? (
              <div
                key={index}
                className={segment.depth > 0 ? "system-prompt-section is-nested" : "system-prompt-section"}
                style={{ paddingLeft: Math.min(segment.depth, 3) * 12 }}
              >
                <div className="system-prompt-section-label">
                  <span className="system-prompt-section-name">{segment.label}</span>
                  {segment.attributes ? (
                    <span className="system-prompt-section-attributes">{segment.attributes}</span>
                  ) : null}
                </div>
              </div>
            ) : (
              <div
                key={index}
                className={segment.depth > 0 ? "system-prompt-segment is-nested" : "system-prompt-segment"}
                style={{ paddingLeft: Math.min(segment.depth, 3) * 12 }}
              >
                <MarkdownBody className="system-prompt-body" keepLineBreaks={segment.lineOriented}>
                  {segment.markdown}
                </MarkdownBody>
              </div>
            ),
          )
        ) : (
          <div className="system-prompt-empty">
            {prompt === ""
              ? translate("system.empty")
              : loading
                ? translate("system.loading")
                : translate("system.load")}
          </div>
        )}
      </div>

      <style>{`
        .system-prompt-panel {
          display: flex;
          height: min(600px, 75dvh);
          min-height: 220px;
          flex-direction: column;
          background: var(--bg-panel);
          border-bottom: 1px solid var(--border);
        }
        .system-prompt-panel.is-expanded {
          height: min(1200px, calc(100dvh - 160px));
        }
        .system-prompt-header {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 12px;
          border-bottom: 1px solid var(--border);
          flex: 0 0 auto;
        }
        .system-prompt-title {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 11px;
          font-weight: 600;
          color: var(--text);
        }
        .system-prompt-actions {
          display: flex;
          gap: 6px;
          flex: 0 0 auto;
        }
        .system-prompt-button {
          font: inherit;
          font-size: 11px;
          line-height: 1.5;
          padding: 2px 8px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: transparent;
          color: var(--text-muted);
          cursor: pointer;
        }
        .system-prompt-button:hover:not(:disabled) {
          background: var(--bg-hover);
          color: var(--text);
        }
        .system-prompt-button:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 1px;
        }
        .system-prompt-button:disabled {
          opacity: .45;
          cursor: default;
        }
        .system-prompt-button[aria-expanded="true"] {
          background: var(--bg-selected);
          color: var(--text);
        }
        .system-prompt-scroll {
          min-height: 0;
          flex: 1;
          overflow: auto;
          padding: 12px 16px;
        }
        .system-prompt-empty {
          padding: 10px 0;
          color: var(--text-muted);
          font-size: 12px;
          font-style: italic;
        }
        .system-prompt-section-label {
          display: flex;
          align-items: baseline;
          gap: 10px;
          margin: 16px 0 6px;
        }
        .system-prompt-section-label::after {
          content: "";
          flex: 1;
          height: 1px;
          background: var(--border);
          align-self: center;
        }
        .system-prompt-section-name {
          font-family: var(--font-mono);
          font-size: 10px;
          letter-spacing: .08em;
          text-transform: uppercase;
          white-space: nowrap;
          color: color-mix(in srgb, var(--accent) 62%, var(--text-muted));
        }
        .system-prompt-section-attributes {
          font-family: var(--font-mono);
          font-size: 10px;
          color: var(--text-dim);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 55%;
        }
        .system-prompt-section.is-nested,
        .system-prompt-segment.is-nested {
          border-left: 1px solid var(--border);
        }
        .system-prompt-section.is-nested .system-prompt-section-label {
          margin-top: 10px;
        }
        .system-prompt-section.is-nested .system-prompt-section-name {
          font-size: 9px;
          letter-spacing: .06em;
          color: var(--text-dim);
        }
        .system-prompt-panel .system-prompt-body {
          font-size: 12.5px;
          line-height: 1.62;
        }
      `}</style>
    </section>
  );
}
