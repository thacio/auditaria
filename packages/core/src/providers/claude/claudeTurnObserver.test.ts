/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_CLAUDE_PROVIDER: ClaudeTurnObserver — the one turn pipeline.
 * Fixtures mirror what Claude Code 2.1.261 emitted in the haiku probes
 * (hook payloads and transcript lines), so each test is a replay of a real
 * shape: text→tool→text ordering, failed tools, AskUserQuestion, async
 * sub-agents + task notifications, /compact, /clear, Esc mid-tool, queued
 * messages injected mid-turn, dropped Stop hooks, idle fallback.
 */

import { describe, it, expect } from 'vitest';
import {
  ClaudeTurnObserver,
  classifyExternalSource,
  describeSystemPrompt,
  formatToolResponse,
  promptMatches,
  slashName,
  type HookEvent,
  type ObservedTurn,
  type TurnObserverHost,
  TRANSCRIPT_SETTLE_MS,
  NO_SIGNAL_IDLE_MS,
} from './claudeTurnObserver.js';
import {
  ProviderEventType,
  type ProviderEvent,
  type ProviderNotice,
} from '../types.js';

// ─── Harness ─────────────────────────────────────────────────────────────────

class Harness {
  hooks: HookEvent[] = [];
  lines: unknown[] = [];
  grew = false;
  idlePrompt = false;
  clock = 1_000_000;
  externalTurns: ObservedTurn[] = [];
  notices: ProviderNotice[] = [];
  sessionChanges: Array<{ id: string; source: string }> = [];
  promptAccepted = 0;
  readonly observer: ClaudeTurnObserver;

  constructor() {
    const host: TurnObserverHost = {
      drainHooks: async () => {
        const out = this.hooks;
        this.hooks = [];
        return out;
      },
      drainTranscript: async () => {
        const entries = this.lines;
        const grew = this.grew || entries.length > 0;
        this.lines = [];
        this.grew = false;
        return { entries, grew };
      },
      ptyShowsInputPrompt: () => this.idlePrompt,
      onExternalTurn: (t) => this.externalTurns.push(t),
      onNotice: (n) => this.notices.push(n),
      onSessionChange: (id, source) => this.sessionChanges.push({ id, source }),
      onPromptAccepted: () => {
        this.promptAccepted++;
      },
      now: () => this.clock,
    };
    this.observer = new ClaudeTurnObserver(host);
  }

  hook(event: string, payload: Record<string, unknown> = {}): this {
    this.hooks.push({ event, payload });
    return this;
  }

  line(entry: unknown): this {
    this.lines.push(entry);
    return this;
  }

  async tick(advanceMs = 0): Promise<void> {
    this.clock += advanceMs;
    await this.observer.tick();
  }
}

/** Drain a (possibly still open) queue: collect what is buffered right now. */
async function drained(
  events: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

const types = (events: ProviderEvent[]) => events.map((e) => e.type);

// ─── Fixture factories (shapes copied from the probes) ───────────────────────

const userLine = (
  promptId: string,
  text: string,
  extra: Record<string, unknown> = {},
) => ({
  type: 'user',
  isSidechain: false,
  promptId,
  uuid: `u-${Math.random()}`,
  message: { role: 'user', content: text },
  ...extra,
});

const assistantBlock = (
  msgId: string,
  stopReason: string,
  block: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  type: 'assistant',
  isSidechain: false,
  requestId: `req-${msgId}`,
  message: {
    id: msgId,
    role: 'assistant',
    model: 'claude-haiku-4-5-20251001',
    stop_reason: stopReason,
    content: [block],
    usage: {
      input_tokens: 10,
      output_tokens: 50,
      cache_read_input_tokens: 30349,
      cache_creation_input_tokens: 10573,
    },
  },
  ...extra,
});

