/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_CLAUDE_PROVIDER: Tests for the channel-2 (transcript-tail)
 * turn-completion detector's pure core, `scanTranscriptDelta`. This is the
 * redundant JSONL channel that recovers turns where Claude's Stop hook was
 * silently dropped, and that redundantly surfaces AskUserQuestion prompts.
 */

import { describe, it, expect } from 'vitest';
import { scanTranscriptDelta } from './claudeCLIDriver.js';

// ─── JSONL entry factories (match real Claude transcript shapes) ──────────────

const textBlock = (text: string) => ({ type: 'text', text });
const thinkingBlock = (thinking: string) => ({ type: 'thinking', thinking });
const toolUseBlock = (id: string, name: string) => ({
  type: 'tool_use',
  id,
  name,
  input: {},
});
const askQuestionBlock = (id: string) => ({
  type: 'tool_use',
  id,
  name: 'AskUserQuestion',
  input: {
    questions: [
      {
        question: 'Pick one',
        header: 'Q',
        multiSelect: false,
        options: [{ label: 'A' }, { label: 'B' }],
      },
    ],
  },
});

const assistantLine = (
  stopReason: string,
  blocks: unknown[],
  extra: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_1',
      role: 'assistant',
      stop_reason: stopReason,
      content: blocks,
    },
    ...extra,
  });

const userToolResult = (
  toolUseId: string,
  output = 'ok',
  extra: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: output },
      ],
    },
    ...extra,
  });

const metaLine = (type: string): string => JSON.stringify({ type });

// ─── tests ────────────────────────────────────────────────────────────────────

describe('scanTranscriptDelta', () => {
  it('reports end_turn from a non-sidechain assistant entry', () => {
    const r = scanTranscriptDelta([
      assistantLine('end_turn', [textBlock('done')]),
    ]);
    expect(r.lastStopReason).toBe('end_turn');
    expect(r.askUserQuestions).toEqual([]);
    expect(r.toolResultIds).toEqual([]);
  });

  it('reports tool_use (non-terminal) and the latest reason wins', () => {
    const r = scanTranscriptDelta([
      assistantLine('tool_use', [toolUseBlock('t1', 'Bash')]),
      userToolResult('t1'),
      assistantLine('end_turn', [textBlock('final')]),
    ]);
    expect(r.lastStopReason).toBe('end_turn');
    expect(r.toolResultIds).toEqual(['t1']);
    expect(r.toolUseIds).toEqual(['t1']);
  });

  it('separates regular tool_use ids from AskUserQuestion (for channel-3 open-tool guard)', () => {
    const r = scanTranscriptDelta([
      assistantLine('tool_use', [
        toolUseBlock('t-bash', 'Bash'),
        askQuestionBlock('t-ask'),
      ]),
    ]);
    // AskUserQuestion is gated by pendingPrompts, NOT counted as an open tool.
    expect(r.toolUseIds).toEqual(['t-bash']);
    expect(r.askUserQuestions.map((a) => a.toolUseId)).toEqual(['t-ask']);
  });

  it('ignores sidechain (sub-agent) entries — their end_turn must not count', () => {
    const r = scanTranscriptDelta([
      assistantLine('end_turn', [textBlock('subagent done')], {
        isSidechain: true,
      }),
      assistantLine('tool_use', [toolUseBlock('t2', 'Read')]),
    ]);
    // The sub-agent's end_turn is skipped; the main turn is still tool_use.
    expect(r.lastStopReason).toBe('tool_use');
  });

  it('ignores metadata entry types (allowlist assistant/user only)', () => {
    const r = scanTranscriptDelta([
      metaLine('ai-title'),
      metaLine('last-prompt'),
      metaLine('mode'),
      metaLine('permission-mode'),
      metaLine('file-history-snapshot'),
      metaLine('queue-operation'),
      metaLine('attachment'),
      JSON.stringify({ type: 'system', subtype: 'status' }),
      assistantLine('end_turn', [textBlock('done')]),
    ]);
    expect(r.lastStopReason).toBe('end_turn');
  });

  it('handles a multi-line response (thinking then text, same stop_reason)', () => {
    const r = scanTranscriptDelta([
      assistantLine('end_turn', [thinkingBlock('hmm')]),
      assistantLine('end_turn', [textBlock('answer')]),
    ]);
    expect(r.lastStopReason).toBe('end_turn');
  });

  it('detects AskUserQuestion tool_use and surfaces its id + input', () => {
    const r = scanTranscriptDelta([
      assistantLine('tool_use', [askQuestionBlock('toolu_ask')]),
    ]);
    expect(r.askUserQuestions).toHaveLength(1);
    expect(r.askUserQuestions[0].toolUseId).toBe('toolu_ask');
    // A pending question is NOT terminal — the turn keeps waiting.
    expect(r.lastStopReason).toBe('tool_use');
    const input = r.askUserQuestions[0].input as { questions: unknown[] };
    expect(Array.isArray(input.questions)).toBe(true);
    expect(input.questions).toHaveLength(1);
  });

  it('does NOT surface AskUserQuestion from a sidechain entry', () => {
    const r = scanTranscriptDelta([
      assistantLine('tool_use', [askQuestionBlock('toolu_sub')], {
        isSidechain: true,
      }),
    ]);
    expect(r.askUserQuestions).toEqual([]);
  });

  it('collects tool_result ids for AskUserQuestion resolution tracking', () => {
    const r = scanTranscriptDelta([
      userToolResult('toolu_ask'),
      userToolResult('toolu_other'),
    ]);
    expect(r.toolResultIds).toEqual(['toolu_ask', 'toolu_other']);
  });

  it('skips blank lines and invalid JSON gracefully', () => {
    const r = scanTranscriptDelta([
      '',
      '   ',
      'not json',
      '{bad',
      assistantLine('end_turn', [textBlock('ok')]),
    ]);
    expect(r.lastStopReason).toBe('end_turn');
  });

  it('recognizes stop_sequence and max_tokens as stop reasons', () => {
    expect(
      scanTranscriptDelta([assistantLine('stop_sequence', [textBlock('x')])])
        .lastStopReason,
    ).toBe('stop_sequence');
    expect(
      scanTranscriptDelta([assistantLine('max_tokens', [textBlock('x')])])
        .lastStopReason,
    ).toBe('max_tokens');
  });

  it('returns undefined stop_reason when there are no assistant entries', () => {
    const r = scanTranscriptDelta([metaLine('ai-title'), userToolResult('t1')]);
    expect(r.lastStopReason).toBeUndefined();
    expect(r.toolResultIds).toEqual(['t1']);
  });
});
