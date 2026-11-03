import { defaultSchema } from "rehype-sanitize";

/**
 * pi's system prompt is a single string: prose plus line-aligned XML-ish wrappers
 * (`<tools>`, `<project_context>`, `<skill>` …). Three traps motivate this module.
 *
 * - A bare `<tools>` line is an HTML block to Markdown: it swallows the list that
 *   follows and its own `</tools>` line, so the panel would show an empty body.
 *   Splitting the wrappers out as sections leaves the body ordinary Markdown.
 * - `markdownRemarkPlugins` starts with `[remarkFrontmatter, ["yaml"]]`, so a body
 *   that opens with a `---` line has that whole first block deleted.
 * - A tag-only line naming an HTML tag the pipeline can render (`<br>`,
 *   `<details>`/`<summary>`, `<div align="center">`) is prose, not a section.
 */
export type SystemPromptSegment =
  | { kind: "prose"; depth: number; markdown: string; lineOriented: boolean }
  | { kind: "section"; depth: number; name: string; label: string; attributes: string };

// The sanitizer's own allow-list, built once and shared with `escapeStrayTags`:
// a tag-only line naming one of these tags is prose, and a token naming one of
// them passes through the escaper untouched.
const safeTags = new Set(defaultSchema.tagNames ?? []);

// A wrapper owns its line, so at most three leading spaces: four spaces is a
// Markdown code block and the line is ordinary prose there. The name follows
// pi's own rule (lower-case, no capitals), which also keeps `<T>` and `Vec<T>`
// out.
const wrapperTagLine = /^ {0,3}<(\/?)([a-z][a-z0-9_-]*)((?:\s[^<>]*?)?)\s*(\/?)>\s*$/;

// Both the segmenter and the escaper need the same fence state over a line.
const fenceLine = /^ {0,3}(`{3,}|~{3,})/;

// A `key: value` line, as a skill body writes `name: pdf`.
const keyedLine = /^\s*[\w.$-]+\s*:(\s|$)/;
// A line that opens with a tag-ish/label token, e.g. `<summary>More</summary>`.
const tagishLine = /^\s*\\?<\/?[A-Za-z][A-Za-z0-9_-]*(?=[\s/>]|$)/;

// Sticky, so it is tried exactly at the `<` being scanned.
const inlineTag = /<\/?([A-Za-z][A-Za-z0-9_-]*)((?:\s[^<>]*?)?)\s*\/?>/y;

interface Fence {
  marker: string;
  size: number;
}

/** The fence state after `line`: opens at a fence line, closes at a longer-or-equal one. */
function advanceFence(line: string, fence: Fence | null): Fence | null {
  const match = fenceLine.exec(line);
  if (!fence) return match ? { marker: match[1][0], size: match[1].length } : null;
  if (match && match[1][0] === fence.marker && match[1].length >= fence.size) return null;
  return fence;
}

function leadingWhitespace(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Flushes one prose buffer. The body is dedented by the smallest indent of its
 * non-blank lines: the live skills block indents its XML by four spaces, which
 * Markdown would otherwise render as a code block.
 *
 * `lineOriented` is content shape, never depth — the 46 KB AGENTS.md body of
 * `project_instructions` sits at prose depth 2, and a depth-based rule put a
 * `<br>` after every hard-wrapped line of it.
 */
function flush(buffer: string[], depth: number, segments: SystemPromptSegment[]): void {
  const lines = buffer.slice();
  buffer.length = 0;
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0) return;

  const indent = lines.reduce(
    (min, line) => (line.trim() === "" ? min : Math.min(min, leadingWhitespace(line))),
    Number.POSITIVE_INFINITY,
  );
  const body = lines.map((line) =>
    line.slice(Math.min(indent, leadingWhitespace(line))).trimEnd(),
  );
  const lineOriented =
    body.every((line) => line.trim() !== "") &&
    body.every((line) => keyedLine.test(line) || tagishLine.test(line));

  segments.push({
    kind: "prose",
    depth,
    markdown: escapeStrayTags(neutralizeFrontmatter(body.join("\n"))),
    lineOriented,
  });
}

/**
 * `markdownRemarkPlugins` begins with `[remarkFrontmatter, ["yaml"]]`, which
 * deletes a leading `---` … `---` block. Only that block-start position is
 * touched, so the `---` horizontal rules deeper in an AGENTS.md body survive.
 */
function neutralizeFrontmatter(markdown: string): string {
  const lines = markdown.split("\n");
  if (lines[0] !== "---") return markdown;
  const close = lines.indexOf("---", 1);
  if (close === -1) return markdown;
  lines[0] = `\\${lines[0]}`;
  lines[close] = `\\${lines[close]}`;
  return lines.join("\n");
}

/** One line: escapes tag-like tokens outside code spans, carrying the code-span state over. */
function escapeLineTags(line: string, codeMarkerSize: number): { text: string; codeMarkerSize: number } {
  let text = "";
  let index = 0;
  let code = codeMarkerSize;

  while (index < line.length) {
    if (line[index] === "`") {
      let run = 1;
      while (line[index + run] === "`") run += 1;
      // A run of N opens a code span; the next run of exactly N closes it.
      if (code === 0) code = run;
      else if (run === code) code = 0;
      text += line.slice(index, index + run);
      index += run;
      continue;
    }
    if (line[index] === "<" && code === 0) {
      inlineTag.lastIndex = index;
      const match = inlineTag.exec(line);
      if (match) {
        // A token the sanitizer would drop becomes visible text. Autolinks
        // (`<https://x>`, `<a@b>`) and `a < b` never reach this branch.
        if (!safeTags.has(match[1]) && line[index - 1] !== "\\") text += "\\";
        text += match[0];
        index = inlineTag.lastIndex;
        continue;
      }
    }
    text += line[index];
    index += 1;
  }

  return { text, codeMarkerSize: code };
}

