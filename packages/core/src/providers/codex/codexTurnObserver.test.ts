/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_CODEX_PROVIDER: CodexTurnObserver on fixtures captured from the
 * real Codex TUI (0.153.4, scratchpad codex-probes): rollout lines and hook
 * payloads in their real order and timing.
 */

import { describe, it, expect } from 'vitest';
import {
  CodexTurnObserver,
  mapCodexToolName,
  outputLooksFailed,
  parseToolArguments,
  type HookEvent,
  type TurnObserverHost,
} from './codexTurnObserver.js';
import {
  ProviderEventType,
  type ProviderEvent,
  type ProviderNotice,
} from '../types.js';
import type { ObservedTurn } from '../terminal/turnObserver.js';

class Harness {
  hooks: HookEvent[] = [];
  lines: unknown[] = [];
  grew = false;
  idlePrompt = false;
  clock = 1_000_000;
  externalTurns: ObservedTurn[] = [];
  notices: ProviderNotice[] = [];
  sessionChanges: Array<{ id: string; source: string }> = [];
  accepted = 0;
  readonly observer: CodexTurnObserver;
  constructor() {
    const host: TurnObserverHost = {
      drainHooks: async () => {
        const h = this.hooks;
        this.hooks = [];
        return h;
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
        this.accepted++;
      },
      now: () => this.clock,
    };
    this.observer = new CodexTurnObserver(host);
  }
  hook(event: string, payload: Record<string, unknown>) {
    this.hooks.push({ event, payload });
  }
  line(entry: unknown) {
    this.lines.push(entry);
  }
  async tick(advanceMs = 100) {
    this.clock += advanceMs;
    await this.observer.tick();
  }
}

// ── Fixture builders (shapes copied from the captured rollout) ─────────────

const SESSION = '01a074f8-2497-7d01-aeb0-5725bab0e794';
const TURN = '01a074f8-353c-7ca1-96f0-9cde0eccb659';

const meta = () => ({
  type: 'session_meta',
  payload: {
    id: SESSION,
    session_id: SESSION,
    cwd: 'C:/wd',
    originator: 'codex-tui',
  },
});
const taskStarted = (turnId = TURN) => ({
  type: 'event_msg',
  payload: { type: 'task_started', turn_id: turnId },
});
const envContext = () => ({
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: '<environment_context>\n  <cwd>C:/wd</cwd>\n</environment_context>',
      },
    ],
  },
});
const developer = () => ({
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: '<skills_instructions>…' }],
  },
});
const userMsg = (text: string) => ({
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  },
});
const itemCompleted = (type: string, id: string, status?: string) => ({
  type: 'event_msg',
  payload: {
    type: 'item_completed',
    turn_id: TURN,
    item: { type, id, ...(status ? { status } : {}) },
  },
});
const reasoning = (summaries: string[] = []) => ({
  type: 'response_item',
  payload: {
    type: 'reasoning',
    id: 'rs_1',
    summary: summaries.map((text) => ({ type: 'summary_text', text })),
    encrypted_content: 'gAAAA',
  },
});
const assistant = (text: string, phase = 'final_answer') => ({
  type: 'response_item',
  payload: {
    type: 'message',
    id: 'msg_a',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
    phase,
  },
});
const functionCall = (callId: string, cmd: string) => ({
  type: 'response_item',
  payload: {
    type: 'function_call',
    name: 'exec_command',
    arguments: JSON.stringify({ cmd, workdir: 'C:/wd' }),
    call_id: callId,
    id: 'fc_1',
  },
});
const functionOutput = (callId: string, output: string) => ({
  type: 'response_item',
  payload: {
    type: 'function_call_output',
    call_id: callId,
    output,
    id: 'fco_1',
  },
});
const tokenCount = () => ({
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      last_token_usage: {
        input_tokens: 10504,
        cached_input_tokens: 3072,
        output_tokens: 31,
      },
    },
  },
});
const taskComplete = (last: string, turnId = TURN) => ({
  type: 'event_msg',
  payload: {
    type: 'task_complete',
    turn_id: turnId,
    last_agent_message: last,
    duration_ms: 3661,
  },
});
const turnAborted = () => ({
  type: 'event_msg',
  payload: { type: 'turn_aborted', turn_id: TURN, reason: 'interrupted' },
});
const abortedUser = () =>
  userMsg('<turn_aborted>\nThe user interrupted the previous turn.');

