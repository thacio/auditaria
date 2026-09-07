/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_COPILOT_PROVIDER: CopilotTurnObserver on fixtures captured from
 * the real Copilot TUI (1.0.83, scratchpad copilot-probes): events.jsonl
 * entries and hook payloads in their real order.
 */

import { describe, it, expect } from 'vitest';
import {
  CopilotTurnObserver,
  buildAskUserPromptEvent,
  type HookEvent,
  type TurnObserverHost,
} from './copilotTurnObserver.js';
import {
  ProviderEventType,
  type ProviderEvent,
  type ProviderNotice,
} from '../types.js';
import type { ObservedTurn } from '../terminal/turnObserver.js';

class Harness {
  hooks: HookEvent[] = [];
  lines: unknown[] = [];
  idlePrompt = false;
  clock = 1_000_000;
  externalTurns: ObservedTurn[] = [];
  notices: ProviderNotice[] = [];
  sessionChanges: Array<{ id: string; source: string }> = [];
  accepted = 0;
  readonly observer: CopilotTurnObserver;
  constructor() {
    const host: TurnObserverHost = {
      drainHooks: async () => {
        const h = this.hooks;
        this.hooks = [];
        return h;
      },
      drainTranscript: async () => {
        const entries = this.lines;
        this.lines = [];
        return { entries, grew: entries.length > 0 };
      },
      ptyShowsInputPrompt: () => this.idlePrompt,
      onExternalTurn: (t) => this.externalTurns.push(t),
      onNotice: (n) => this.notices.push(n),
      onSessionChange: (id, source) => this.sessionChanges.push({ id, source }),
      onPromptAccepted: () => {
        this.accepted++;
      },
      now: () => this.clock,
    };
    this.observer = new CopilotTurnObserver(host);
  }
  hook(event: string, payload: Record<string, unknown>) {
    this.hooks.push({ event, payload });
  }
  ev(type: string, data: Record<string, unknown>) {
    this.lines.push({ type, id: `${type}-${this.lines.length}`, data });
  }
  async tick(advanceMs = 100) {
    this.clock += advanceMs;
    await this.observer.tick();
  }
}

const SESSION = 'e16900dc-d27e-45d1-a5d9-3f3ad76ed828';
const hookBase = { sessionId: SESSION, timestamp: 1788734228056, cwd: 'C:/wd' };
const userMsg = (content: string, delivery = 'idle') => ({
  content,
  delivery,
  interactionId: 'i1',
});
const assistant = (
  content: string,
  toolRequests: unknown[] = [],
  extra: Record<string, unknown> = {},
) => ({
  messageId: 'm1',
  model: 'gpt-5-mini',
  content,
  toolRequests,
  turnId: '0',
  outputTokens: 42,
  ...extra,
});

async function drained(
  events: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}
const types = (events: ProviderEvent[]) => events.map((e) => e.type);

