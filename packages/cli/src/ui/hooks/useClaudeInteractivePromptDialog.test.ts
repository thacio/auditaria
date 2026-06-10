/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure-function tests for the question/answer translators used by the
 * Phase-1 AskUserQuestion modal bridge. Validates the round-trip from
 * Claude's InteractivePromptStartEvent shape to Gemini's Question[] and
 * back from AskUserDialog's `{ [idx]: answerString }` shape to
 * InteractivePromptAnswer[].
 */

import { describe, it, expect, vi } from 'vitest';

// AUDITARIA: Mock the core package to its enums-only surface so the
// browser-agent transitive import doesn't fail at module-load time.
vi.mock('@google/gemini-cli-core', () => ({
  QuestionType: { CHOICE: 'choice', TEXT: 'text', YESNO: 'yesno' },
  ProviderEventType: {
    Content: 'content',
    InteractivePromptStart: 'interactive_prompt_start',
    InteractivePromptResolved: 'interactive_prompt_resolved',
  },
}));

import {
  ProviderEventType,
  QuestionType,
  type InteractivePromptStartEvent,
} from '@google/gemini-cli-core';
import {
  toGeminiQuestions,
  buildPromptAnswers,
} from './claudeInteractivePromptTranslators.js';

function makeEvent(
  overrides: Partial<InteractivePromptStartEvent> = {},
): InteractivePromptStartEvent {
  return {
    type: ProviderEventType.InteractivePromptStart,
    promptId: 'toolu_test',
    kind: 'ask-user',
    title: 'Test',
    toolName: 'AskUserQuestion',
    questions: [
      {
        id: 'Q1',
        question: 'Pick a color',
        header: 'Color',
        options: [
          { id: 'Red', label: 'Red', description: 'The color red' },
          { id: 'Green', label: 'Green', description: 'The color green' },
          { id: 'Blue', label: 'Blue', description: 'The color blue' },
        ],
        multiSelect: false,
      },
    ],
    ...overrides,
  };
}

describe('toGeminiQuestions', () => {
  it('maps single-question CHOICE with options and descriptions', () => {
    const event = makeEvent();
    const result = toGeminiQuestions(event);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      question: 'Pick a color',
      header: 'Color',
      type: QuestionType.CHOICE,
      options: [
        { label: 'Red', description: 'The color red' },
        { label: 'Green', description: 'The color green' },
        { label: 'Blue', description: 'The color blue' },
      ],
      multiSelect: false,
    });
  });

  it('falls back to question text when header is undefined', () => {
    const event = makeEvent({
      questions: [
        {
          id: 'Q1',
          question: 'Plain question',
          options: [{ id: 'a', label: 'A' }],
        },
      ],
    });
    const result = toGeminiQuestions(event);
    expect(result[0].header).toBe('Plain question');
  });

  it('fills empty description when source has none', () => {
    const event = makeEvent({
      questions: [
        {
          id: 'Q1',
          question: 'Q',
          options: [{ id: 'a', label: 'A' }],
        },
      ],
    });
    const result = toGeminiQuestions(event);
    expect(result[0].options).toEqual([{ label: 'A', description: '' }]);
  });

  it('preserves multiSelect=true', () => {
    const event = makeEvent({
      questions: [
        {
          id: 'Q1',
          question: 'Q',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
          multiSelect: true,
        },
      ],
    });
    const result = toGeminiQuestions(event);
    expect(result[0].multiSelect).toBe(true);
  });

  it('preserves multiple questions in order', () => {
    const event = makeEvent({
      questions: [
        {
          id: 'Q1',
          question: 'Color?',
          options: [{ id: 'r', label: 'Red' }],
        },
        {
          id: 'Q2',
          question: 'Size?',
          options: [{ id: 's', label: 'Small' }],
        },
      ],
    });
    const result = toGeminiQuestions(event);
    expect(result).toHaveLength(2);
    expect(result[0].question).toBe('Color?');
    expect(result[1].question).toBe('Size?');
  });
});