const toolResultLine = (
  promptId: string,
  toolUseId: string,
  content: string,
  isError = false,
) => ({
  type: 'user',
  isSidechain: false,
  promptId,
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        is_error: isError,
        content,
      },
    ],
  },
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ClaudeTurnObserver — chat turns (claimed)', () => {
  it('attributes the accepted prompt to the claim and streams text→tool→text in transcript order', async () => {
    const h = new Harness();
    const claim = h.observer.claimNextTurn('say starting, run echo, say done');
    expect(claim.accepted).toBe(false);

    h.hook('UserPromptSubmit', {
      prompt: 'say starting, run echo, say done',
      prompt_id: 'p1',
    });
    await h.tick();
    expect(claim.accepted).toBe(true);
    expect(h.promptAccepted).toBe(1);
    expect(h.externalTurns).toHaveLength(0);

    // Transcript leads the hooks: text + tool_use blocks first.
    h.line(userLine('p1', 'say starting, run echo, say done'));
    h.line(
      assistantBlock('m1', 'tool_use', { type: 'thinking', thinking: '' }),
    );
    h.line(
      assistantBlock('m1', 'tool_use', { type: 'text', text: 'starting' }),
    );
    h.line(
      assistantBlock('m1', 'tool_use', {
        type: 'tool_use',
        id: 't1',
        name: 'Bash',
        input: { command: 'echo probe-42' },
      }),
    );
    await h.tick();
    // PreToolUse arrives later — deduped.
    h.hook('PreToolUse', {
      tool_name: 'Bash',
      tool_use_id: 't1',
      tool_input: { command: 'echo probe-42' },
      prompt_id: 'p1',
    });
    h.hook('PostToolUse', {
      tool_name: 'Bash',
      tool_use_id: 't1',
      tool_response: { stdout: 'probe-42', stderr: '' },
      prompt_id: 'p1',
    });
    await h.tick();
    h.line(toolResultLine('p1', 't1', 'probe-42'));
    h.line(
      assistantBlock('m2', 'end_turn', {
        type: 'text',
        text: 'done: probe-42',
      }),
    );
    await h.tick();
    h.hook('Stop', {
      prompt_id: 'p1',
      last_assistant_message: 'done: probe-42',
    });
    await h.tick();

    const events = await drained(claim.events);
    expect(types(events)).toEqual([
      ProviderEventType.ModelInfo,
      ProviderEventType.Content,
      ProviderEventType.ToolUse,
      ProviderEventType.ToolResult,
      ProviderEventType.Content,
      ProviderEventType.Finished,
    ]);
    const result = events[3] as Extract<
      ProviderEvent,
      { type: ProviderEventType.ToolResult }
    >;
    expect(result.output).toBe('probe-42');
    expect(result.isError).toBe(false);
    expect((events[1] as { text: string }).text).toBe('starting');
    expect((events[4] as { text: string }).text).toBe('done: probe-42');
    expect(claim.done).toBe(true);
    expect(h.observer.isTurnActive()).toBe(false);
  });

  it('does not steal a terminal-typed turn that arrives while a claim waits', async () => {
    const h = new Harness();
    const claim = h.observer.claimNextTurn('from the chat box');
    h.hook('UserPromptSubmit', {
      prompt: 'typed in the terminal',
      prompt_id: 'p9',
    });
    await h.tick();
    expect(claim.accepted).toBe(false);
    expect(h.externalTurns).toHaveLength(1);
    expect(h.externalTurns[0].source).toBe('terminal');
    expect(h.externalTurns[0].userText).toBe('typed in the terminal');
  });

  it('a released claim ends its stream with Aborted', async () => {
    const h = new Harness();
    const claim = h.observer.claimNextTurn('lost prompt');
    h.observer.releaseClaim('timeout');
    const events = await drained(claim.events);
    expect(types(events)).toEqual([ProviderEventType.Aborted]);
    expect((events[0] as { reason?: string }).reason).toBe('timeout');
    expect(claim.done).toBe(true);
  });
});