/** Backslash-escapes the tag-like tokens `rehype-sanitize` would silently drop. */
export function escapeStrayTags(markdown: string): string {
  const escaped: string[] = [];
  let fence: Fence | null = null;
  let codeMarkerSize = 0;

  for (const line of markdown.split(/\r?\n/)) {
    const openFence = fence;
    fence = advanceFence(line, fence);
    // Fence lines and their contents are code: nothing inside is a tag.
    if (openFence || fence) {
      escaped.push(line);
      continue;
    }
    // A blank line ends a paragraph, so inline-code state cannot span it.
    if (line.trim() === "") {
      codeMarkerSize = 0;
      escaped.push(line);
      continue;
    }
    const { text, codeMarkerSize: nextCodeSize } = escapeLineTags(line, codeMarkerSize);
    codeMarkerSize = nextCodeSize;
    escaped.push(text);
  }

  return escaped.join("\n");
}

/**
 * Splits the system prompt into ordered segments. A section is emitted at its
 * open tag, so a parent precedes its children and its body follows as prose.
 *
 * A tag-only line is structural only when its name is NOT in `safeTags`. Both
 * halves of that predicate are needed: a tag-only line for an HTML tag the
 * pipeline can render (a bare `<br>`, `<details>`/`<summary>`, `<div align="center">`)
 * is prose in real project docs, and treating it as a section opener both
 * invents a label and — because a close pops only on exact stack-top equality —
 * makes the enclosing section's real close tag fail to match and leak as escaped
 * text while every later section lands one level too deep. None of pi's twelve
 * canonical section names is in the allow-list, so wrappers stay sections.
 */
export function parseSystemPrompt(prompt: string): SystemPromptSegment[] {
  const segments: SystemPromptSegment[] = [];
  const stack: string[] = [];
  const buffer: string[] = [];
  let fence: Fence | null = null;

  for (const line of prompt.split(/\r?\n/)) {
    const openFence = fence;
    fence = advanceFence(line, fence);
    // Fence tracking runs first: a fence opened inside a section body may hold
    // `</tools>` without closing the section.
    if (openFence || fence) {
      buffer.push(line);
      continue;
    }

    const match = wrapperTagLine.exec(line);
    if (match && !safeTags.has(match[2])) {
      const close = match[1] === "/";
      const selfClosing = match[4] === "/";
      if (!close && !selfClosing) {
        flush(buffer, stack.length, segments);
        segments.push({
          kind: "section",
          depth: stack.length,
          name: match[2],
          label: match[2].replace(/_/g, " "),
          attributes: match[3].trim(),
        });
        stack.push(match[2]);
        continue;
      }
      if (close && stack[stack.length - 1] === match[2]) {
        flush(buffer, stack.length, segments);
        stack.pop();
        continue;
      }
      // A self-closing tag or a close that does not match the stack top stays
      // in the buffer; the escaper then makes it visible text.
    }

    buffer.push(line);
  }

  flush(buffer, stack.length, segments);
  return segments;
}
