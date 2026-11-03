import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";

import { markdownRehypePlugins, markdownRemarkPlugins } from "./markdown.ts";
import { escapeStrayTags, parseSystemPrompt } from "./system-prompt-markdown.ts";

// The real pipeline, exactly as the panel renders a prose segment.
const render = (markdown) =>
  renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      { remarkPlugins: markdownRemarkPlugins, rehypePlugins: markdownRehypePlugins },
      markdown,
    ),
  );

const sections = (segments) => segments.filter((segment) => segment.kind === "section");
const prose = (segments) => segments.filter((segment) => segment.kind === "prose");
const names = (segments) => sections(segments).map((segment) => segment.name);
const shape = (segments) => segments.map((segment) => [segment.kind, segment.depth]);

// The single prose segment of a prompt that holds no section at all.
const soleProse = (prompt) => {
  const segments = parseSystemPrompt(prompt);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, "prose");
  return segments[0];
};

test("(a) preamble stays depth 0, then the section and its body", () => {
  const segments = parseSystemPrompt(
    "Intro line\n\n<tools>\n- read: Read file contents\n- bash: Execute bash commands\n</tools>",
  );

  assert.deepEqual(segments, [
    { kind: "prose", depth: 0, markdown: "Intro line", lineOriented: false },
    { kind: "section", depth: 0, name: "tools", label: "tools", attributes: "" },
    {
      kind: "prose",
      depth: 1,
      markdown: "- read: Read file contents\n- bash: Execute bash commands",
      lineOriented: false,
    },
  ]);
});

test("(b) nesting keeps document order, depths and attributes", () => {
  const segments = parseSystemPrompt(
    '<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/x/AGENTS.md">\nbody text\n</project_instructions>\n</project_context>',
  );

  assert.deepEqual(names(segments), ["project_context", "project_instructions"]);
  assert.deepEqual(shape(segments), [
    ["section", 0],
    ["prose", 1],
    ["section", 1],
    ["prose", 2],
  ]);
  assert.equal(sections(segments)[1].attributes, 'path="/x/AGENTS.md"');
  assert.equal(sections(segments)[0].attributes, "");
  assert.deepEqual(prose(segments).map((segment) => segment.markdown), [
    "Project-specific instructions and guidelines:",
    "body text",
  ]);
});

test("(c) underscore names become spaced labels and never leak as prose", () => {
  const segments = parseSystemPrompt(
    "<project_context>\nx\n</project_context>\n<available_skills>\ny\n</available_skills>",
  );

  assert.deepEqual(sections(segments).map((segment) => segment.label), [
    "project context",
    "available skills",
  ]);
  assert.ok(!segments.some((segment) => "markdown" in segment && segment.markdown.includes("<project_context>")));
});

test("(d) two-space indent nests, four-space indent is prose", () => {
  const nested = parseSystemPrompt(
    "<skills>\n<available_skills>\n  <skill>\n  <name>x</name>\n  </skill>\n</available_skills>\n</skills>",
  );
  const skill = sections(nested).find((segment) => segment.name === "skill");
  assert.equal(skill.depth, 2);
  assert.deepEqual(sections(nested).map((segment) => segment.depth), [0, 1, 2]);

  const indented = parseSystemPrompt("<tools>\n    <tools>\n</tools>\n</tools>");
  assert.deepEqual(names(indented), ["tools"]);
  assert.ok(prose(indented).some((segment) => segment.markdown.includes("\\<tools>")));
});

test("(e) a uniformly indented body is dedented to column 0", () => {
  const segments = parseSystemPrompt(
    "<skill>\n    <name>pdf</name>\n    <location>/x/SKILL.md</location>\n</skill>",
  );
  const body = segments[1];

  assert.equal(body.kind, "prose");
  assert.equal(body.depth, 1);
  assert.ok(!/^\s/.test(body.markdown));
  assert.ok(body.markdown.startsWith("\\<name>"));
});

test("(f) a fence holds </tools> without closing the section", () => {
  const segments = parseSystemPrompt("<tools>\n```\n</tools>\n```\n</tools>");

  assert.deepEqual(names(segments), ["tools"]);
  assert.equal(segments[1].kind, "prose");
  assert.equal(segments[1].markdown, "```\n</tools>\n```");
});