describe('CopilotTurnObserver — chat turns (claimed)', () => {
  it('a text turn: accepted by userPromptSubmitted before the events file exists, closed by agentStop', async () => {
    const h = new Harness();
    const claim = h.observer.claimNextTurn('Reply with exactly the word: PONG');
    h.hook('userPromptSubmitted', {
      ...hookBase,
      prompt: 'Reply with exactly the word: PONG',
    });
    await h.tick();
    expect(claim.accepted).toBe(true);
    h.ev('session.start', { sessionId: SESSION });
    h.ev('user.message', userMsg('Reply with exactly the word: PONG'));
    h.hook('sessionStart', {
      ...hookBase,
      source: 'new',
      initialPrompt: 'Reply with exactly the word: PONG',
    });
    h.ev('assistant.turn_start', { turnId: '0' });
    await h.tick();
    h.ev('assistant.message', assistant('PONG'));
    h.ev('assistant.turn_end', { turnId: '0' });
    await h.tick();
    h.hook('agentStop', {
      ...hookBase,
      stopReason: 'end_turn',
      transcriptPath: 'C:/x',
    });
    await h.tick();
    const events = await drained(claim.events);
    expect(types(events)).toEqual([
      ProviderEventType.ModelInfo,
      ProviderEventType.Content,
      ProviderEventType.Finished,
    ]);
    expect((events[1] as { text: string }).text).toBe('PONG');
    expect(
      (events[2] as { usage?: { outputTokens?: number } }).usage?.outputTokens,
    ).toBe(42);
    expect(h.notices.filter((n) => n.kind === 'user_message')).toHaveLength(0);
    expect(h.externalTurns).toHaveLength(0);
    expect(h.sessionChanges).toHaveLength(0);
  });

  it('a tool turn: text → tool card → result → text across two inference steps; the intermediate turn_end does not finish', async () => {
    const h = new Harness();
    const claim = h.observer.claimNextTurn(
      'Say BEFORE, run node -p process.pid, say AFTER',
    );
    h.hook('userPromptSubmitted', {
      ...hookBase,
      prompt: 'Say BEFORE, run node -p process.pid, say AFTER',
    });
    h.ev(
      'user.message',
      userMsg('Say BEFORE, run node -p process.pid, say AFTER'),
    );
    h.ev('assistant.turn_start', { turnId: '0' });
    await h.tick();
    h.ev(
      'assistant.message',
      assistant('Running a short shell command.', [
        { toolCallId: 'call_1', name: 'powershell' },
      ]),
    );
    h.ev('tool.execution_start', {
      toolCallId: 'call_1',
      toolName: 'powershell',
      arguments: { command: 'node -p process.pid' },
      turnId: '0',
    });
    h.hook('permissionRequest', {
      ...hookBase,
      toolName: 'powershell',
      toolInput: { command: 'node -p process.pid' },
    });
    await h.tick();
    h.hook('postToolUse', {
      ...hookBase,
      toolName: 'powershell',
      toolArgs: '{"command":"node -p process.pid"}',
    });
    h.ev('tool.execution_complete', {
      toolCallId: 'call_1',
      success: true,
      result: { content: '148012' },
    });
    h.ev('assistant.turn_end', { turnId: '0' });
    h.ev('assistant.turn_start', { turnId: '1' });
    await h.tick();
    expect(claim.done).toBe(false);
    h.ev(
      'assistant.message',
      assistant('BEFORE\nAFTER: 148012', [], { turnId: '1' }),
    );
    h.ev('assistant.turn_end', { turnId: '1' });
    await h.tick();
    expect(claim.done).toBe(false); // settle window
    await h.tick(1300);
    expect(claim.done).toBe(true); // settled final turn_end even without agentStop
    const events = await drained(claim.events);
    expect(types(events)).toEqual([
      ProviderEventType.ModelInfo,
      ProviderEventType.Content,
      ProviderEventType.ToolUse,
      ProviderEventType.ToolResult,
      ProviderEventType.Content,
      ProviderEventType.Finished,
    ]);
    expect((events[3] as { output: string; isError: boolean }).output).toBe(
      '148012',
    );
    // the permission request was answered by --allow-all within the delay: no attention notice
    expect(h.notices.some((n) => n.kind === 'attention')).toBe(false);
  });

  it('a permission request nobody answers becomes an attention notice after the delay', async () => {
    const h = new Harness();
    h.hook('userPromptSubmitted', { ...hookBase, prompt: 'write a file' });
    await h.tick();
    h.hook('permissionRequest', {
      ...hookBase,
      toolName: 'write',
      toolInput: { path: 'x.txt' },
    });
    await h.tick();
    expect(h.notices.some((n) => n.kind === 'attention')).toBe(false);
    await h.tick(1600);
    const att = h.notices.find(
      (n) => n.kind === 'attention' && n.phase === 'start',
    );
    expect(att && att.kind === 'attention' ? att.toolName : undefined).toBe(
      'write',
    );
  });
});

