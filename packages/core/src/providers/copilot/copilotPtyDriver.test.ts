/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_COPILOT_PROVIDER + AUDITARIA_PROVIDER_TERMINAL: Unit tests for
 * the pure parts of the interactive Copilot PTY driver — the events.jsonl
 * turn tracker (turn-completion semantics validated live against Copilot
 * CLI 1.0.67) and the spawn-args builder.
 */

import { describe, it, expect } from 'vitest';
import { CopilotTurnTracker, buildCopilotPtyArgs } from './copilotPtyDriver.js';
import { ProviderEventType } from '../types.js';

// ─── fixtures ────────────────────────────────────────────────────────────────

function ev(type: string, data: Record<string, unknown> = {}) {
  return { type, data };
}

const NOW = 1_000_000;

// ─── CopilotTurnTracker ──────────────────────────────────────────────────────

describe('CopilotTurnTracker', () => {
  it('marks promptAccepted on user.message and emits nothing for it', () => {
    const t = new CopilotTurnTracker();
    const events = t.ingest([ev('user.message', { content: 'hi' })], NOW);
    expect(events).toEqual([]);
    expect(t.promptAccepted).toBe(true);
  });

  it('simple text turn: ModelInfo + Content, then final turn_end sets the completion candidate', () => {
    const t = new CopilotTurnTracker();
    const events = t.ingest(
      [
        ev('user.message', { content: 'hi' }),
        ev('assistant.turn_start', { turnId: '0' }),
        ev('assistant.message', {
          model: 'claude-sonnet-4.6',
          content: 'Hello!',
          toolRequests: [],
          outputTokens: 12,
        }),
        ev('assistant.turn_end', { turnId: '0' }),
      ],
      NOW,
    );
    expect(events).toEqual([
      { type: ProviderEventType.ModelInfo, model: 'claude-sonnet-4.6' },
      { type: ProviderEventType.Content, text: 'Hello!' },
    ]);
    expect(t.completionCandidateAt).toBe(NOW);
    expect(t.getUsage()).toEqual({ outputTokens: 12 });
  });

  it('turn_end after a tool-requesting message is NOT final (agentic continuation)', () => {
    const t = new CopilotTurnTracker();
    t.ingest(
      [
        ev('assistant.turn_start', { turnId: '0' }),
        ev('assistant.message', {
          model: 'gpt-5.4',
          content: 'Creating the file…',
          toolRequests: [{ name: 'create' }],
        }),
        ev('tool.execution_start', {
          toolCallId: 't1',
          toolName: 'create',
          arguments: { path: 'x.txt' },
        }),
        ev('tool.execution_complete', {
          toolCallId: 't1',
          success: true,
          result: { content: 'Created file x.txt' },
        }),
        ev('assistant.turn_end', { turnId: '0' }),
      ],
      NOW,
    );
    expect(t.completionCandidateAt).toBeUndefined();

    // Next inference step arrives, ends with a text-only message → final.
    t.ingest(
      [
        ev('assistant.turn_start', { turnId: '1' }),
        ev('assistant.message', {
          model: 'gpt-5.4',
          content: 'DONE alpha',
          toolRequests: [],
        }),
        ev('assistant.turn_end', { turnId: '1' }),
      ],
      NOW + 500,
    );
    expect(t.completionCandidateAt).toBe(NOW + 500);
  });

  it('a new turn_start clears a stale completion candidate', () => {
    const t = new CopilotTurnTracker();
    t.ingest(
      [
        ev('assistant.message', { content: 'ok', toolRequests: [] }),
        ev('assistant.turn_end', {}),
      ],
      NOW,
    );
    expect(t.completionCandidateAt).toBe(NOW);
    t.ingest([ev('assistant.turn_start', { turnId: '1' })], NOW + 100);
    expect(t.completionCandidateAt).toBeUndefined();
  });

  it('turn_end while a tool is still open is not final', () => {
    const t = new CopilotTurnTracker();
    t.ingest(
      [
        ev('assistant.message', { content: '', toolRequests: [] }),
        ev('tool.execution_start', { toolCallId: 't9', toolName: 'shell' }),
        ev('assistant.turn_end', {}),
      ],
      NOW,
    );
    expect(t.completionCandidateAt).toBeUndefined();
  });

  it('ask_user surfaces InteractivePromptStart and resolves on completion', () => {
    const t = new CopilotTurnTracker();
    const startEvents = t.ingest(
      [
        ev('tool.execution_start', {
          toolCallId: 'ask-1',
          toolName: 'ask_user',
          arguments: {
            question: 'Which color do you prefer?',
            choices: ['red', 'green', 'blue'],
            allow_freeform: false,
          },
        }),
      ],
      NOW,
    );
    const prompt = startEvents.find(
      (e) => e.type === ProviderEventType.InteractivePromptStart,
    );
    expect(prompt).toBeDefined();
    if (prompt?.type !== ProviderEventType.InteractivePromptStart) {
      throw new Error('unreachable');
    }
    expect(prompt.promptId).toBe('ask-1');
    expect(prompt.kind).toBe('ask-user');
    expect(prompt.title).toBe('Which color do you prefer?');
    expect(prompt.toolName).toBe('ask_user');
    expect(prompt.questions[0].options.map((o) => o.id)).toEqual([
      'red',
      'green',
      'blue',
    ]);
    // The picker blocks the turn while open.
    expect(t.hasOpenTools()).toBe(true);

    const doneEvents = t.ingest(
      [
        ev('tool.execution_complete', {
          toolCallId: 'ask-1',
          success: true,
          result: { content: 'User selected: green' },
        }),
      ],
      NOW + 1000,
    );
    expect(doneEvents).toContainEqual({
      type: ProviderEventType.InteractivePromptResolved,
      promptId: 'ask-1',
      response: { kind: 'answered', answers: [] },
    });
    expect(t.hasOpenTools()).toBe(false);
  });

  it('maps tool events to ToolUse/ToolResult with args, output, and isError', () => {
    const t = new CopilotTurnTracker();
    const events = t.ingest(
      [
        ev('tool.execution_start', {
          toolCallId: 'call-1',
          toolName: 'shell',
          arguments: { command: 'echo hi' },
        }),
        ev('tool.execution_complete', {
          toolCallId: 'call-1',
          success: false,
          result: { content: 'boom' },
        }),
      ],
      NOW,
    );
    expect(events).toEqual([
      {
        type: ProviderEventType.ToolUse,
        toolName: 'shell',
        toolId: 'call-1',
        input: { command: 'echo hi' },
      },
      {
        type: ProviderEventType.ToolResult,
        toolId: 'call-1',
        output: 'boom',
        isError: true,
      },
    ]);
  });

  it('emits ModelInfo only once and Thinking for readable reasoning', () => {
    const t = new CopilotTurnTracker();
    const events = t.ingest(
      [
        ev('assistant.message', {
          model: 'claude-sonnet-4.6',
          reasoning: 'pondering…',
          content: 'a',
        }),
        ev('assistant.message', { model: 'claude-sonnet-4.6', content: 'b' }),
      ],
      NOW,
    );
    const modelInfos = events.filter(
      (e) => e.type === ProviderEventType.ModelInfo,
    );
    expect(modelInfos).toHaveLength(1);
    expect(events).toContainEqual({
      type: ProviderEventType.Thinking,
      text: 'pondering…',
    });
    expect(t.getAccumulatedText()).toBe('a\nb');
  });

  it('manual /compact: compaction_complete emits Compacted(manual) and ends the turn', () => {
    const t = new CopilotTurnTracker(true);
    const events = t.ingest(
      [
        ev('session.compaction_start', { conversationTokens: 359 }),
        ev('session.compaction_complete', {
          success: true,
          preCompactionTokens: 362,
          postCompactionTokens: 120,
        }),
      ],
      NOW,
    );
    expect(events).toEqual([
      { type: ProviderEventType.Compacted, preTokens: 362, trigger: 'manual' },
    ]);
    expect(t.compactionSucceeded).toBe(true);
    expect(t.completionCandidateAt).toBe(NOW);
  });

  it('auto-compaction mid-turn emits Compacted(auto) without ending the turn', () => {
    const t = new CopilotTurnTracker();
    const events = t.ingest(
      [
        ev('session.compaction_complete', {
          success: true,
          preCompactionTokens: 9000,
        }),
      ],
      NOW,
    );
    expect(events).toEqual([
      { type: ProviderEventType.Compacted, preTokens: 9000, trigger: 'auto' },
    ]);
    expect(t.completionCandidateAt).toBeUndefined();
  });

  it('failed manual compaction ends the turn without emitting Compacted', () => {
    const t = new CopilotTurnTracker(true);
    const events = t.ingest(
      [ev('session.compaction_complete', { success: false })],
      NOW,
    );
    expect(events).toEqual([]);
    expect(t.compactionSucceeded).toBe(false);
    expect(t.completionCandidateAt).toBe(NOW);
  });

  it('flags compactionStarted on session.compaction_start (guards slash idle-finalize)', () => {
    const t = new CopilotTurnTracker(true);
    t.ingest([ev('session.compaction_start', { conversationTokens: 10 })], NOW);
    expect(t.compactionStarted).toBe(true);
    expect(t.completionCandidateAt).toBeUndefined();
  });

  it('records session.error as fatalError (fail-fast channel) without emitting events', () => {
    const t = new CopilotTurnTracker();
    const events = t.ingest(
      [ev('session.error', { message: 'quota exceeded' })],
      NOW,
    );
    expect(events).toEqual([]);
    expect(t.fatalError).toBe('quota exceeded');
  });

  it('hasOpenTools reflects start/complete pairing', () => {
    const t = new CopilotTurnTracker();
    t.ingest(
      [ev('tool.execution_start', { toolCallId: 'x', toolName: 'shell' })],
      NOW,
    );
    expect(t.hasOpenTools()).toBe(true);
    t.ingest(
      [
        ev('tool.execution_complete', {
          toolCallId: 'x',
          success: true,
          result: {},
        }),
      ],
      NOW,
    );
    expect(t.hasOpenTools()).toBe(false);
  });

  it('captures session.warning for error diagnostics and skips malformed entries', () => {
    const t = new CopilotTurnTracker();
    const events = t.ingest(
      [
        null,
        42,
        'nope',
        { noType: true },
        ev('session.warning', { message: 'rate limited' }),
      ],
      NOW,
    );
    expect(events).toEqual([]);
    expect(t.getLastWarning()).toBe('rate limited');
  });
});