const hookBase = {
  session_id: SESSION,
  permission_mode: 'default',
  model: 'gpt-5.3-codex-spark',
  transcript_path: 'C:/home/sessions/2026/09/06/rollout.jsonl',
};

async function drained(
  events: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}
const types = (events: ProviderEvent[]) => events.map((e) => e.type);

describe('CodexTurnObserver — chat turns (claimed)', () => {
  it('a text turn: prompt accepted by the hook, text from the rollout, Stop closes it', async () => {
    const h = new Harness();
    const claim = h.observer.claimNextTurn('Reply with exactly the word: PONG');
    h.line(meta());
    h.line(taskStarted());
    h.line(developer());
    h.line(envContext());
    await h.tick();
    expect(claim.accepted).toBe(false); // context lines are not the prompt
    h.hook('SessionStart', { ...hookBase, source: 'startup' });
    h.hook('UserPromptSubmit', {
      ...hookBase,
      turn_id: TURN,
      prompt: 'Reply with exactly the word: PONG',
    });
    await h.tick();
    expect(claim.accepted).toBe(true);
    expect(h.accepted).toBe(1);
    h.line(userMsg('Reply with exactly the word: PONG')); // rollout copy, same turn → no injection
    h.line(itemCompleted('UserMessage', 'u1'));
    await h.tick();
    h.line(itemCompleted('Reasoning', 'rs_1'));
    h.line(reasoning());
    h.line(itemCompleted('AgentMessage', 'msg_a'));
    h.line(assistant('PONG'));
    h.line(tokenCount());
    await h.tick();
    h.hook('Stop', {
      ...hookBase,
      turn_id: TURN,
      last_assistant_message: 'PONG',
    });
    h.line(taskComplete('PONG'));
    await h.tick();
    const events = await drained(claim.events);
    expect(types(events)).toEqual([
      ProviderEventType.Content,
      ProviderEventType.Finished,
    ]);
    expect((events[0] as { text: string }).text).toBe('PONG');
    expect(
      (events[1] as { usage?: { inputTokens?: number } }).usage?.inputTokens,
    ).toBe(10504);
    expect(h.notices.filter((n) => n.kind === 'user_message')).toHaveLength(0);
    expect(h.externalTurns).toHaveLength(0);
    expect(h.sessionChanges).toHaveLength(0); // startup is not a change
  });

  it('a tool turn streams text → tool card → result → text in rollout order; the hook copies are deduplicated', async () => {
    const h = new Harness();
    const claim = h.observer.claimNextTurn(
      'Say BEFORE, run echo probe-42, say AFTER',
    );
    h.hook('UserPromptSubmit', {
      ...hookBase,
      turn_id: TURN,
      prompt: 'Say BEFORE, run echo probe-42, say AFTER',
    });
    await h.tick();
    h.line(assistant('Running the requested command next.', 'commentary'));
    h.line(functionCall('call_1', 'echo probe-42'));
    await h.tick();
    h.hook('PreToolUse', {
      ...hookBase,
      turn_id: TURN,
      tool_name: 'Bash',
      tool_use_id: 'call_1',
      tool_input: { command: 'echo probe-42' },
    });
    await h.tick();
    h.line(itemCompleted('CommandExecution', 'call_1', 'completed'));
    h.hook('PostToolUse', {
      ...hookBase,
      turn_id: TURN,
      tool_name: 'Bash',
      tool_use_id: 'call_1',
      tool_response: 'probe-42',
    });
    await h.tick();
    h.line(
      functionOutput(
        'call_1',
        'Chunk ID: 6b8576\nWall time: 0.47 seconds\nProcess exited with code 0\nOutput:\nprobe-42',
      ),
    );
    h.line(assistant('BEFORE\nAFTER: `probe-42`'));
    h.hook('Stop', {
      ...hookBase,
      turn_id: TURN,
      last_assistant_message: 'BEFORE\nAFTER: `probe-42`',
    });
    await h.tick();
    const events = await drained(claim.events);
    expect(types(events)).toEqual([
      ProviderEventType.Content,
      ProviderEventType.ToolUse,
      ProviderEventType.ToolResult,
      ProviderEventType.Content,
      ProviderEventType.Finished,
    ]);
    const tool = events[1] as {
      toolName: string;
      toolId: string;
      input: Record<string, unknown>;
    };
    expect(tool.toolName).toBe('Bash');
    expect(tool.toolId).toBe('call_1');
    expect(tool.input['cmd']).toBe('echo probe-42');
    const result = events[2] as { isError: boolean; output: string };
    expect(result.isError).toBe(false);
    expect(result.output).toBe('probe-42'); // the hook result came first; the rollout copy is dropped
  });

  it('task_complete alone closes the turn after the settle window when the Stop hook is dropped', async () => {
    const h = new Harness();
    const claim = h.observer.claimNextTurn('hi');
    h.hook('UserPromptSubmit', { ...hookBase, turn_id: TURN, prompt: 'hi' });
    await h.tick();
    h.line(assistant('hello'));
    h.line(taskComplete('hello'));
    await h.tick();
    expect(claim.done).toBe(false);
    await h.tick(700);
    expect(claim.done).toBe(true);
    expect(types(await drained(claim.events)).at(-1)).toBe(
      ProviderEventType.Finished,
    );
  });
});

