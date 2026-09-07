/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_AGY_PROVIDER: AgyTurnObserver on transcript fixtures captured from
 * the real agy 1.1.27 TUI (scratchpad agy-probes), in their real order.
 */

import { describe, it, expect } from 'vitest';
import {
  AgyTurnObserver,
  cleanToolOutput,
  extractUserRequest,
  foldAscii,
  type HookEvent,
  type TurnObserverHost,
} from './agyTurnObserver.js';
import {
  ProviderEventType,
  type ProviderEvent,
  type ProviderNotice,
} from '../types.js';
import type { ObservedTurn } from '../terminal/turnObserver.js';

class Harness {
  hooks: HookEvent[] = [];
  transcript: unknown[] = [];
  lastSize = 0;
  idlePrompt = false;
  clock = 1_000_000;
  externalTurns: ObservedTurn[] = [];
  notices: ProviderNotice[] = [];
  sessionChanges: Array<{ id: string; source: string }> = [];
  readonly observer: AgyTurnObserver;
  constructor() {
    const host: TurnObserverHost = {
      drainHooks: async () => {
        const h = this.hooks;
        this.hooks = [];
        return h;
      },
      // agy rewrites steps in place: the driver re-reads the WHOLE file.
      drainTranscript: async () => {
        const size = JSON.stringify(this.transcript).length;
        const grew = size !== this.lastSize;
        this.lastSize = size;
        return { entries: [...this.transcript], grew };
      },
      ptyShowsInputPrompt: () => this.idlePrompt,
      onExternalTurn: (t) => this.externalTurns.push(t),
      onNotice: (n) => this.notices.push(n),
      onSessionChange: (id, source) => this.sessionChanges.push({ id, source }),
      onPromptAccepted: () => {},
      now: () => this.clock,
    };
    this.observer = new AgyTurnObserver(host);
  }
  step(
    step_index: number,
    source: string,
    type: string,
    extra: Record<string, unknown> = {},
    status = 'DONE',
  ) {
    const existing = this.transcript.findIndex(
      (e) => (e as { step_index: number }).step_index === step_index,
    );
    const entry = {
      step_index,
      source,
      type,
      status,
      created_at: '2026-09-07T03:03:15Z',
      ...extra,
    };
    if (existing >= 0) this.transcript[existing] = entry;
    else this.transcript.push(entry);
  }
  user(step: number, text: string) {
    this.step(step, 'USER_EXPLICIT', 'USER_INPUT', {
      content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-09-07\n</ADDITIONAL_METADATA>`,
    });
  }
  async tick(advanceMs = 100) {
    this.clock += advanceMs;
    await this.observer.tick();
  }
}

async function drained(
  events: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}
const types = (events: ProviderEvent[]) => events.map((e) => e.type);
const SHELL_RESULT =
  'Created At: 2026-09-07T00:03:17-03:00\nCompleted At: 2026-09-07T00:03:18-03:00\n\nThe command exited with code 0.\n\nOutput:\n68828';

describe('AgyTurnObserver — chat turns (claimed)', () => {
  it('a text turn: USER_INPUT accepts the claim, a final PLANNER_RESPONSE settles the turn', async () => {
    const h = new Harness();
    const claim = h.observer.claimNextTurn('Reply with exactly the word: PONG');
    h.user(0, 'Reply with exactly the word: PONG');
    await h.tick();
    expect(claim.accepted).toBe(true);
    h.step(1, 'MODEL', 'PLANNER_RESPONSE', { content: 'PONG' });
    await h.tick();
    expect(claim.done).toBe(false);
    await h.tick(1_600);
    expect(claim.done).toBe(true);
    const events = await drained(claim.events);
    expect(types(events)).toEqual([
      ProviderEventType.Content,
      ProviderEventType.Finished,
    ]);
    expect((events[0] as { text: string }).text).toBe('PONG');
    expect(h.externalTurns).toHaveLength(0);
  });

  it('a tool turn: text + tool call, RUNNING result waits, DONE result is a card, then the final text', async () => {
    const h = new Harness();
    const claim = h.observer.claimNextTurn('Say BEFORE, run node, say AFTER');
    h.user(0, 'Say BEFORE, run node, say AFTER');
    h.step(1, 'MODEL', 'PLANNER_RESPONSE', {
      content: 'BEFORE\n\n',
      tool_calls: [
        {
          name: 'run_command',
          args: { CommandLine: 'node -p "process.pid"', Cwd: 'C:/wd' },
        },
      ],
    });
    h.step(
      2,
      'MODEL',
      'GENERIC',
      { content: 'Created At: …\nTool is running' },
      'RUNNING',
    );
    await h.tick();
    await h.tick(2_000);
    expect(claim.done).toBe(false); // an open tool never settles
    h.step(2, 'MODEL', 'GENERIC', { content: SHELL_RESULT }); // rewritten in place
    h.step(3, 'MODEL', 'PLANNER_RESPONSE', { content: 'AFTER: 68828' });
    await h.tick();
    await h.tick(1_600);
    const events = await drained(claim.events);
    expect(types(events)).toEqual([
      ProviderEventType.Content,
      ProviderEventType.ToolUse,
      ProviderEventType.ToolResult,
      ProviderEventType.Content,
      ProviderEventType.Finished,
    ]);
    expect((events[1] as { toolName: string }).toolName).toBe('run_command');
    expect((events[2] as { output: string }).output).toBe(
      'The command exited with code 0.\n\nOutput:\n68828',
    );
    expect((events[2] as { isError: boolean }).isError).toBe(false);
  });

  it('a claim is accepted although agy dropped the non-ASCII characters of the typed prompt', async () => {
    const h = new Harness();
    const typed = 'Across domains\u2014public\u2011sector, IT. Say hi.';
    const claim = h.observer.claimNextTurn(typed);
    h.user(0, foldAscii(typed));
    await h.tick();
    expect(claim.accepted).toBe(true);
    expect(h.externalTurns).toHaveLength(0);
  });

  it('the Stop hook finalizes without waiting for the settle window', async () => {
    const h = new Harness();
    const claim = h.observer.claimNextTurn('hi');
    h.user(0, 'hi');
    h.step(1, 'MODEL', 'PLANNER_RESPONSE', { content: 'hello' });
    await h.tick();
    h.hooks.push({ event: 'Stop', payload: { conversationId: 'c1' } });
    await h.tick();
    expect(claim.done).toBe(true);
    expect(types(await drained(claim.events))).toEqual([
      ProviderEventType.Content,
      ProviderEventType.Finished,
    ]);
  });
});

describe('AgyTurnObserver — terminal turns, queued input, sessions', () => {
  it('a terminal-typed prompt becomes an external turn with the same stream; thinking is surfaced', async () => {
    const h = new Harness();
    h.user(0, 'Reply with exactly: EXT');
    await h.tick();
    expect(h.externalTurns).toHaveLength(1);
    expect(h.externalTurns[0].source).toBe('terminal');
    expect(h.externalTurns[0].userText).toBe('Reply with exactly: EXT');
    h.step(1, 'MODEL', 'PLANNER_RESPONSE', {
      thinking: 'The user wants EXT.',
      content: 'EXT',
    });
    await h.tick();
    await h.tick(1_600);
    expect(types(await drained(h.externalTurns[0].events))).toEqual([
      ProviderEventType.Thinking,
      ProviderEventType.Content,
      ProviderEventType.Finished,
    ]);
  });

  it('a message typed while a tool runs is shown once as an injected message; SYSTEM steps are ignored; the merged answer closes the turn', async () => {
    const h = new Harness();
    h.user(0, 'run something slow, then say FIRST_DONE');
    h.step(1, 'MODEL', 'PLANNER_RESPONSE', {
      content: '',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node -e …' } }],
    });
    h.step(
      2,
      'MODEL',
      'GENERIC',
      { content: 'Tool is running as a background task' },
      'RUNNING',
    );
    await h.tick();
    h.user(3, 'Also say SECOND_DONE.');
    await h.tick();
    expect(h.externalTurns).toHaveLength(1);
    expect(h.notices.filter((n) => n.kind === 'user_message')).toHaveLength(1);
    h.step(2, 'MODEL', 'GENERIC', {
      content: 'Created At: x\nCompleted At: y\n\nTask done',
    });
    h.step(4, 'SYSTEM', 'SYSTEM_MESSAGE', {
      content: 'The following is a <SYSTEM_MESSAGE> …',
    });
    h.step(5, 'MODEL', 'PLANNER_RESPONSE', {
      content: 'FIRST_DONE\n\nSECOND_DONE',
    });
    await h.tick();
    await h.tick(1_600);
    const events = await drained(h.externalTurns[0].events);
    expect(types(events)).toEqual([
      ProviderEventType.ToolUse,
      ProviderEventType.ToolResult,
      ProviderEventType.Content,
      ProviderEventType.Finished,
    ]);
  });

  it('SessionStart with a different conversation id reports a session change', async () => {
    const h = new Harness();
    h.observer.resetConversation('old');
    h.hooks.push({
      event: 'SessionStart',
      payload: { conversationId: 'new-id', transcriptPath: 'C:/x' },
    });
    await h.tick();
    expect(h.sessionChanges).toEqual([{ id: 'new-id', source: 'new' }]);
    expect(h.observer.conversationId).toBe('new-id');
  });

  it('idle fallback closes a turn whose Esc left no witness once the prompt is back', async () => {
    const h = new Harness();
    h.user(0, 'write a long story');
    await h.tick();
    h.idlePrompt = true;
    await h.tick(21_000);
    expect(h.observer.isTurnActive()).toBe(false);
  });
});

describe('helpers', () => {
  it('extractUserRequest strips the wrapper and metadata', () => {
    expect(
      extractUserRequest(
        '<USER_REQUEST>\nhello\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nx\n</ADDITIONAL_METADATA>',
      ),
    ).toBe('hello');
    expect(extractUserRequest('plain')).toBe('plain');
  });
  it('cleanToolOutput drops the bookkeeping header', () => {
    expect(cleanToolOutput(SHELL_RESULT)).toBe(
      'The command exited with code 0.\n\nOutput:\n68828',
    );
  });
});
