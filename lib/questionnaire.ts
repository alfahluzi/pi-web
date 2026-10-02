/**
 * Native `ask_user_question` questionnaire — shared types and pure helpers.
 *
 * The rpiv extension (`@juicesharp/rpiv-ask-user-question`) renders its
 * questionnaire through `ctx.ui.custom()`, which Pi Web can only emulate as an
 * ANSI terminal. Pi Web therefore detects that one tool call and asks the
 * browser for a real form instead; this module owns the wire shape between the
 * two halves and the pure draft/result arithmetic so both are testable without
 * React or a session.
 *
 * The shapes mirror the extension's own `tool/types.ts` (`QuestionData`,
 * `QuestionAnswer`, `QuestionnaireResult`) on purpose: whatever Pi Web returns
 * from `ui.custom()` is fed straight into the extension's
 * `buildQuestionnaireResponse`, so the LLM-facing envelope stays byte-identical
 * to the TUI path.
 */

/** Tool name registered by the rpiv extension; the only one Pi Web intercepts. */
export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

export interface QuestionnaireOption {
  label: string;
  description: string;
  /** Markdown shown side-by-side with the option list (single-select only). */
  preview?: string;
}

export interface QuestionnaireQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionnaireOption[];
}

/** Answer-intent union; `kind` is the discriminator (see the extension's types). */
export interface QuestionnaireAnswer {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "multi";
  answer: string | null;
  selected?: string[];
  notes?: string;
  preview?: string;
}

export interface QuestionnaireResult {
  answers: QuestionnaireAnswer[];
  cancelled: boolean;
  globalNote?: string;
}

/**
 * The three runtime sentinel rows the extension appends. Pi Web must render the
 * `other` row itself (and must never let a draft answer be labelled with one),
 * so the labels live here rather than only in the extension.
 */
export const QUESTIONNAIRE_OTHER_LABEL = "Type something.";