describe('ClaudeTurnObserver — external turns', () => {
  it('a terminal-typed turn is delivered with the same event stream, and a failed tool is an errored result', async () => {
    const h = new Harness();
    h.hook('UserPromptSubmit', { prompt: 'run exit 3', prompt_id: 'p2' });
    await h.tick();
    expect(h.externalTurns).toHaveLength(1);
    const turn = h.externalTurns[0];
    expect(turn.source).toBe('terminal');

    h.line(userLine('p2', 'run exit 3'));
    h.line(
      assistantBlock('m1', 'tool_use', {
        type: 'tool_use',
        id: 't2',
        name: 'Bash',
        input: { command: 'exit 3' },
      }),
    );
    h.hook('PreToolUse', {
      tool_name: 'Bash',
      tool_use_id: 't2',
      prompt_id: 'p2',
      tool_input: { command: 'exit 3' },
    });
    h.hook('PostToolUseFailure', {
      tool_name: 'Bash',
      tool_use_id: 't2',
      error: 'Exit code 3',
      prompt_id: 'p2',
    });
    h.line(toolResultLine('p2', 't2', 'Exit code 3', true));
    h.line(
      assistantBlock('m2', 'end_turn', {
        type: 'text',
        text: 'The shell exited with status 3.',
      }),
    );
    h.hook('Stop', { prompt_id: 'p2' });
    await h.tick();

    const events = await drained(turn.events);
    const result = events.find(
      (e) => e.type === ProviderEventType.ToolResult,
    ) as { output: string; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.output).toBe('Exit code 3');
    expect(types(events).at(-1)).toBe(ProviderEventType.Finished);
  });

  it('a <task-notification> turn is system-initiated and sub-agent hooks never become main tool cards', async () => {
    const h = new Harness();
    // Sub-agent internals carry agent_id — ignored for the main stream.
    h.hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' });
    h.hook('PreToolUse', {
      tool_name: 'Glob',
      tool_use_id: 'sub-1',
      agent_id: 'a1',
      agent_type: 'Explore',
    });
    h.hook('PostToolUse', {
      tool_name: 'Glob',
      tool_use_id: 'sub-1',
      agent_id: 'a1',
      agent_type: 'Explore',
      tool_response: { filenames: [] },
    });
    h.hook('SubagentStop', {
      agent_id: 'a1',
      agent_type: 'Explore',
      last_assistant_message: '**Count: 4**',
    });
    // Claude's internal agents have an empty type — ignored entirely.
    h.hook('SubagentStop', { agent_id: 'internal', agent_type: '' });
    h.hook('UserPromptSubmit', {
      prompt:
        '<task-notification>\n<task-id>a1</task-id>\n</task-notification>',
      prompt_id: 'p3',
    });
    await h.tick();
    expect(h.notices.filter((n) => n.kind === 'subagent')).toHaveLength(2);
    expect(h.externalTurns).toHaveLength(1);
    expect(h.externalTurns[0].source).toBe('system');
    h.line(assistantBlock('m1', 'end_turn', { type: 'text', text: '**4**' }));
    h.hook('Stop', { prompt_id: 'p3' });
    await h.tick();
    const events = await drained(h.externalTurns[0].events);
    expect(types(events)).toEqual([
      ProviderEventType.ModelInfo,
      ProviderEventType.Content,
      ProviderEventType.Finished,
    ]);
  });

  it('AskUserQuestion surfaces an interactive prompt and resolves on its tool result', async () => {
    const h = new Harness();
    h.hook('UserPromptSubmit', { prompt: 'ask me a color', prompt_id: 'p4' });
    h.line(
      assistantBlock('m1', 'tool_use', {
        type: 'tool_use',
        id: 'ask-1',
        name: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Pick a color',
              header: 'Color',
              options: [{ label: 'Red' }, { label: 'Blue' }],
              multiSelect: false,
            },
          ],
        },
      }),
    );
    await h.tick();
    expect(h.observer.hasPendingPrompts()).toBe(true);
    expect(
      h.observer.getPendingPrompt('ask-1')?.[0].options.map((o) => o.label),
    ).toEqual(['Red', 'Blue']);
    // PermissionRequest for the picker must NOT raise an attention notice (the prompt is the UI).
    h.hook('PermissionRequest', {
      tool_name: 'AskUserQuestion',
      tool_input: {},
    });
    h.hook('PostToolUse', {
      tool_name: 'AskUserQuestion',
      tool_use_id: 'ask-1',
      tool_response: { answers: { 'Pick a color': 'Red' } },
    });
    await h.tick(); // the answer lands seconds before Claude's next text (probe: 26.8 s vs 30.0 s)
    h.line(
      assistantBlock('m2', 'end_turn', {
        type: 'text',
        text: 'You picked Red',
      }),
    );
    h.hook('Stop', { prompt_id: 'p4' });
    await h.tick();
    expect(h.notices.filter((n) => n.kind === 'attention')).toHaveLength(0);
    const events = await drained(h.externalTurns[0].events);
    expect(types(events)).toEqual([
      ProviderEventType.ModelInfo,
      ProviderEventType.ToolUse,
      ProviderEventType.InteractivePromptStart,
      ProviderEventType.ToolResult,
      ProviderEventType.InteractivePromptResolved,
      ProviderEventType.Content,
      ProviderEventType.Finished,
    ]);
    expect(h.observer.hasPendingPrompts()).toBe(false);
  });

  it('plan approval raises an attention notice that ends when the tool result lands', async () => {
    const h = new Harness();
    h.hook('UserPromptSubmit', { prompt: 'exit plan mode', prompt_id: 'p5' });
    h.hook('PreToolUse', {
      tool_name: 'ExitPlanMode',
      tool_use_id: 'plan-1',
      prompt_id: 'p5',
      tool_input: { plan: '1. say hi' },
    });
    h.hook('PermissionRequest', {
      tool_name: 'ExitPlanMode',
      tool_input: { plan: '1. say hi' },
    });
    h.hook('Notification', {
      notification_type: 'permission_prompt',
      message: 'Claude Code needs your approval for the plan',
    });
    await h.tick();
    const starts = h.notices.filter(
      (n) => n.kind === 'attention' && n.phase === 'start',
    );
    expect(starts).toHaveLength(2); // PermissionRequest + Notification (deduped by id)
    expect(starts[0]).toMatchObject({
      what: 'permission',
      toolName: 'ExitPlanMode',
    });
    h.hook('PostToolUse', {
      tool_name: 'ExitPlanMode',
      tool_use_id: 'plan-1',
      tool_response: { plan: '1. say hi' },
    });
    await h.tick();
    expect(
      h.notices.filter((n) => n.kind === 'attention' && n.phase === 'end'),
    ).toHaveLength(2);
  });
});