test("(g) an unterminated open tag keeps its body as prose", () => {
  const segments = parseSystemPrompt("<tools>\n- a\n- b");

  assert.deepEqual(names(segments), ["tools"]);
  assert.deepEqual(segments[1], { kind: "prose", depth: 1, markdown: "- a\n- b", lineOriented: false });
});

test("(h) a foreign close tag stays inside the body, escaped", () => {
  const segments = parseSystemPrompt("<tools>\nbody\n</rules>\nmore\n</tools>");

  assert.deepEqual(names(segments), ["tools"]);
  assert.equal(segments[1].markdown, "body\n\\</rules>\nmore");
});

test("(i) a stray close tag with no open section is one escaped prose segment", () => {
  const segments = parseSystemPrompt("text\n</rules>\nafter");

  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, "prose");
  assert.equal(segments[0].depth, 0);
  assert.ok(segments[0].markdown.includes("\\</rules>"));
  assert.equal(segments[0].markdown, "text\n\\</rules>\nafter");
});

test("(j) the escaper rewrites dropped tokens and leaves renderable tags alone", () => {
  assert.equal(escapeStrayTags("Pass --tools, -t <tools>, or edit"), "Pass --tools, -t \\<tools>, or edit");
  assert.equal(escapeStrayTags("<b>bold</b>"), "<b>bold</b>");
  assert.equal(escapeStrayTags("<br/>"), "<br/>");
  assert.equal(escapeStrayTags("<kbd>x</kbd>"), "<kbd>x</kbd>");
  assert.equal(escapeStrayTags("<details>"), "<details>");
  assert.equal(escapeStrayTags("Vec<T>"), "Vec\\<T>");
});

test("(k) autolinks, a bare less-than and inline code are immune", () => {
  const immune = "see <https://example.com> and a < b and `<file>`";

  assert.equal(escapeStrayTags(immune), immune);
  assert.equal(escapeStrayTags("```\n  <tools>\n```"), "```\n  <tools>\n```");
});

test("(l) empty input, and a section with a one-line body", () => {
  assert.deepEqual(parseSystemPrompt(""), []);
  assert.deepEqual(parseSystemPrompt("<cwd>\n/x\n</cwd>"), [
    { kind: "section", depth: 0, name: "cwd", label: "cwd", attributes: "" },
    { kind: "prose", depth: 1, markdown: "/x", lineOriented: false },
  ]);
});

test("(m) the live fixture order yields the twelve canonical sections", () => {
  const fixture = [
    "You are an expert coding assistant operating inside pi.",
    "",
    "<tools>",
    "- read: Read file contents",
    "</tools>",
    "",
    "<rules>",
    "- Show file paths clearly when working with files",
    "</rules>",
    "",
    "<docs>",
    "Pi documentation (read only when the user asks about pi itself).",
    "</docs>",
    "",
    "<addendum>",
    "You are a coding sub-agent.",
    "</addendum>",
    "",
    "<project_context>",
    "Project-specific instructions and guidelines:",
    "",
    '<project_instructions path="/Users/demo/code/pi-web/AGENTS.md">',
    "{{AGENTS_MD}}",
    "</project_instructions>",
    "</project_context>",
    "",
    "<skills>",
    "The following skills provide specialized instructions for specific tasks.",
    "",
    "<available_skills>",
    "  <skill>",
    "    <name>frontend-design</name>",
    "    <description>Build polished, accessible UI.</description>",
    "    <location>/Users/demo/.pi/agent/skills/frontend-design/SKILL.md</location>",
    "  </skill>",
    "  <skill>",
    "    <name>antislop</name>",
    "    <description>Rules for AI coding agents.</description>",
    "    <location>/Users/demo/.pi/agent/skills/antislop/SKILL.md</location>",
    "  </skill>",
    "</available_skills>",
    "</skills>",
    "",
    "<cwd>",
    "/Users/demo/code/pi-web",
    "</cwd>",
    "",
    "<mcp_servers>",
    "No MCP servers configured.",
    "</mcp_servers>",
  ].join("\n");

  const segments = parseSystemPrompt(fixture);

  assert.deepEqual(names(segments), [
    "tools",
    "rules",
    "docs",
    "addendum",
    "project_context",
    "project_instructions",
    "skills",
    "available_skills",
    "skill",
    "skill",
    "cwd",
    "mcp_servers",
  ]);
  assert.equal(sections(segments).at(-1).label, "mcp servers");
  assert.deepEqual(
    sections(segments)
      .filter((segment) => segment.name === "skill")
      .map((segment) => segment.depth),
    [2, 2],
  );
  assert.deepEqual(
    prose(segments)
      .filter((segment) => segment.markdown.startsWith("\\<name>"))
      .map((segment) => segment.depth),
    [3, 3],
  );
});