describe('buildPromptAnswers', () => {
  it('matches single-select by label and returns optionIds', () => {
    const event = makeEvent();
    const out = buildPromptAnswers(event, { 0: 'Blue' });
    expect(out).toEqual([
      { questionId: 'Q1', optionIds: ['Blue'], customText: undefined },
    ]);
  });

  it('matches case-insensitively', () => {
    const event = makeEvent();
    const out = buildPromptAnswers(event, { 0: 'bLuE' });
    expect(out[0].optionIds).toEqual(['Blue']);
    expect(out[0].customText).toBeUndefined();
  });

  it('trims whitespace from answer strings', () => {
    const event = makeEvent();
    const out = buildPromptAnswers(event, { 0: '  Blue  ' });
    expect(out[0].optionIds).toEqual(['Blue']);
  });

  it('falls back to customText when label does not match', () => {
    const event = makeEvent();
    const out = buildPromptAnswers(event, { 0: 'Magenta' });
    expect(out[0].optionIds).toEqual([]);
    expect(out[0].customText).toBe('Magenta');
  });

  it('handles multiSelect comma-split with all matching labels', () => {
    const event = makeEvent({
      questions: [
        {
          id: 'Q1',
          question: 'Pick colors',
          options: [
            { id: 'r', label: 'Red' },
            { id: 'g', label: 'Green' },
            { id: 'b', label: 'Blue' },
          ],
          multiSelect: true,
        },
      ],
    });
    const out = buildPromptAnswers(event, { 0: 'Red,Blue' });
    expect(out[0].optionIds).toEqual(['r', 'b']);
    expect(out[0].customText).toBeUndefined();
  });

  it('handles multiSelect with one unmatched as customText fallback', () => {
    const event = makeEvent({
      questions: [
        {
          id: 'Q1',
          question: 'Pick',
          options: [{ id: 'r', label: 'Red' }],
          multiSelect: true,
        },
      ],
    });
    const out = buildPromptAnswers(event, { 0: 'Red, Purple' });
    expect(out[0].optionIds).toEqual(['r']);
    expect(out[0].customText).toBe('Purple');
  });

  it('does NOT split single-select answer on commas', () => {
    // A choice-mode answer that happens to contain a comma in its label
    // must stay intact — only multiSelect questions split on commas.
    const event = makeEvent({
      questions: [
        {
          id: 'Q1',
          question: 'Pick',
          options: [
            { id: 'phrase', label: 'Rain, fog, and snow' },
            { id: 'sun', label: 'Sunny' },
          ],
        },
      ],
    });
    const out = buildPromptAnswers(event, { 0: 'Rain, fog, and snow' });
    expect(out[0].optionIds).toEqual(['phrase']);
    expect(out[0].customText).toBeUndefined();
  });

  it('omits questions missing from the raw answers map', () => {
    const event = makeEvent({
      questions: [
        { id: 'Q1', question: 'A', options: [{ id: 'x', label: 'X' }] },
        { id: 'Q2', question: 'B', options: [{ id: 'y', label: 'Y' }] },
      ],
    });
    const out = buildPromptAnswers(event, { 0: 'X' });
    expect(out).toHaveLength(1);
    expect(out[0].questionId).toBe('Q1');
  });

  it('maps multi-question answers preserving order and questionIds', () => {
    const event = makeEvent({
      questions: [
        {
          id: 'colorQ',
          question: 'Color?',
          options: [
            { id: 'r', label: 'Red' },
            { id: 'b', label: 'Blue' },
          ],
        },
        {
          id: 'sizeQ',
          question: 'Size?',
          options: [
            { id: 'sm', label: 'Small' },
            { id: 'md', label: 'Medium' },
          ],
        },
      ],
    });
    const out = buildPromptAnswers(event, { 0: 'Blue', 1: 'Medium' });
    expect(out).toEqual([
      { questionId: 'colorQ', optionIds: ['b'], customText: undefined },
      { questionId: 'sizeQ', optionIds: ['md'], customText: undefined },
    ]);
  });

  it('treats empty multiSelect string as a single empty answer (no match)', () => {
    const event = makeEvent({
      questions: [
        {
          id: 'Q1',
          question: 'Q',
          options: [{ id: 'a', label: 'A' }],
          multiSelect: true,
        },
      ],
    });
    const out = buildPromptAnswers(event, { 0: '' });
    expect(out[0].optionIds).toEqual([]);
    expect(out[0].customText).toBe('');
  });
});
