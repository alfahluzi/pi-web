import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  buildQuestionnaireResult,
  cancelledQuestionnaireResult,
  describeQuestionnaireAnswer,
  emptyQuestionnaireDraft,
  isQuestionnaireAnswered,
  parseQuestionnaireArgs,
  sanitizeQuestionnaireResult,
  selectQuestionnaireOption,
  setQuestionnaireAnswerNote,
  setQuestionnaireCustomAnswer,
  setQuestionnaireGlobalNote,
  toggleQuestionnaireOption,
} = await jiti.import("./questionnaire.ts");

const questions = [
  {
    question: "Which date library should we use?",
    header: "Library",
    multiSelect: false,
    options: [
      { label: "date-fns", description: "small tree-shakeable build", preview: "# date-fns\n\n`format()`" },
      { label: "dayjs", description: "2 kB core" },
    ],
  },
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

test("parses the tool args and keeps option previews", () => {
  const parsed = parseQuestionnaireArgs({ questions });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].header, "Library");
  assert.equal(parsed[0].multiSelect, false);
  assert.equal(parsed[0].options[0].preview, "# date-fns\n\n`format()`");
  // A preview-less option must not carry an empty `preview` key: the UI keys
  // the preview pane off its presence.
  assert.equal("preview" in parsed[0].options[1], false);
  assert.equal(parsed[1].multiSelect, true);
});

test("parses JSON-encoded args and rejects anything that is not a questionnaire", () => {
  assert.equal(parseQuestionnaireArgs(JSON.stringify({ questions })).length, 2);
  assert.equal(parseQuestionnaireArgs("not json"), null);
  assert.equal(parseQuestionnaireArgs(undefined), null);
  assert.equal(parseQuestionnaireArgs({ questions: [] }), null);
  assert.equal(parseQuestionnaireArgs({ questions: [{ question: "q", options: [] }] }), null);
  assert.equal(parseQuestionnaireArgs({ questions: [{ question: "q", options: [{ description: "no label" }] }] }), null);
});

test("single-select, multi-select and custom answers collapse into the extension result", () => {
  let draft = emptyQuestionnaireDraft();
  draft = selectQuestionnaireOption(draft, 0, "date-fns");
  draft = toggleQuestionnaireOption(draft, 1, "Locales");
  draft = toggleQuestionnaireOption(draft, 1, "Timezone support");
  draft = setQuestionnaireAnswerNote(draft, 1, "ship the tz database");

  assert.equal(isQuestionnaireAnswered(draft, 0), true);
  const result = buildQuestionnaireResult(draft, questions);

  assert.deepEqual(result.answers, [
    {
      questionIndex: 0,
      question: questions[0].question,
      kind: "option",
      answer: "date-fns",
      preview: "# date-fns\n\n`format()`",
    },
    {
      questionIndex: 1,
      question: questions[1].question,
      kind: "multi",
      answer: null,
      selected: ["Timezone support", "Locales"],
      notes: "ship the tz database",
    },
  ]);
  assert.equal(result.cancelled, false);
  assert.equal("globalNote" in result, false);
});

test("custom text replaces the option selection and empty text stays unanswered", () => {
  let draft = selectQuestionnaireOption(emptyQuestionnaireDraft(), 0, "dayjs");
  draft = setQuestionnaireCustomAnswer(draft, 0, "use the platform Intl API");
  assert.equal(draft.answers[0].kind, "custom");
  assert.equal(buildQuestionnaireResult(draft, questions).answers[0].answer, "use the platform Intl API");

  draft = setQuestionnaireCustomAnswer(draft, 0, "");
  assert.equal(isQuestionnaireAnswered(draft, 0), false);
  assert.deepEqual(buildQuestionnaireResult(draft, questions).answers, []);
});

test("a note survives an unanswered question, and an unknown label is dropped", () => {
  let draft = setQuestionnaireAnswerNote(emptyQuestionnaireDraft(), 0, "prefer ESM");
  draft = selectQuestionnaireOption(draft, 1, "not an offered label");
  const result = buildQuestionnaireResult(draft, questions);

  // The extension's own vocabulary covers a note without an answer: an empty
  // custom answer is `kind: "custom"` with `answer: null`, which its envelope
  // renders as `(no input)` beside the note. Dropping the note silently would
  // lose what the user typed.
  assert.deepEqual(result.answers, [
    {
      questionIndex: 0,
      question: questions[0].question,
      kind: "custom",
      answer: null,
      notes: "prefer ESM",
    },
  ]);
});

test("global note rides the result and can make an answer-less submit meaningful", () => {
  let draft = setQuestionnaireGlobalNote(emptyQuestionnaireDraft(), "Ask me again tomorrow");
  const result = buildQuestionnaireResult(draft, questions);
  assert.equal(result.answers.length, 0);
  assert.equal(result.globalNote, "Ask me again tomorrow");
  assert.equal(result.cancelled, false);
});

test("describes answers for the review tab", () => {
  let draft = selectQuestionnaireOption(emptyQuestionnaireDraft(), 0, "dayjs");
  draft = toggleQuestionnaireOption(draft, 1, "Locales");
  assert.equal(describeQuestionnaireAnswer(draft, 0), "dayjs");
  assert.equal(describeQuestionnaireAnswer(draft, 1), "Locales");
  assert.equal(describeQuestionnaireAnswer(draft, 2), "");
});

test("cancel produces the extension's canonical decline result", () => {
  assert.deepEqual(cancelledQuestionnaireResult(), { answers: [], cancelled: true });
});

test("sanitising rejects labels the model never offered", () => {
  const result = sanitizeQuestionnaireResult({
    cancelled: false,
    answers: [
      { questionIndex: 0, kind: "option", answer: "moment" },
      { questionIndex: 1, kind: "multi", selected: ["Locales", "injected"] },
      { questionIndex: 9, kind: "custom", answer: "out of range" },
    ],
  }, questions);

  assert.deepEqual(result.answers, [
    {
      questionIndex: 1,
      question: questions[1].question,
      kind: "multi",
      answer: null,
      selected: ["Locales"],
    },
  ]);
});

test("sanitising keeps a valid pick, its preview and its notes", () => {
  const result = sanitizeQuestionnaireResult({
    cancelled: false,
    globalNote: "one more thing",
    answers: [
      { questionIndex: 0, kind: "option", answer: "date-fns", notes: "and timezones" },
      { questionIndex: 0, kind: "custom", answer: "duplicate index is ignored" },
    ],
  }, questions);

  assert.equal(result.answers.length, 1);
  assert.equal(result.answers[0].preview, "# date-fns\n\n`format()`");
  assert.equal(result.answers[0].notes, "and timezones");
  assert.equal(result.globalNote, "one more thing");
});

test("an empty or malformed payload degrades to a decline", () => {
  assert.deepEqual(sanitizeQuestionnaireResult(null, questions), { answers: [], cancelled: true });
  assert.deepEqual(sanitizeQuestionnaireResult({ cancelled: true }, questions), { answers: [], cancelled: true });
  assert.deepEqual(sanitizeQuestionnaireResult({ answers: [] }, questions), { answers: [], cancelled: true });
});