// ─── buildCopilotPtyArgs ─────────────────────────────────────────────────────

describe('buildCopilotPtyArgs', () => {
  it('fresh session pre-assigns the id via --session-id', () => {
    const args = buildCopilotPtyArgs({ sessionId: 'abc', resume: false });
    expect(args).toEqual(['--session-id', 'abc', '--allow-all']);
  });

  it('respawn resumes via --resume', () => {
    const args = buildCopilotPtyArgs({ sessionId: 'abc', resume: true });
    expect(args).toEqual(['--resume', 'abc', '--allow-all']);
  });

  it('passes model, effort, and MCP config; omits model for auto', () => {
    expect(
      buildCopilotPtyArgs({
        sessionId: 's',
        resume: false,
        model: 'gpt-5.4',
        reasoningEffort: 'high',
        mcpConfigArg: '@/tmp/mcp.json',
      }),
    ).toEqual([
      '--session-id',
      's',
      '--allow-all',
      '--model',
      'gpt-5.4',
      '--effort',
      'high',
      '--additional-mcp-config',
      '@/tmp/mcp.json',
    ]);

    expect(
      buildCopilotPtyArgs({ sessionId: 's', resume: false, model: 'auto' }),
    ).toEqual(['--session-id', 's', '--allow-all']);
  });
});