test("(n) lineOriented follows the content shape, not the depth", () => {
  const keyed = parseSystemPrompt(
    "<skill>\n    name: pdf\n    description: Read PDFs\n    location: /x/SKILL.md\n</skill>",
  );
  assert.equal(keyed[1].lineOriented, true);

  const paragraph = parseSystemPrompt(
    "<tools>\nthis line is a sentence\nand this is another line\n</tools>",
  );
  assert.equal(paragraph[1].lineOriented, false);

  const withBlank = parseSystemPrompt("<tools>\nname: a\n\ndescription: b\n</tools>");
  assert.equal(withBlank[1].lineOriented, false);

  const single = parseSystemPrompt("<cwd>\n/Users/x\n</cwd>");
  assert.equal(single[1].lineOriented, false);
});

test("(o) frontmatter is neutralised while comments stay dropped", () => {
  const neutralised = soleProse("---\ntitle: Repo rules\n---\n\ntext");
  assert.match(render(neutralised.markdown), /title: Repo rules/);

  // The deletion being mitigated: this must fail loudly if the pipeline changes.
  assert.doesNotMatch(render("---\ntitle: Repo rules\n---\n\ntext"), /title: Repo rules/);

  assert.ok(!render("<!-- hidden -->\nhello").includes("hidden"));
});

test("(p) escaped tokens render as visible text through the real pipeline", () => {
  assert.ok(render(escapeStrayTags("<tools>\nx")).includes("&lt;tools&gt;"));
  assert.ok(render(escapeStrayTags("Pass -t <tools>, or edit")).includes("&lt;tools&gt;"));
  assert.ok(render(escapeStrayTags("a Vec<T>")).includes("&lt;T&gt;"));
  assert.ok(render(escapeStrayTags("<b>bold</b>")).includes("<b>"));
});

test("(q1) a bare <br> in a body stays prose", () => {
  const segments = parseSystemPrompt(
    "<project_context>\nIntro\n<br>\nMore\n</project_context>\n<cwd>\n/x\n</cwd>",
  );

  assert.deepEqual(names(segments), ["project_context", "cwd"]);
  assert.deepEqual(sections(segments).map((segment) => segment.depth), [0, 0]);

  const body = segments[1];
  assert.equal(body.kind, "prose");
  assert.equal(body.depth, 1);
  assert.ok(body.markdown.includes("<br>"));
  assert.ok(!segments.some((segment) => "markdown" in segment && segment.markdown.includes("</project_context>")));

  assert.equal(segments[3].kind, "prose");
  assert.equal(segments[3].depth, 1);
  assert.equal(segments[3].markdown, "/x");

  const html = render(body.markdown);
  assert.ok(html.includes("<br/>"));
  assert.equal((html.match(/<p>/g) ?? []).length, 1);
});

test("(q2) <details>/<summary> stay prose", () => {
  const segments = parseSystemPrompt("<details>\n<summary>More</summary>\n\nbody text\n</details>");

  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, "prose");
  assert.ok(!segments.some((segment) => segment.kind === "section"));
  assert.ok(segments[0].markdown.includes("<details>"));

  const html = render(segments[0].markdown);
  assert.ok(html.includes("<details>"));
  assert.ok(html.includes("<summary>"));
  assert.ok(!html.includes("&lt;details"));
});

test("(q3) <div align=\"center\"> stays prose with its attribute", () => {
  const segments = parseSystemPrompt('<div align="center">hi</div>');

  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, "prose");
  assert.ok(segments[0].markdown.includes('align="center"'));
  assert.ok(render(segments[0].markdown).includes('<div align="center">hi</div>'));
});

test("(q4) <img src=\"x.png\" /> stays prose", () => {
  const segments = parseSystemPrompt('<img src="x.png" />');

  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, "prose");
  assert.ok(!segments.some((segment) => segment.kind === "section"));
  assert.ok(!sections(segments).some((segment) => segment.label.toLowerCase() === "img"));
  assert.ok(render(segments[0].markdown).includes('<img src="x.png"'));
});