/** The model may author at most this many questions (extension schema). */
export const MAX_QUESTIONNAIRE_QUESTIONS = 4;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Read the questionnaire out of an `ask_user_question` tool call's arguments.
 *
 * Returns null for anything that does not look like a questionnaire so the
 * caller can fall back to the ANSI panel instead of rendering an empty form —
 * the tool args are the only place the option `preview` bodies are available
 * (the extension's `rpiv:ask-user:prompt` event ships `hasPreview` only), which
 * is why Pi Web reads them rather than the public event.
 */
export function parseQuestionnaireArgs(args: unknown): QuestionnaireQuestion[] | null {
  let value = args;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const params = asRecord(value);
  const rawQuestions = params?.questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null;

  const questions: QuestionnaireQuestion[] = [];
  for (const rawQuestion of rawQuestions) {
    const question = asRecord(rawQuestion);
    if (!question) return null;
    const rawOptions = question.options;
    if (!Array.isArray(rawOptions) || rawOptions.length === 0) return null;

    const options: QuestionnaireOption[] = [];
    for (const rawOption of rawOptions) {
      const option = asRecord(rawOption);
      if (!option || typeof option.label !== "string" || option.label.length === 0) return null;
      const preview = asText(option.preview);
      options.push({
        label: option.label,
        description: asText(option.description),
        ...(preview.length > 0 ? { preview } : {}),
      });
    }

    questions.push({
      question: asText(question.question),
      header: asText(question.header),
      multiSelect: question.multiSelect === true,
      options,
    });
  }
  return questions;
}

/** True when the question carries at least one option preview. */
export function hasQuestionnairePreview(question: QuestionnaireQuestion): boolean {
  return question.options.some((option) => (option.preview?.length ?? 0) > 0);
}

/**
 * True when the model authored a label the extension reserves for its own
 * runtime rows. The extension rejects those questionnaires at validation time,
 * so this is only used to keep the UI honest about which row is the sentinel.
 */
export function isReservedQuestionnaireLabel(label: string): boolean {
  return label === QUESTIONNAIRE_OTHER_LABEL || label === "Other" || label === "Next";
}

// ---------------------------------------------------------------------------
// Draft state (browser side)
// ---------------------------------------------------------------------------

export interface QuestionnaireDraftAnswer {
  kind: "option" | "custom" | "multi";
  answer: string | null;
  selected: string[];
  notes?: string;
}

export interface QuestionnaireDraft {
  answers: Record<number, QuestionnaireDraftAnswer>;
  globalNote: string;
}

export function emptyQuestionnaireDraft(): QuestionnaireDraft {
  return { answers: {}, globalNote: "" };
}

function withAnswer(
  draft: QuestionnaireDraft,
  questionIndex: number,
  answer: QuestionnaireDraftAnswer,
): QuestionnaireDraft {
  return { ...draft, answers: { ...draft.answers, [questionIndex]: answer } };
}

/** Single-select pick; also clears any "Type something." text for that question. */
export function selectQuestionnaireOption(
  draft: QuestionnaireDraft,
  questionIndex: number,
  label: string,
): QuestionnaireDraft {
  const notes = draft.answers[questionIndex]?.notes;
  return withAnswer(draft, questionIndex, {
    kind: "option",
    answer: label,
    selected: [],
    ...(notes ? { notes } : {}),
  });
}

/** Toggle one row of a multi-select question. */
export function toggleQuestionnaireOption(
  draft: QuestionnaireDraft,
  questionIndex: number,
  label: string,
): QuestionnaireDraft {
  const current = draft.answers[questionIndex];
  const selected = current?.kind === "multi" ? current.selected : [];
  const next = selected.includes(label)
    ? selected.filter((entry) => entry !== label)
    : [...selected, label];
  return withAnswer(draft, questionIndex, {
    kind: "multi",
    answer: null,
    selected: next,
    ...(current?.notes ? { notes: current.notes } : {}),
  });
}

/** The "Type something." escape; an empty string keeps the answer unanswered. */
export function setQuestionnaireCustomAnswer(
  draft: QuestionnaireDraft,
  questionIndex: number,
  text: string,
): QuestionnaireDraft {
  const notes = draft.answers[questionIndex]?.notes;
  return withAnswer(draft, questionIndex, {
    kind: "custom",
    answer: text.length > 0 ? text : null,
    selected: [],
    ...(notes ? { notes } : {}),
  });
}

/** Per-question note; whitespace-only clears it. */
export function setQuestionnaireAnswerNote(
  draft: QuestionnaireDraft,
  questionIndex: number,
  text: string,
): QuestionnaireDraft {
  const current = draft.answers[questionIndex] ?? { kind: "option" as const, answer: null, selected: [] };
  const trimmed = text.trim();
  return withAnswer(draft, questionIndex, {
    ...current,
    ...(trimmed.length > 0 ? { notes: text } : { notes: undefined }),
  });
}

export function setQuestionnaireGlobalNote(draft: QuestionnaireDraft, text: string): QuestionnaireDraft {
  return { ...draft, globalNote: text };
}

/** True when the question has something the model can act on. */
export function isQuestionnaireAnswered(draft: QuestionnaireDraft, questionIndex: number): boolean {
  const answer = draft.answers[questionIndex];
  if (!answer) return false;
  if (answer.kind === "multi") return answer.selected.length > 0;
  return (answer.answer?.trim().length ?? 0) > 0;
}

/**
 * Collapse the draft into the result the extension expects. Unanswered
 * questions are omitted (the envelope lists only answered ones), and a note
 * survives even when its question was left unanswered — mirroring the TUI,
 * where notes ride the result regardless.
 */
export function buildQuestionnaireResult(
  draft: QuestionnaireDraft,
  questions: readonly QuestionnaireQuestion[],
): QuestionnaireResult {
  const answers: QuestionnaireAnswer[] = [];
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const answer = draft.answers[index];
    if (!answer) continue;

    const notes = answer.notes && answer.notes.trim().length > 0 ? answer.notes : undefined;
    if (answer.kind === "multi") {
      const selected = question.options
        .map((option) => option.label)
        .filter((label) => answer.selected.includes(label));
      if (selected.length === 0 && !notes) continue;
      answers.push({
        questionIndex: index,
        question: question.question,
        kind: "multi",
        answer: null,
        selected,
        ...(notes ? { notes } : {}),
      });
      continue;
    }

    const text = answer.answer ?? "";
    if (answer.kind === "custom") {
      if (text.trim().length === 0 && !notes) continue;
      answers.push({
        questionIndex: index,
        question: question.question,
        kind: "custom",
        answer: text.trim().length > 0 ? text : null,
        ...(notes ? { notes } : {}),
      });
      continue;
    }

    const option = question.options.find((entry) => entry.label === text);
    if (option) {
      answers.push({
        questionIndex: index,
        question: question.question,
        kind: "option",
        answer: option.label,
        ...(option.preview && option.preview.length > 0 ? { preview: option.preview } : {}),
        ...(notes ? { notes } : {}),
      });
      continue;
    }

    // An option answer whose label is no longer offered (or none at all) still
    // carries the note. The extension's own vocabulary covers this: an empty
    // custom answer is `kind: "custom"` with `answer: null`, and the envelope
    // renders it as `(no input)` next to the note.
    if (notes) {
      answers.push({
        questionIndex: index,
        question: question.question,
        kind: "custom",
        answer: null,
        notes,
      });
    }
  }

  const globalNote = draft.globalNote.trim().length > 0 ? draft.globalNote : undefined;
  return {
    answers,
    cancelled: false,
    ...(globalNote ? { globalNote } : {}),
  };
}

