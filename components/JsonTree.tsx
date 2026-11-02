"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";

// A tool call's arguments as a foldable tree, in place of the raw JSON the card
// used to dump. Parsed input only: streamed `rawInput` is incomplete JSON, and a
// call a richer view owns (an edit diff, a written file, a codemode script)
// never reaches this component.

/** Payloads whose JSON text is longer than this keep the plain text view. */
export const JSON_TREE_MAX_CHARS = 16_000;
/** Payloads with more nodes than this keep the plain text view. */
export const JSON_TREE_MAX_NODES = 500;
/** Containers at or below this depth start open; deeper ones start folded. */
export const JSON_TREE_OPEN_DEPTH = 1;

/** Deeper than this the payload keeps the plain text view instead of a tree. */
const JSON_TREE_MAX_DEPTH = 32;
/** A leaf string past this many characters is cut; the rest is only in `title`. */
const JSON_TREE_STRING_MAX = 300;
/** Longer strings are not worth a `title` tooltip either. */
const JSON_TREE_TITLE_MAX = 2000;
/** One nesting level's indent, in pixels. */
const JSON_TREE_INDENT = 14;

const STRING_COLOR = "#16a34a";
const NUMBER_COLOR = "#d97706";
const BOOLEAN_COLOR = "#7c3aed";

export type JsonTreeValue = Record<string, unknown> | unknown[];

function isContainer(value: unknown): value is JsonTreeValue {
  return typeof value === "object" && value !== null;
}

/** A container's own entries, an array's indexes standing in for its keys. */
function containerEntries(value: JsonTreeValue): Array<[string, unknown]> {
  if (Array.isArray(value)) return value.map((item, index) => [String(index), item]);
  return Object.entries(value);
}

/**
 * Whether the payload is too big or too deep for a tree. Walks with an early
 * exit, so a huge payload costs a bounded number of steps, never a full count.
 */
function exceedsTreeBudget(root: JsonTreeValue): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  for (let index = 0; index < pending.length; index++) {
    const node = pending[index];
    if (++nodes > JSON_TREE_MAX_NODES) return true;
    if (node.depth > JSON_TREE_MAX_DEPTH) return true;
    if (!isContainer(node.value)) continue;
    const children = containerEntries(node.value);
    if (nodes + pending.length + children.length > JSON_TREE_MAX_NODES) return true;
    for (const [, child] of children) pending.push({ value: child, depth: node.depth + 1 });
  }
  return false;
}

/** The value as a tree, or null when the raw text is what should be shown instead. */
export function asJsonTreeValue(value: unknown, jsonTextLength: number): JsonTreeValue | null {
  if (!isContainer(value)) return null;
  if (jsonTextLength > JSON_TREE_MAX_CHARS) return null;
  if (exceedsTreeBudget(value)) return null;
  return value;
}

function stringNode(text: string) {
  const cut = text.length > JSON_TREE_STRING_MAX ? `${text.slice(0, JSON_TREE_STRING_MAX)}…` : text;
  return (
    <span
      title={text.length <= JSON_TREE_TITLE_MAX ? text : undefined}
      style={{ color: STRING_COLOR, wordBreak: "break-all" }}
    >
      {`"${cut}"`}
    </span>
  );
}

function scalarNode(value: unknown) {
  if (typeof value === "string") return stringNode(value);
  if (typeof value === "number") {
    return <span style={{ color: NUMBER_COLOR }}>{String(value)}</span>;
  }
  if (typeof value === "boolean") {
    return <span style={{ color: BOOLEAN_COLOR }}>{String(value)}</span>;
  }
  return <span style={{ color: "var(--text-dim)" }}>{String(value)}</span>;
}

/** A container's stand-in text: its brackets, with an ellipsis once folded. */
function containerMarker(value: JsonTreeValue, folded: boolean): string {
  if (Array.isArray(value)) return folded ? "[…]" : "[]";
  return folded ? "{…}" : "{}";
}

function TreeRow({ label, value, depth }: { label: string; value: unknown; depth: number }) {
  const { t } = useI18n();
  const container = isContainer(value);
  const entries = container ? containerEntries(value) : [];
  const empty = container && entries.length === 0;
  const toggleable = container && !empty;
  const [open, setOpen] = useState(depth < JSON_TREE_OPEN_DEPTH);

  return (
    <>
      <div style={{ paddingLeft: depth * JSON_TREE_INDENT }}>
        {toggleable ? (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-label={t(open ? "jsonTree.collapse" : "jsonTree.expand")}
            style={{
              display: "inline-block",
              width: JSON_TREE_INDENT,
              padding: 0,
              margin: 0,
              border: "none",
              background: "none",
              color: "var(--text-dim)",
              font: "inherit",
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span style={{ display: "inline-block", width: JSON_TREE_INDENT }} />
        )}
        <span style={{ color: "var(--accent)" }}>{label}</span>
        <span style={{ color: "var(--text-dim)" }}>: </span>
        {container ? (
          empty || !open ? (
            <span style={{ color: "var(--text-dim)" }}>{containerMarker(value, !empty)}</span>
          ) : null
        ) : (
          scalarNode(value)
        )}
      </div>
      {container && open && !empty
        ? entries.map(([childLabel, childValue]) => (
            <TreeRow key={childLabel} label={childLabel} value={childValue} depth={depth + 1} />
          ))
        : null}
    </>
  );
}

export function JsonTree({ value, isError }: { value: JsonTreeValue; isError?: boolean }) {
  const entries = containerEntries(value);
  return (
    <div
      style={{
        padding: "8px 10px",
        background: "var(--bg-subtle)",
        borderTop: isError ? "1px solid rgba(248,113,113,0.25)" : "1px solid rgba(34,197,94,0.2)",
        fontFamily: "var(--font-mono)",
        fontSize: "calc(12px + var(--chat-font-size-offset, 0px))",
        lineHeight: 1.5,
        color: "var(--text-muted)",
        overflow: "auto",
        maxHeight: 420,
      }}
    >
      {entries.length === 0 ? (
        <div style={{ paddingLeft: 0 }}>
          <span style={{ display: "inline-block", width: JSON_TREE_INDENT }} />
          <span style={{ color: "var(--text-dim)" }}>{containerMarker(value, false)}</span>
        </div>
      ) : (
        entries.map(([label, child]) => (
          <TreeRow key={label} label={label} value={child} depth={0} />
        ))
      )}
    </div>
  );
}