describe('ClaudeTurnObserver — completion channels and robustness', () => {
  it('finalizes on a settled terminal stop_reason when the Stop hook is dropped', async () => {
    const h = new Harness();
    h.hook('UserPromptSubmit', { prompt: 'hello', prompt_id: 'p6' });
    await h.tick();
    h.line(
      assistantBlock('m1', 'end_turn', { type: 'text', text: 'hello world' }),
    );
    await h.tick();
    await h.tick(TRANSCRIPT_SETTLE_MS - 100);
    expect(h.observer.isTurnActive()).toBe(true);
    await h.tick(200);
    expect(h.observer.isTurnActive()).toBe(false);
    const events = await drained(h.externalTurns[0].events);
    expect(types(events).at(-1)).toBe(ProviderEventType.Finished);
  });

  it('never finalizes on the transcript while a tool is still open, then idle-finalizes with a synthetic errored result', async () => {
    const h = new Harness();
    h.hook('UserPromptSubmit', { prompt: 'run something', prompt_id: 'p7' });
    h.hook('PreToolUse', {
      tool_name: 'Bash',
      tool_use_id: 't7',
      prompt_id: 'p7',
      tool_input: { command: 'x' },
    });
    await h.tick();
    await h.tick(NO_SIGNAL_IDLE_MS + 1000);
    expect(h.observer.isTurnActive()).toBe(true); // open tool blocks the idle path
    h.hook('PostToolUse', {
      tool_name: 'Bash',
      tool_use_id: 't7',
      tool_response: 'ok',
      prompt_id: 'p7',
    });
    await h.tick();
    // No terminal stop_reason, no Stop hook, but the PTY shows the idle prompt.
    h.idlePrompt = true;
    await h.tick(NO_SIGNAL_IDLE_MS + 1000);
    expect(h.observer.isTurnActive()).toBe(false);
  });

  it('Esc/Ctrl+C mid-tool: the interrupted user line aborts the turn and dangling tools get an errored result', async () => {
    const h = new Harness();
    h.hook('UserPromptSubmit', { prompt: 'sleep', prompt_id: 'p8' });
    await h.tick();
    h.line(
      assistantBlock('m1', 'tool_use', {
        type: 'tool_use',
        id: 't8',
        name: 'Bash',
        input: { command: 'node -e ...' },
      }),
    );
    await h.tick();
    h.line(toolResultLine('p8', 't8', 'User rejected tool use', true));
    h.line(userLine('p8', '[Request interrupted by user for tool use]'));
    await h.tick();
    const events = await drained(h.externalTurns[0].events);
    expect(types(events)).toEqual([
      ProviderEventType.ModelInfo,
      ProviderEventType.ToolUse,
      ProviderEventType.ToolResult,
      ProviderEventType.Aborted,
    ]);
    expect(h.notices.filter((n) => n.kind === 'user_message')).toHaveLength(0);
  });

  it('an interrupt from the chat: late "rejected" result + interrupted line never open a phantom turn', async () => {
    const h = new Harness();
    h.hook('UserPromptSubmit', { prompt: 'slow', prompt_id: 'p9' });
    await h.tick();
    h.line(
      assistantBlock('m1', 'tool_use', {
        type: 'tool_use',
        id: 't9',
        name: 'Bash',
        input: {},
      }),
    );
    await h.tick();
    h.observer.abortCurrentTurn('aborted'); // Esc from the chat
    const events = await drained(h.externalTurns[0].events);
    expect(types(events)).toEqual([
      ProviderEventType.ModelInfo,
      ProviderEventType.ToolUse,
      ProviderEventType.ToolResult, // synthetic, errored
      ProviderEventType.Aborted,
    ]);
    // Claude writes these seconds later.
    h.line(toolResultLine('p9', 't9', 'User rejected tool use', true));
    h.line(userLine('p9', '[Request interrupted by user for tool use]'));
    h.hook('PostToolUseFailure', {
      tool_name: 'Bash',
      tool_use_id: 't9',
      error: 'rejected',
    });
    await h.tick();
    expect(h.externalTurns).toHaveLength(1);
    expect(h.observer.isTurnActive()).toBe(false);
  });

  it('a message queued while the turn runs is surfaced once as an injected user message', async () => {
    const h = new Harness();
    h.hook('UserPromptSubmit', {
      prompt: 'run the slow command',
      prompt_id: 'p10',
    });
    h.hook('PreToolUse', {
      tool_name: 'Bash',
      tool_use_id: 't10',
      prompt_id: 'p10',
      tool_input: {},
    });
    await h.tick();
    // Claude re-fires UserPromptSubmit with the SAME prompt_id for the queued text.
    h.hook('UserPromptSubmit', {
      prompt: 'Reply with exactly: second',
      prompt_id: 'p10',
    });
    await h.tick();
    h.line(userLine('p10', 'Reply with exactly: second'));
    await h.tick();
    const injected = h.notices.filter((n) => n.kind === 'user_message');
    expect(injected).toHaveLength(1);
    expect((injected[0] as { text: string }).text).toBe(
      'Reply with exactly: second',
    );
    expect(h.externalTurns).toHaveLength(1);
  });

  it('a StopFailure ends the turn with an Error event', async () => {
    const h = new Harness();
    h.hook('UserPromptSubmit', { prompt: 'hi', prompt_id: 'p11' });
    h.hook('StopFailure', { error_type: 'rate_limit' });
    await h.tick();
    const events = await drained(h.externalTurns[0].events);
    expect(types(events).at(-1)).toBe(ProviderEventType.Error);
    expect((events.at(-1) as { message: string }).message).toContain(
      'rate_limit',
    );
  });

  it('a /compact typed in the terminal becomes a slash turn that emits Compacted + the summary and finalizes', async () => {
    const h = new Harness();
    h.line(userLine('pc', '/compact'));
    await h.tick();
    expect(h.externalTurns).toHaveLength(1);
    h.hook('PreCompact', { trigger: 'manual' });
    h.hook('SessionStart', { source: 'compact', session_id: 'same' }); // same session id — not a change
    h.hook('PostCompact', { trigger: 'manual' });
    h.line({
      type: 'system',
      subtype: 'compact_boundary',
      isSidechain: false,
      compactMetadata: {
        trigger: 'manual',
        preTokens: 41503,
        postTokens: 2063,
      },
    });
    h.line(
      userLine('pc', 'This session is being continued…', {
        isCompactSummary: true,
      }),
    );
    await h.tick();
    expect(h.sessionChanges).toHaveLength(0);
    const events = await drained(h.externalTurns[0].events);
    expect(types(events)).toEqual([
      ProviderEventType.Compacted,
      ProviderEventType.CompactionSummary,
      ProviderEventType.Finished,
    ]);
  });

  it('/clear in the terminal reports a session change; menus report their local output', async () => {
    const h = new Harness();
    h.hook('SessionEnd', { reason: 'clear' });
    h.hook('SessionStart', { source: 'clear', session_id: 'new-session' });
    h.line({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/mcp</command-name>',
    });
    h.line({
      type: 'system',
      subtype: 'local_command',
      content:
        '<local-command-stdout>MCP dialog dismissed</local-command-stdout>',
    });
    await h.tick();
    expect(h.sessionChanges).toEqual([{ id: 'new-session', source: 'clear' }]);
    expect(h.notices).toContainEqual({
      kind: 'local_command',
      command: '/mcp',
      output: 'MCP dialog dismissed',
    });
    expect(h.externalTurns).toHaveLength(0);
  });

  it('dispose aborts the running turn and closes its stream', async () => {
    const h = new Harness();
    h.hook('UserPromptSubmit', { prompt: 'hi', prompt_id: 'p12' });
    await h.tick();
    h.observer.dispose();
    const events = await drained(h.externalTurns[0].events);
    expect(types(events)).toEqual([ProviderEventType.Aborted]);
  });
});

