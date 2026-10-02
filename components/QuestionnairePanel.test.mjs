import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createJiti } from "jiti";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".module.css")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: "export default new Proxy({}, { get: (_, key) => String(key) });",
    };
  },
});

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { QuestionnairePanel } = await jiti.import("./QuestionnairePanel.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const singleSelect = [
  {
    question: "Which date library should we use?",
    header: "Library",
    multiSelect: false,
    options: [
      { label: "date-fns", description: "tree-shakeable", preview: "### date-fns\n\n`format()`" },
      { label: "dayjs", description: "2 kB core" },
    ],
  },
];

const multiQuestion = [
  ...singleSelect,
  {
    question: "Which features do you want?",
    header: "Features",
    multiSelect: true,
    options: [
      { label: "Timezone support", description: "IANA zones" },
      { label: "Locales", description: "shipped locale files" },
    ],
  },
];

function render(questions) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(QuestionnairePanel, { questions, onSubmit: () => {} }),
    ),
  );
}

test("renders a native form for a single question", () => {
  const html = render(singleSelect);

  assert.match(html, /role="dialog"/);
  assert.match(html, /Which date library should we use\?/);
  assert.match(html, /Library/);
  assert.match(html, /date-fns/);
  assert.match(html, /tree-shakeable/);
  // The sentinel row is Pi Web's, never the model's.
  assert.match(html, /Type something\./);
  assert.match(html, /Submit answers/);
  // No tab bar and no review tab for one question.
  assert.doesNotMatch(html, /role="tablist"/);
});

test("shows the option preview beside the list", () => {
  const html = render(singleSelect);

  assert.match(html, /date-fns/);
  assert.match(html, /<h3>date-fns<\/h3>/);
  assert.match(html, /preview/i);
});

test("multi-select questions advertise the hint and a checkbox marker", () => {
  const html = render([multiQuestion[1]]);

  assert.match(html, /Select all that apply/);
  assert.match(html, /Timezone support/);
  assert.match(html, /Locales/);
});

test("several questions get a tab bar and a review tab", () => {
  const html = render(multiQuestion);

  assert.match(html, /role="tablist"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, />Features</);
  assert.match(html, />Review</);
  assert.match(html, /0\/2 answered/);
});

test("an option without a preview does not break the preview pane", () => {
  const html = render([{
    question: "Pick one?",
    header: "Pick",
    multiSelect: false,
    options: [
      { label: "plain", description: "no preview here" },
      { label: "rich", description: "has one", preview: "`code`" },
    ],
  }]);

  assert.match(html, /plain/);
  assert.match(html, /rich/);
  assert.match(html, /<code[^>]*>code<\/code>/);
});