describe('CodexTurnObserver — external turns and interrupts', () => {
  it('a turn typed in the terminal is delivered with the same stream, with the rollout user line as its text', async () => {
    const h = new Harness();
    h.line(taskStarted('t-ext'));
    h.line(userMsg('Reply with exactly the word: EXT'));
    await h.tick();
    expect(h.externalTurns).toHaveLength(1);
    expect(h.externalTurns[0].userText).toBe(
      'Reply with exactly the word: EXT',
    );
    expect(h.externalTurns[0].promptId).toBe('t-ext');
    expect(h.externalTurns[0].source).toBe('terminal');
    h.hook('UserPromptSubmit', {
      ...hookBase,
      turn_id: 't-ext',
      prompt: 'Reply with exactly the word: EXT',
    }); // late hook copy
    h.line(reasoning(['Answering briefly.']));
    h.line(assistant('EXT'));
    h.hook('Stop', {
      ...hookBase,
      turn_id: 't-ext',
      last_assistant_message: 'EXT',
    });
    await h.tick();
    const events = await drained(h.externalTurns[0].events);
    expect(types(events)).toEqual([
      ProviderEventType.Thinking,
      ProviderEventType.Content,
      ProviderEventType.Finished,
    ]);
    expect(h.notices.filter((n) => n.kind === 'user_message')).toHaveLength(0);
  });

  it('Esc: the aborted output, the <turn_aborted> line, Interrupt and turn_aborted close the turn once with an errored card', async () => {
    const h = new Harness();
    h.hook('UserPromptSubmit', {
      ...hookBase,
      turn_id: TURN,
      prompt: 'run a slow command',
    });
    await h.tick();
    h.line(functionCall('call_9', 'node -e "setTimeout(()=>1,25000)"'));
    await h.tick();
    h.line(functionOutput('call_9', 'Wall time: 3.7 seconds\naborted by user'));
    h.line(abortedUser());
    await h.tick();
    h.hook('Interrupt', { ...hookBase, turn_id: TURN });
    h.line(turnAborted());
    await h.tick();
    expect(h.externalTurns).toHaveLength(1);
    const events = await drained(h.externalTurns[0].events);
    expect(types(events)).toEqual([
      ProviderEventType.ToolUse,
      ProviderEventType.ToolResult,
      ProviderEventType.Aborted,
    ]);
    expect((events[1] as { isError: boolean }).isError).toBe(true);
    expect(h.observer.isTurnActive()).toBe(false);
  });

  it('a message typed while the turn runs is injected under the same turn_id and shown once', async () => {
    const h = new Harness();
    h.hook('UserPromptSubmit', { ...hookBase, turn_id: TURN, prompt: 'first' });
    await h.tick();
    h.line(functionCall('call_2', 'node -e "setTimeout(()=>1,12000)"'));
    await h.tick();
    h.hook('UserPromptSubmit', {
      ...hookBase,
      turn_id: TURN,
      prompt: 'Also say SECOND_DONE.',
    });
    h.line(userMsg('Also say SECOND_DONE.'));
    await h.tick();
    h.line(functionOutput('call_2', 'Process exited with code 0'));
    h.line(assistant('FIRST_DONE\nSECOND_DONE'));
    h.hook('Stop', {
      ...hookBase,
      turn_id: TURN,
      last_assistant_message: 'FIRST_DONE\nSECOND_DONE',
    });
    await h.tick();
    expect(h.externalTurns).toHaveLength(1);
    expect(h.notices.filter((n) => n.kind === 'user_message')).toHaveLength(1);
    expect(types(await drained(h.externalTurns[0].events)).at(-1)).toBe(
      ProviderEventType.Finished,
    );
  });

  it('an approval request raises an attention notice that ends when the tool result lands', async () => {
    const h = new Harness();
    h.hook('UserPromptSubmit', {
      ...hookBase,
      turn_id: TURN,
      prompt: 'create a file',
    });
    await h.tick();
    h.line(functionCall('call_3', 'echo hello > f.txt'));
    h.hook('PreToolUse', {
      ...hookBase,
      turn_id: TURN,
      tool_name: 'Bash',
      tool_use_id: 'call_3',
      tool_input: { command: 'echo hello > f.txt' },
    });
    h.hook('PermissionRequest', {
      ...hookBase,
      turn_id: TURN,
      tool_name: 'Bash',
      tool_input: { command: 'echo hello > f.txt' },
    });
    await h.tick();
    const start = h.notices.find(
      (n) => n.kind === 'attention' && n.phase === 'start',
    );
    expect(start && start.kind === 'attention' ? start.what : undefined).toBe(
      'permission',
    );
    h.line(functionOutput('call_3', 'Process exited with code 0'));
    await h.tick();
    expect(
      h.notices.some((n) => n.kind === 'attention' && n.phase === 'end'),
    ).toBe(true);
  });

  it('a failed command is an errored card (exit code / item status) and /new switches the session', async () => {
    const h = new Harness();
    h.hook('UserPromptSubmit', {
      ...hookBase,
      turn_id: TURN,
      prompt: 'run a failing command',
    });
    await h.tick();
    h.line(functionCall('call_4', 'exit 2'));
    h.line(itemCompleted('CommandExecution', 'call_4', 'failed'));
    h.line(functionOutput('call_4', 'Process exited with code 2'));
    h.line(assistant('It failed.'));
    h.hook('Stop', {
      ...hookBase,
      turn_id: TURN,
      last_assistant_message: 'It failed.',
    });
    await h.tick();
    const events = await drained(h.externalTurns[0].events);
    expect(
      (
        events.find((e) => e.type === ProviderEventType.ToolResult) as {
          isError: boolean;
        }
      ).isError,
    ).toBe(true);
    h.hook('SessionStart', {
      ...hookBase,
      session_id: 'new-session',
      source: 'clear',
    });
    await h.tick();
    expect(h.sessionChanges).toEqual([{ id: 'new-session', source: 'clear' }]);
  });

  it('idle fallback: no Stop, no task_complete, the prompt is back → finalize after the idle window', async () => {
    const h = new Harness();
    h.hook('UserPromptSubmit', { ...hookBase, turn_id: TURN, prompt: 'hi' });
    await h.tick();
    h.line(assistant('done'));
    await h.tick();
    h.idlePrompt = true;
    await h.tick(21_000);
    expect(h.observer.isTurnActive()).toBe(false);
    expect(types(await drained(h.externalTurns[0].events)).at(-1)).toBe(
      ProviderEventType.Finished,
    );
  });
});

describe('helpers', () => {
  it('maps Codex tool names and parses arguments', () => {
    expect(mapCodexToolName('exec_command')).toBe('Bash');
    expect(mapCodexToolName('apply_patch')).toBe('ApplyPatch');
    expect(mapCodexToolName('auditaria-tools__knowledge_search')).toBe(
      'auditaria-tools__knowledge_search',
    );
    expect(parseToolArguments('{"cmd":"ls"}')).toEqual({ cmd: 'ls' });
    expect(parseToolArguments('not json')).toEqual({ arguments: 'not json' });
    expect(parseToolArguments(undefined)).toEqual({});
  });
  it('detects failed outputs', () => {
    expect(outputLooksFailed('Process exited with code 0\nok')).toBe(false);
    expect(outputLooksFailed('Process exited with code 2')).toBe(true);
    expect(outputLooksFailed('Wall time: 3.7 seconds\naborted by user')).toBe(
      true,
    );
  });
});