/** The result for "the user declined" — the extension's canonical DECLINE path. */
export function cancelledQuestionnaireResult(): QuestionnaireResult {
  return { answers: [], cancelled: true };
}

/** One-line answer summary for the review tab. */
export function describeQuestionnaireAnswer(
  draft: QuestionnaireDraft,
  questionIndex: number,
): string {
  const answer = draft.answers[questionIndex];
  if (!answer) return "";
  if (answer.kind === "multi") return answer.selected.join(", ");
  return answer.answer ?? "";
}

// ---------------------------------------------------------------------------
// Server-side sanitising
// ---------------------------------------------------------------------------

function sanitizeNote(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Re-validate what the browser sent before it reaches the extension. The
 * browser is the only writer of this payload and it is not a security boundary
 * the way a file path is, but a stale or half-written result must not put an
 * option label the model never offered into the transcript — so every answer is
 * re-checked against the question it claims to answer.
 */
export function sanitizeQuestionnaireResult(
  value: unknown,
  questions: readonly QuestionnaireQuestion[],
): QuestionnaireResult {
  const record = asRecord(value);
  if (!record) return cancelledQuestionnaireResult();

  const globalNote = sanitizeNote(record.globalNote);
  if (record.cancelled === true) {
    return {
      answers: [],
      cancelled: true,
      ...(globalNote ? { globalNote } : {}),
    };
  }

  const rawAnswers = Array.isArray(record.answers) ? record.answers : [];
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const raw of rawAnswers) {
    const answer = asRecord(raw);
    if (!answer) continue;
    const index = typeof answer.questionIndex === "number" ? answer.questionIndex : Number.NaN;
    if (!Number.isInteger(index) || index < 0 || index >= questions.length) continue;
    if (byIndex.has(index)) continue;
    byIndex.set(index, answer);
  }

  const answers: QuestionnaireAnswer[] = [];
  for (let index = 0; index < questions.length; index += 1) {
    const raw = byIndex.get(index);
    if (!raw) continue;
    const question = questions[index];
    const notes = sanitizeNote(raw.notes);

    if (raw.kind === "multi") {
      const rawSelected = Array.isArray(raw.selected) ? raw.selected : [];
      const selected = question.options
        .map((option) => option.label)
        .filter((label) => rawSelected.includes(label));
      if (selected.length === 0 && !notes) continue;
      answers.push({
        questionIndex: index,
        question: question.question,
        kind: "multi",
        answer: null,
        selected,
        ...(notes ? { notes } : {}),
      });
      continue;
    }

    const text = typeof raw.answer === "string" ? raw.answer : "";
    if (raw.kind === "custom") {
      if (text.trim().length === 0 && !notes) continue;
      answers.push({
        questionIndex: index,
        question: question.question,
        kind: "custom",
        answer: text.trim().length > 0 ? text : null,
        ...(notes ? { notes } : {}),
      });
      continue;
    }

    const option = question.options.find((entry) => entry.label === text);
    if (option) {
      answers.push({
        questionIndex: index,
        question: question.question,
        kind: "option",
        answer: option.label,
        ...(option.preview && option.preview.length > 0 ? { preview: option.preview } : {}),
        ...(notes ? { notes } : {}),
      });
      continue;
    }

    // Unknown/absent label: keep the note, drop the label the model never offered.
    if (notes) {
      answers.push({
        questionIndex: index,
        question: question.question,
        kind: "custom",
        answer: null,
        notes,
      });
    }
  }

  if (answers.length === 0 && !globalNote) return cancelledQuestionnaireResult();
  return {
    answers,
    cancelled: false,
    ...(globalNote ? { globalNote } : {}),
  };
}