describe('CopilotTurnObserver — external turns, steering, sessions', () => {
  it('a terminal-typed turn is delivered with the same stream; the later events copy of the prompt is not an injection', async () => {
    const h = new Harness();
    h.hook('userPromptSubmitted', {
      ...hookBase,
      prompt: 'Reply with exactly: EXT',
    });
    await h.tick();
    expect(h.externalTurns).toHaveLength(1);
    expect(h.externalTurns[0].source).toBe('terminal');
    h.ev('user.message', userMsg('Reply with exactly: EXT'));
    h.ev('assistant.turn_start', { turnId: '0' });
    h.ev('assistant.message', assistant('EXT'));
    h.ev('assistant.turn_end', { turnId: '0' });
    h.hook('agentStop', { ...hookBase, stopReason: 'end_turn' });
    await h.tick();
    expect(types(await drained(h.externalTurns[0].events))).toEqual([
      ProviderEventType.ModelInfo,
      ProviderEventType.Content,
      ProviderEventType.Finished,
    ]);
    expect(h.notices.filter((n) => n.kind === 'user_message')).toHaveLength(0);
  });

  it('a steering message typed mid-turn is shown once and stays in the same turn', async () => {
    const h = new Harness();
    h.hook('userPromptSubmitted', { ...hookBase, prompt: 'first' });
    h.ev('user.message', userMsg('first'));
    h.ev('assistant.turn_start', { turnId: '0' });
    h.ev(
      'assistant.message',
      assistant('Running…', [{ toolCallId: 'c1', name: 'powershell' }]),
    );
    h.ev('tool.execution_start', {
      toolCallId: 'c1',
      toolName: 'powershell',
      arguments: { command: 'sleep' },
    });
    await h.tick();
    h.ev('user.message', userMsg('Also say SECOND_DONE.', 'steering'));
    await h.tick();
    expect(h.externalTurns).toHaveLength(1);
    expect(h.notices.filter((n) => n.kind === 'user_message')).toHaveLength(1);
    h.ev('tool.execution_complete', {
      toolCallId: 'c1',
      success: true,
      result: { content: '1' },
    });
    h.ev('assistant.turn_end', { turnId: '0' });
    h.ev('assistant.turn_start', { turnId: '1' });
    h.ev(
      'assistant.message',
      assistant('FIRST_DONE SECOND_DONE', [], { turnId: '1' }),
    );
    h.ev('assistant.turn_end', { turnId: '1' });
    h.hook('agentStop', { ...hookBase, stopReason: 'end_turn' });
    await h.tick();
    expect(types(await drained(h.externalTurns[0].events)).at(-1)).toBe(
      ProviderEventType.Finished,
    );
  });

  it('a <system_notification> prompt starts a system-source turn', async () => {
    const h = new Harness();
    h.hook('userPromptSubmitted', {
      ...hookBase,
      prompt:
        '<system_notification>\nShell command "x" (shellId: 0) has completed with exit code 0\n</system_notification>',
    });
    await h.tick();
    expect(h.externalTurns[0].source).toBe('system');
  });

  it('/clear: sessionEnd clears the session and the next sessionStart rebinds a new id', async () => {
    const h = new Harness();
    h.hook('sessionStart', { ...hookBase, source: 'new' });
    await h.tick();
    h.hook('sessionEnd', { ...hookBase, reason: 'user_exit' });
    await h.tick();
    expect(h.sessionChanges.at(-1)).toEqual({ id: SESSION, source: 'clear' });
    h.hook('sessionStart', { ...hookBase, sessionId: 'new-id', source: 'new' });
    await h.tick();
    expect(h.observer.sessionId).toBe('new-id');
  });

  it('ask_user surfaces an interactive prompt and resolves on completion; a failed tool is an errored card', async () => {
    const h = new Harness();
    h.hook('userPromptSubmitted', { ...hookBase, prompt: 'ask me' });
    h.ev('tool.execution_start', {
      toolCallId: 'ask1',
      toolName: 'ask_user',
      arguments: { question: 'Which color?', choices: ['Red', 'Blue'] },
    });
    await h.tick();
    expect(h.observer.hasPendingPrompts()).toBe(true);
    h.ev('tool.execution_complete', {
      toolCallId: 'ask1',
      success: true,
      result: { content: 'User selected: Blue' },
    });
    h.ev('tool.execution_start', {
      toolCallId: 't2',
      toolName: 'powershell',
      arguments: { command: 'exit 1' },
    });
    h.ev('tool.execution_complete', {
      toolCallId: 't2',
      success: false,
      result: { content: 'boom' },
    });
    h.hook('agentStop', { ...hookBase, stopReason: 'end_turn' });
    await h.tick();
    const events = await drained(h.externalTurns[0].events);
    expect(types(events)).toEqual([
      ProviderEventType.ToolUse,
      ProviderEventType.InteractivePromptStart,
      ProviderEventType.ToolResult,
      ProviderEventType.InteractivePromptResolved,
      ProviderEventType.ToolUse,
      ProviderEventType.ToolResult,
      ProviderEventType.Finished,
    ]);
    expect((events[5] as { isError: boolean }).isError).toBe(true);
    expect(h.observer.hasPendingPrompts()).toBe(false);
  });

  it('idle fallback closes a turn whose Esc left no witness', async () => {
    const h = new Harness();
    h.hook('userPromptSubmitted', {
      ...hookBase,
      prompt: 'run something slow',
    });
    h.ev('tool.execution_start', {
      toolCallId: 'c9',
      toolName: 'powershell',
      arguments: { command: 'sleep' },
    });
    await h.tick();
    h.idlePrompt = true;
    await h.tick(21_000);
    expect(h.observer.isTurnActive()).toBe(true); // an open tool blocks the idle path…
    h.ev('tool.execution_complete', {
      toolCallId: 'c9',
      success: false,
      result: { content: 'cancelled' },
    });
    await h.tick(); // the result is progress; the idle window starts here
    await h.tick(21_000);
    expect(h.observer.isTurnActive()).toBe(false);
  });
});

