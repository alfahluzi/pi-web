"use client";

import { useEffect, useRef } from "react";
import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
} from "@codemirror/state";
import { EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { loadLanguageExtension } from "@/lib/code-languages";
import { useTheme } from "@/hooks/useTheme";

export interface FileEditorProps {
  value: string;
  language: string;
  wrapLines: boolean;
  readOnly?: boolean;
  onChange: (next: string) => void;
  onSave?: () => void;
  onReady?: () => void;
}

/** Built with `EditorView.theme` so light, dark, and the named themes all work. */
function editorTheme(isDark: boolean): Extension {
  const caretColor = isDark ? "#e8e8e8" : "#1a1a1a";
  const selectionColor = isDark ? "#3a4a66" : "#cfe0ff";
  return EditorView.theme(
    {
      "&": {
        backgroundColor: "var(--bg)",
        color: "var(--text)",
        fontFamily: "var(--font-mono)",
        height: "100%",
      },
      ".cm-content": {
        caretColor,
        fontFamily: "var(--font-mono)",
        padding: "8px 0",
      },
      ".cm-scroller": {
        fontFamily: "var(--font-mono)",
        lineHeight: "1.5",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: caretColor,
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: selectionColor,
      },
      ".cm-selectionMatch": {
        backgroundColor: "var(--bg-selected)",
      },
      ".cm-searchMatch": {
        backgroundColor: "var(--bg-selected)",
        outline: "1px solid var(--accent)",
      },
      ".cm-gutters": {
        backgroundColor: "var(--bg-panel)",
        color: "var(--text-dim)",
        border: "none",
        borderRight: "1px solid var(--border)",
      },
      ".cm-activeLine": {
        backgroundColor: "var(--bg-subtle)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "var(--bg-hover)",
        color: "var(--text)",
      },
      ".cm-panels": {
        backgroundColor: "var(--bg-panel)",
        color: "var(--text)",
      },
      ".cm-panels.cm-panels-top": {
        borderBottom: "1px solid var(--border)",
      },
      ".cm-tooltip": {
        backgroundColor: "var(--bg-panel)",
        color: "var(--text)",
        border: "1px solid var(--border)",
      },
    },
    { dark: isDark },
  );
}

export function FileEditor({
  value,
  language,
  wrapLines,
  readOnly,
  onChange,
  onSave,
  onReady,
}: FileEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment()).current;
  const wrapCompartment = useRef(new Compartment()).current;

  // Refs updated on every render keep the one-shot view and its listeners
  // reading the latest props without ever re-creating the EditorView.
  const valueRef = useRef(value);
  const languageRef = useRef(language);
  const wrapLinesRef = useRef(wrapLines);
  const readOnlyRef = useRef(readOnly);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onReadyRef = useRef(onReady);
  valueRef.current = value;
  languageRef.current = language;
  wrapLinesRef.current = wrapLines;
  readOnlyRef.current = readOnly;
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onReadyRef.current = onReady;

  const { isDark } = useTheme();
  const isDarkRef = useRef(isDark);
  isDarkRef.current = isDark;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      state: EditorState.create({
        doc: valueRef.current,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          keymap.of([
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            indentWithTab,
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                onSaveRef.current?.();
                return true;
              },
            },
          ]),
          bracketMatching(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          wrapCompartment.of(wrapLinesRef.current ? EditorView.lineWrapping : []),
          languageCompartment.of([]),
          EditorState.readOnly.of(readOnlyRef.current ?? false),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
          editorTheme(isDarkRef.current),
        ],
      }),
      parent: host,
    });

    viewRef.current = view;
    onReadyRef.current?.();

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value changes replace the document, but an echo of the editor's
  // own text (the save round-trip) is a no-op.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const next = valueRef.current;
    if (view.state.doc.toString() === next) return;
    const { anchor, head } = view.state.selection.main;
    const length = next.length;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
      selection: EditorSelection.single(Math.min(anchor, length), Math.min(head, length)),
    });
  }, [value]);

  // Language changes reconfigure a compartment; the EditorView survives.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let cancelled = false;
    void loadLanguageExtension(languageRef.current).then((extension) => {
      if (cancelled) return;
      const current = viewRef.current;
      if (!current) return;
      current.dispatch({
        effects: languageCompartment.reconfigure(extension ?? []),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [language, languageCompartment]);

  // Wrapping toggles through a compartment; the document and view are kept.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: wrapCompartment.reconfigure(wrapLines ? EditorView.lineWrapping : []),
    });
  }, [wrapLines, wrapCompartment]);

  return <div ref={hostRef} className="file-editor" data-testid="file-editor" />;
}