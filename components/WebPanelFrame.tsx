"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

/**
 * Hosts one package-provided panel document in a sandboxed iframe and bridges a
 * tiny postMessage protocol to the app:
 *
 *   plugin -> pi-web
 *     { type: "pi-web:ready" }                  ask for the current context
 *     { type: "pi-web:open-file", path }        open a file in the right panel
 *     { type: "pi-web:insert-prompt", text }    append text to the chat composer
 *     { type: "pi-web:set-title", title }       rename the panel tab
 *
 *   pi-web -> plugin
 *     { type: "pi-web:context", cwd, sessionId, theme }
 *
 * Only same-origin messages from this frame's own content window are accepted.
 */

export interface WebPanelBridgeContext {
  cwd: string | null;
  sessionId: string | null;
  theme: string;
}

interface BridgeMessage {
  type?: unknown;
  path?: unknown;
  text?: unknown;
  title?: unknown;
}

interface Props {
  url: string;
  title: string;
  context: WebPanelBridgeContext;
  onOpenFile?: (path: string) => void;
  onInsertPrompt?: (text: string) => void;
  onTitleChange?: (title: string) => void;
}

function withContextQuery(url: string, context: WebPanelBridgeContext): string {
  const params = new URLSearchParams();
  if (context.cwd) params.set("cwd", context.cwd);
  if (context.sessionId) params.set("sessionId", context.sessionId);
  if (context.theme) params.set("theme", context.theme);
  const query = params.toString();
  if (!query) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${query}`;
}

export function WebPanelFrame({
  url,
  title,
  context,
  onOpenFile,
  onInsertPrompt,
  onTitleChange,
}: Props) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // The document is loaded once per tab: cwd/session changes are pushed over
  // postMessage instead of reloading the iframe, which would drop plugin state.
  const initialContextRef = useRef(context);
  const src = useMemo(() => withContextQuery(url, initialContextRef.current), [url]);

  const { cwd, sessionId, theme } = context;
  const postContext = useCallback(() => {
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ type: "pi-web:context", cwd, sessionId, theme }, window.location.origin);
  }, [cwd, sessionId, theme]);

  useEffect(() => {
    postContext();
  }, [postContext]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      if (event.origin !== window.location.origin) return;
      const data = event.data as BridgeMessage | null;
      if (!data || typeof data !== "object" || typeof data.type !== "string") return;

      switch (data.type) {
        case "pi-web:ready":
          postContext();
          break;
        case "pi-web:open-file":
          if (typeof data.path === "string" && data.path.trim()) onOpenFile?.(data.path.trim());
          break;
        case "pi-web:insert-prompt":
          if (typeof data.text === "string" && data.text) onInsertPrompt?.(data.text);
          break;
        case "pi-web:set-title":
          if (typeof data.title === "string" && data.title.trim()) {
            onTitleChange?.(data.title.trim().slice(0, 120));
          }
          break;
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [postContext, onOpenFile, onInsertPrompt, onTitleChange]);

  return (
    <iframe
      ref={frameRef}
      title={title}
      src={src}
      onLoad={postContext}
      // `allow-same-origin` plus `allow-scripts` gives the panel the same trust
      // as the package's Node extension, which already runs arbitrary code.
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
      allow="clipboard-write"
      referrerPolicy="no-referrer"
      style={{
        width: "100%",
        height: "100%",
        border: "none",
        display: "block",
        background: "var(--bg)",
      }}
    />
  );
}
