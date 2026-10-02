"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { MarkdownBody } from "./MarkdownBody";
import styles from "./QuestionnairePanel.module.css";
import {
  buildQuestionnaireResult,
  cancelledQuestionnaireResult,
  describeQuestionnaireAnswer,
  emptyQuestionnaireDraft,
  isQuestionnaireAnswered,
  QUESTIONNAIRE_OTHER_LABEL,
  selectQuestionnaireOption,
  setQuestionnaireAnswerNote,
  setQuestionnaireCustomAnswer,
  setQuestionnaireGlobalNote,
  toggleQuestionnaireOption,
  type QuestionnaireDraft,
  type QuestionnaireQuestion,
  type QuestionnaireResult,
} from "@/lib/questionnaire";

export interface QuestionnairePanelProps {
  questions: QuestionnaireQuestion[];
  onSubmit: (result: QuestionnaireResult) => void;
}

/**
 * Native replacement for the rpiv extension's terminal questionnaire. The
 * extension still owns validation and the LLM envelope; this component only
 * renders the questions the tool call carried and hands back a
 * `QuestionnaireResult` shaped exactly like the one its TUI produces.
 */
export function QuestionnairePanel({ questions, onSubmit }: QuestionnairePanelProps) {
  const { t } = useI18n();
  const [activeIndex, setActiveIndex] = useState(0);
  const [draft, setDraft] = useState<QuestionnaireDraft>(emptyQuestionnaireDraft);
  const [openNotes, setOpenNotes] = useState<Record<number, boolean>>({});
  const [previewIndex, setPreviewIndex] = useState<Record<number, number>>({});
  const dialogRef = useRef<HTMLDivElement>(null);
  const reviewIndex = questions.length;
  const singleQuestion = questions.length === 1;

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const cancel = useCallback(() => {
    onSubmit(cancelledQuestionnaireResult());
  }, [onSubmit]);

  const submit = useCallback(() => {
    onSubmit(buildQuestionnaireResult(draft, questions));
  }, [draft, onSubmit, questions]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [cancel]);

  const primaryAction = useCallback(() => {
    if (singleQuestion || activeIndex >= reviewIndex) {
      submit();
      return;
    }
    setActiveIndex((current) => (current >= questions.length - 1 ? reviewIndex : current + 1));
  }, [activeIndex, questions.length, reviewIndex, singleQuestion, submit]);

  const answeredCount = useMemo(
    () => questions.filter((_, index) => isQuestionnaireAnswered(draft, index)).length,
    [draft, questions],
  );

  const renderQuestion = (index: number) => {
    const question = questions[index];
    const answer = draft.answers[index];
    const custom = answer?.kind === "custom";
    const selectedLabels = answer?.kind === "multi" ? answer.selected : [];
    const chosenLabel = answer?.kind === "option" ? answer.answer : null;
    const previewOption = pickPreviewOption(question, previewIndex[index]);

    return (
      <>
        <div className={styles.questionHead}>
          {question.header && <span className={styles.chip}>{question.header}</span>}
          {question.multiSelect && (
            <span className={styles.multiHint}>{t("questionnaire.multiSelectHint")}</span>
          )}
        </div>
        <p className={styles.questionText}>{question.question}</p>

        <div className={styles.optionsLayout}>
          <div className={styles.options}>
            {question.options.map((option, optionIndex) => {
              const active = question.multiSelect
                ? selectedLabels.includes(option.label)
                : chosenLabel === option.label;
              return (
                <button
                  key={option.label}
                  type="button"
                  className={`${styles.option}${active ? ` ${styles.optionActive}` : ""}`}
                  aria-pressed={active}
                  onMouseEnter={() => setPreviewIndex((current) => ({ ...current, [index]: optionIndex }))}
                  onFocus={() => setPreviewIndex((current) => ({ ...current, [index]: optionIndex }))}
                  onClick={() => setDraft((current) => (
                    question.multiSelect
                      ? toggleQuestionnaireOption(current, index, option.label)
                      : selectQuestionnaireOption(current, index, option.label)
                  ))}
                >
                  <span
                    className={`${styles.marker} ${question.multiSelect ? styles.markerCheck : styles.markerRadio}${active ? ` ${styles.markerOn}` : ""}`}
                    aria-hidden="true"
                  >
                    {active ? "✓" : ""}
                  </span>
                  <div className={styles.optionBody}>
                    <div className={styles.optionLabel}>
                      {option.label}
                      {option.preview && (
                        <span className={styles.optionPreviewFlag}>{t("questionnaire.previewFlag")}</span>
                      )}
                    </div>
                    {option.description && (
                      <div className={styles.optionDescription}>{option.description}</div>
                    )}
                  </div>
                </button>
              );
            })}

            <button
              type="button"
              className={`${styles.option} ${styles.sentinel}`}
              aria-pressed={custom}
              onClick={() => setDraft((current) => setQuestionnaireCustomAnswer(
                current,
                index,
                current.answers[index]?.kind === "custom" ? current.answers[index]?.answer ?? "" : "",
              ))}
            >
              <span className={`${styles.marker} ${styles.markerRadio}`} aria-hidden="true">
                {custom ? "✓" : ""}
              </span>
              <div className={styles.optionBody}>
                <div className={styles.optionLabel}>{QUESTIONNAIRE_OTHER_LABEL}</div>
              </div>
            </button>

            {custom && (
              <div className={styles.customRow}>
                <textarea
                  className={styles.textarea}
                  autoFocus
                  value={answer?.answer ?? ""}
                  aria-label={QUESTIONNAIRE_OTHER_LABEL}
                  placeholder={t("questionnaire.typePlaceholder")}
                  onChange={(event) => setDraft((current) => (
                    setQuestionnaireCustomAnswer(current, index, event.target.value)
                  ))}
                />
              </div>
            )}
          </div>

          {previewOption && (
            <div className={styles.preview}>
              <div className={styles.previewTitle}>{t("questionnaire.preview")}</div>
              <div className={styles.previewBody}>
                {previewOption.preview
                  ? <MarkdownBody>{previewOption.preview}</MarkdownBody>
                  : <span className={styles.previewEmpty}>{t("questionnaire.previewEmpty")}</span>}
              </div>
            </div>
          )}
        </div>

        <div className={styles.noteBar}>
          <button
            type="button"
            className={styles.noteToggle}
            onClick={() => setOpenNotes((current) => ({ ...current, [index]: !current[index] }))}
          >
            {openNotes[index] ? t("questionnaire.hideNote") : t("questionnaire.addNote")}
          </button>
        </div>
        {openNotes[index] && (
          <textarea
            className={styles.textarea}
            value={answer?.notes ?? ""}
            aria-label={t("questionnaire.notePlaceholder")}
            placeholder={t("questionnaire.notePlaceholder")}
            onChange={(event) => setDraft((current) => (
              setQuestionnaireAnswerNote(current, index, event.target.value)
            ))}
          />
        )}
      </>
    );
  };

  const renderReview = () => (
    <>
      <div className={styles.questionHead}>
        <span className={styles.chip}>{t("questionnaire.review")}</span>
      </div>
      <p className={styles.questionText}>{t("questionnaire.reviewHint")}</p>
      <div className={styles.reviewList}>
        {questions.map((question, index) => {
          const described = describeQuestionnaireAnswer(draft, index);
          const notes = draft.answers[index]?.notes;
          return (
            <div className={styles.reviewItem} key={`${index}-${question.question}`}>
              <div className={styles.reviewQuestion}>{question.header || question.question}</div>
              <div className={styles.reviewAnswer}>
                {described || <span className={styles.reviewEmpty}>{t("questionnaire.unanswered")}</span>}
              </div>
              {notes && notes.trim().length > 0 && <div className={styles.reviewNote}>{notes}</div>}
            </div>
          );
        })}
      </div>
      <div className={styles.globalNoteBlock}>
        <textarea
          className={styles.textarea}
          value={draft.globalNote}
          aria-label={t("questionnaire.globalNote")}
          placeholder={t("questionnaire.globalNotePlaceholder")}
          onChange={(event) => setDraft((current) => setQuestionnaireGlobalNote(current, event.target.value))}
        />
      </div>
    </>
  );

  const primaryLabel = singleQuestion || activeIndex >= reviewIndex
    ? t("questionnaire.submit")
    : activeIndex >= questions.length - 1
      ? t("questionnaire.review")
      : t("questionnaire.next");

  return (
    <div className={styles.overlay}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("questionnaire.title")}
        tabIndex={-1}
        className={styles.dialog}
      >
        <div className={styles.header}>
          <div className={styles.title}>
            <span>{t("questionnaire.title")}</span>
            <span className={styles.badge}>
              {t("questionnaire.progress", { answered: answeredCount, total: questions.length })}
            </span>
          </div>
          <button type="button" className={styles.button} onClick={cancel}>
            {t("questionnaire.cancel")}
          </button>
        </div>

        {!singleQuestion && (
          <div className={styles.tabs} role="tablist">
            {questions.map((question, index) => (
              <button
                key={`${index}-${question.header}`}
                type="button"
                role="tab"
                aria-selected={activeIndex === index}
                className={`${styles.tab}${activeIndex === index ? ` ${styles.tabActive}` : ""}`}
                onClick={() => setActiveIndex(index)}
              >
                {isQuestionnaireAnswered(draft, index) && <span className={styles.tabDot} aria-hidden="true" />}
                <span>{question.header || t("questionnaire.questionNumber", { number: index + 1 })}</span>
              </button>
            ))}
            <button
              type="button"
              role="tab"
              aria-selected={activeIndex === reviewIndex}
              className={`${styles.tab}${activeIndex === reviewIndex ? ` ${styles.tabActive}` : ""}`}
              onClick={() => setActiveIndex(reviewIndex)}
            >
              <span>{t("questionnaire.review")}</span>
            </button>
          </div>
        )}

        <div className={styles.body}>
          {activeIndex >= reviewIndex ? renderReview() : renderQuestion(activeIndex)}
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.button} onClick={cancel}>
            {t("questionnaire.cancel")}
          </button>
          <div className={styles.footerGroup}>
            {!singleQuestion && activeIndex > 0 && (
              <button
                type="button"
                className={styles.button}
                onClick={() => setActiveIndex((current) => current - 1)}
              >
                {t("questionnaire.back")}
              </button>
            )}
            <button
              type="button"
              className={`${styles.button} ${styles.buttonPrimary}`}
              onClick={primaryAction}
            >
              {primaryLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Which option's preview the pane shows. The hovered/focused option wins, but a
 * question whose previews only live on some options falls back to the first one
 * that has any, so the pane is never blank while previews exist.
 */
function pickPreviewOption(question: QuestionnaireQuestion, requestedIndex: number | undefined) {
  if (!question.options.some((option) => (option.preview?.length ?? 0) > 0)) return undefined;
  const requested = requestedIndex === undefined ? undefined : question.options[requestedIndex];
  if (requested?.preview) return requested;
  return question.options.find((option) => (option.preview?.length ?? 0) > 0);
}
