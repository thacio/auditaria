/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_CLAUDE_PROVIDER: Pure translators between Claude's
 * InteractivePromptStartEvent shape and Gemini's AskUserDialog shapes.
 * Extracted from the hook so they can be unit-tested without dragging in
 * ink / AskUserDialog / UI types at module-load time.
 */

import {
  QuestionType,
  type Question,
  type InteractivePromptStartEvent,
  type InteractivePromptAnswer,
} from '@google/gemini-cli-core';

/**
 * Translate Claude's structured question/options into the Gemini
 * Question shape that AskUserDialog accepts.
 */
export function toGeminiQuestions(
  event: InteractivePromptStartEvent,
): Question[] {
  return event.questions.map((q) => ({
    question: q.question,
    header: q.header ?? q.question,
    type: QuestionType.CHOICE,
    options: q.options.map((o) => ({
      label: o.label,
      description: o.description ?? '',
    })),
    multiSelect: q.multiSelect ?? false,
  }));
}

/**
 * Convert AskUserDialog's `{ [idx]: answerString }` shape back to our
 * InteractivePromptAnswer[]. The answer string is the option's `label`
 * (or comma-separated labels for multiSelect, or free-form text for
 * "Other"). We match by label; anything that doesn't match becomes
 * `customText`.
 */
export function buildPromptAnswers(
  event: InteractivePromptStartEvent,
  raw: { [questionIndex: string]: string },
): InteractivePromptAnswer[] {
  const out: InteractivePromptAnswer[] = [];
  for (let i = 0; i < event.questions.length; i++) {
    const q = event.questions[i];
    const answerStr = raw[String(i)];
    if (answerStr === undefined) continue;
    const wantsMulti = q.multiSelect && answerStr.includes(',');
    const labels = wantsMulti
      ? answerStr
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [answerStr.trim()];
    const optionIds: string[] = [];
    let customText: string | undefined;
    for (const label of labels) {
      const match = q.options.find(
        (o) => o.label.toLowerCase() === label.toLowerCase(),
      );
      if (match) optionIds.push(match.id);
      else customText = label; // free-form fallback
    }
    out.push({
      questionId: q.id,
      optionIds,
      customText,
    });
  }
  return out;
}