describe('CopilotTurnObserver — compaction', () => {
  it('/compact typed in chat: compaction_complete emits Compacted + the summaryContent and ends the turn', async () => {
    const h = new Harness();
    const claim = h.observer.claimNextTurn('/compact');
    h.hook('userPromptSubmitted', { ...hookBase, prompt: '/compact' });
    h.ev('session.compaction_start', {});
    await h.tick();
    h.ev('session.compaction_complete', {
      success: true,
      preCompactionTokens: 770,
      summaryContent: 'We discussed X.',
    });
    await h.tick();
    const events = await drained(claim.events);
    expect(types(events)).toEqual([
      ProviderEventType.Compacted,
      ProviderEventType.CompactionSummary,
      ProviderEventType.Finished,
    ]);
    expect((events[0] as { preTokens: number; trigger: string }).trigger).toBe(
      'manual',
    );
    expect((events[1] as { summary: string }).summary).toBe('We discussed X.');
  });
});

describe('buildAskUserPromptEvent', () => {
  it('maps question and string choices', () => {
    const ev = buildAskUserPromptEvent('id', {
      question: 'Q?',
      choices: ['A', 'B', 3],
    });
    expect(ev.title).toBe('Q?');
    expect(ev.questions[0].options.map((o) => o.id)).toEqual(['A', 'B']);
  });
  it('maps the 1.0.83 shape (message + requestedSchema enum)', () => {
    const ev = buildAskUserPromptEvent('id', {
      message: 'Which color?',
      requestedSchema: {
        properties: {
          choice: { type: 'string', enum: ['Red', 'Blue'], default: 'Red' },
        },
      },
    });
    expect(ev.title).toBe('Which color?');
    expect(ev.questions[0].options.map((o) => o.id)).toEqual(['Red', 'Blue']);
  });
});