describe('ClaudeTurnObserver — merged findings (MessageDisplay, compact_summary, queued_command)', () => {
  const display = (
    h: Harness,
    message_id: string,
    index: number,
    delta: string,
    final = false,
  ) =>
    h.hook('MessageDisplay', {
      message_id,
      index,
      delta,
      final,
      turn_id: 't',
      prompt_id: 'pd',
    });

  it('streams long text provisionally from MessageDisplay batches (out of order) and emits only the remainder when the transcript block lands', async () => {
    const h = new Harness();
    h.hook('UserPromptSubmit', { prompt: 'write a poem', prompt_id: 'pd' });
    await h.tick();
    display(h, 'disp-1', 1, 'second part. ');
    await h.tick();
    // Batch 1 alone is not contiguous — nothing emitted yet.
    display(h, 'disp-1', 0, 'First part. ');
    await h.tick();
    display(h, 'disp-1', 2, 'third part.', true);
    await h.tick();
    // Canonical block arrives with the same text (plus a trailing newline).
    h.line(
      assistantBlock('m1', 'end_turn', {
        type: 'text',
        text: 'First part. second part. third part.\n',
      }),
    );
    h.hook('Stop', { prompt_id: 'pd' });
    await h.tick();
    const events = await drained(h.externalTurns[0].events);
    const texts = events
      .filter((e) => e.type === ProviderEventType.Content)
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(['First part. second part. ', 'third part.', '\n']);
    expect(types(events).at(-1)).toBe(ProviderEventType.Finished);
  });

  it('ignores a MessageDisplay stream that replays a block the transcript already delivered (short messages)', async () => {
    const h = new Harness();
    h.hook('UserPromptSubmit', { prompt: 'hi', prompt_id: 'pd' });
    await h.tick();
    h.line(
      assistantBlock('m1', 'end_turn', { type: 'text', text: 'hello world' }),
    );
    await h.tick();
    display(h, 'disp-1', 0, 'hello world', true); // fires ~1.5 s after the block
    h.hook('Stop', { prompt_id: 'pd' });
    await h.tick();
    const events = await drained(h.externalTurns[0].events);
    const texts = events
      .filter((e) => e.type === ProviderEventType.Content)
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(['hello world']);
  });

  it('keeps text→tool→text order when the first text streams provisionally', async () => {
    const h = new Harness();
    h.hook('UserPromptSubmit', { prompt: 'do it', prompt_id: 'pd' });
    await h.tick();
    display(h, 'disp-1', 0, 'starting', true);
    await h.tick();
    h.line(
      assistantBlock('m1', 'tool_use', { type: 'text', text: 'starting' }),
    );
    h.line(
      assistantBlock('m1', 'tool_use', {
        type: 'tool_use',
        id: 'tq',
        name: 'Bash',
        input: {},
      }),
    );
    await h.tick();
    h.hook('PostToolUse', {
      tool_name: 'Bash',
      tool_use_id: 'tq',
      tool_response: 'ok',
      prompt_id: 'pd',
    });
    await h.tick();
    display(h, 'disp-2', 0, 'done', true);
    await h.tick();
    h.line(assistantBlock('m2', 'end_turn', { type: 'text', text: 'done' }));
    h.hook('Stop', { prompt_id: 'pd' });
    await h.tick();
    const events = await drained(h.externalTurns[0].events);
    expect(
      types(events).filter((t) => t !== ProviderEventType.ModelInfo),
    ).toEqual([
      ProviderEventType.Content, // 'starting' (provisional)
      ProviderEventType.ToolUse,
      ProviderEventType.ToolResult,
      ProviderEventType.Content, // 'done' (provisional; canonical adds nothing)
      ProviderEventType.Finished,
    ]);
  });

  it('a MessageDisplay batch arriving after the turn finalized neither opens a turn nor consumes the next claim', async () => {
    const h = new Harness();
    h.hook('UserPromptSubmit', { prompt: 'first', prompt_id: 'p1' });
    await h.tick();
    h.line(
      assistantBlock('m1', 'end_turn', { type: 'text', text: 'finished' }),
    );
    h.hook('Stop', { prompt_id: 'p1' });
    await h.tick();
    expect(h.observer.isTurnActive()).toBe(false);
    // The chat sends the next prompt; Claude's late display echo lands first.
    const claim = h.observer.claimNextTurn('second');
    display(h, 'disp-late', 0, 'finished', true);
    await h.tick();
    expect(h.observer.activeTurn).toBeNull(); // no phantom turn (the claim alone counts as "active")
    expect(claim.accepted).toBe(false);
    expect(h.externalTurns).toHaveLength(1);
    h.hook('UserPromptSubmit', { prompt: 'second', prompt_id: 'p2' });
    await h.tick();
    expect(claim.accepted).toBe(true);
    h.line(assistantBlock('m2', 'end_turn', { type: 'text', text: 'ok' }));
    h.hook('Stop', { prompt_id: 'p2' });
    await h.tick();
    const events = await drained(claim.events);
    const texts = events
      .filter((e) => e.type === ProviderEventType.Content)
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(['ok']); // the late 'finished' echo never leaked in
  });

  it('a late display of the previous turn does not leak into a new turn that already started', async () => {
    const h = new Harness();
    h.hook('UserPromptSubmit', { prompt: 'first', prompt_id: 'p1' });
    await h.tick();
    h.line(
      assistantBlock('m1', 'end_turn', { type: 'text', text: 'alpha answer' }),
    );
    h.hook('Stop', { prompt_id: 'p1' });
    await h.tick();
    h.hook('UserPromptSubmit', { prompt: 'second', prompt_id: 'p2' });
    await h.tick();
    display(h, 'disp-old', 0, 'alpha answer', true); // echo of turn 1
    await h.tick();
    h.line(assistantBlock('m2', 'end_turn', { type: 'text', text: 'beta' }));
    h.hook('Stop', { prompt_id: 'p2' });
    await h.tick();
    const events = await drained(h.externalTurns[1].events);
    const texts = events
      .filter((e) => e.type === ProviderEventType.Content)
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(['beta']);
  });

  it('a chat prompt whose claim matches starts its own turn even while a stale turn is still open', async () => {
    const h = new Harness();
    // A tool result for an unknown turn opened a synthetic turn (both start signals missed).
    h.hook('PreToolUse', {
      tool_name: 'Bash',
      tool_use_id: 'tz',
      prompt_id: 'old',
      tool_input: {},
    });
    await h.tick();
    expect(h.observer.isTurnActive()).toBe(true);
    const claim = h.observer.claimNextTurn('my prompt');
    h.hook('UserPromptSubmit', { prompt: 'my prompt', prompt_id: 'pnew' });
    await h.tick();
    expect(claim.accepted).toBe(true);
    expect(h.observer.activeTurn?.promptId).toBe('pnew');
    expect(h.notices.filter((n) => n.kind === 'user_message')).toHaveLength(0);
  });

  it('takes the compaction summary from the PostCompact hook and ignores the later transcript copy', async () => {
    const h = new Harness();
    h.line(userLine('pc', '/compact'));
    await h.tick();
    h.hook('PostCompact', {
      trigger: 'manual',
      compact_summary: 'SUMMARY FROM HOOK',
    });
    await h.tick();
    h.line(userLine('pc', 'SUMMARY FROM HOOK', { isCompactSummary: true }));
    await h.tick();
    const events = await drained(h.externalTurns[0].events);
    const summaries = events.filter(
      (e) => e.type === ProviderEventType.CompactionSummary,
    );
    expect(summaries).toHaveLength(1);
    expect((summaries[0] as { summary: string }).summary).toBe(
      'SUMMARY FROM HOOK',
    );
    expect(types(events).at(-1)).toBe(ProviderEventType.Finished);
  });

  it('shows a queued_command attachment once as an injected user message', async () => {
    const h = new Harness();
    h.hook('UserPromptSubmit', { prompt: 'slow work', prompt_id: 'pq' });
    h.hook('PreToolUse', {
      tool_name: 'Bash',
      tool_use_id: 'tqq',
      prompt_id: 'pq',
      tool_input: {},
    });
    await h.tick();
    h.hook('UserPromptSubmit', { prompt: 'and also this', prompt_id: 'pq' });
    h.line({
      type: 'attachment',
      isSidechain: false,
      attachment: {
        type: 'queued_command',
        prompt: 'and also this',
        source_uuid: 'q-1',
      },
    });
    await h.tick();
    expect(h.notices.filter((n) => n.kind === 'user_message')).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('describeSystemPrompt turns a task-notification into one readable line', () => {
    const xml =
      '<task-notification>\n<task-id>a2a7b102a74cae3ce</task-id>\n<tool-use-id>toolu_01G</tool-use-id>\n' +
      '<output-file>C:\\Users\\x\\tasks\\a2a7b102a74cae3ce.output</output-file>\n<status>completed</status>\n' +
      '<summary>Agent "Trivial subagent smoke test" finished</summary>\n<note>A task-notification fires each time…</note>\n' +
      '<result>PONG</result>\n<usage><subagent_tokens>69304</subagent_tokens><tool_uses>0</tool_uses><duration_ms>3383</duration_ms></usage>\n</task-notification>';
    expect(describeSystemPrompt(xml)).toBe(
      'Background task finished: Agent "Trivial subagent smoke test" finished (3.4 s, 0 tool uses) — result: PONG',
    );
    expect(
      describeSystemPrompt(
        '<task-notification><summary>Background command "sleep" completed (exit code 0)</summary><status>completed</status></task-notification>',
      ),
    ).toBe(
      'Background task finished: Background command "sleep" completed (exit code 0)',
    );
    expect(
      describeSystemPrompt(
        '<system-reminder>Some <b>text</b></system-reminder>',
      ),
    ).toBe('Some text');
  });

  it('classifyExternalSource', () => {
    expect(classifyExternalSource('hello')).toBe('terminal');
    expect(
      classifyExternalSource('<task-notification>x</task-notification>'),
    ).toBe('system');
    expect(classifyExternalSource('  <system-reminder>y')).toBe('system');
  });
  it('slashName', () => {
    expect(slashName('/compact')).toBe('compact');
    expect(slashName('  /model sonnet')).toBe('model');
    expect(slashName('hello')).toBeUndefined();
  });
  it('promptMatches tolerates whitespace and a context prefix', () => {
    expect(promptMatches('a  b\nc', 'a b c')).toBe(true);
    expect(
      promptMatches(
        '<auditaria_conversation_history>…</auditaria_conversation_history>\n\nplease do the thing now',
        'please do the thing now',
      ),
    ).toBe(true);
    expect(promptMatches('from the chat box', 'typed in the terminal')).toBe(
      false,
    );
  });
  it('formatToolResponse prefers the human-readable form', () => {
    expect(formatToolResponse({ stdout: 'out', stderr: '' })).toBe('out');
    expect(formatToolResponse({ stdout: 'out', stderr: 'err' })).toBe(
      'out\nerr',
    );
    expect(
      formatToolResponse({ content: [{ type: 'text', text: 'mcp text' }] }),
    ).toBe('mcp text');
    expect(formatToolResponse('plain')).toBe('plain');
    expect(formatToolResponse({ matches: ['x'] })).toBe('{"matches":["x"]}');
  });
});
