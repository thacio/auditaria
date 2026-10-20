/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_AGY_PROVIDER: Unit tests for the pure logic of the agy driver —
 * model-name mapping, terminal-scrape cleaning, and transcript→event mapping.
 * These mirror behavior validated empirically against the live agy binary.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  AgyCLIDriver,
  AGY_MODEL_DISPLAY,
  getAgyModelDisplayName,
  cleanAgyOutput,
  mapAgyEntry,
} from './agyCLIDriver.js';
import {
  AGY_MODEL_IDS,
  ProviderEventType,
  type ProviderEvent,
} from '../types.js';
import type { AgyTranscriptEntry } from './types.js';
import { agyTokenLimit } from '../../core/tokenLimits.js';
import { getCachedAgyModels } from './agyModelCatalog.js';
import { getPty } from '../../utils/getPty.js';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
}));
vi.mock('../../utils/getPty.js', () => ({ getPty: vi.fn() }));

vi.mock('./agyModelCatalog.js', () => ({
  getCachedAgyModels: vi.fn(),
}));

describe('getAgyModelDisplayName', () => {
  beforeEach(() => {
    vi.mocked(getCachedAgyModels).mockReturnValue(undefined);
  });

  it('returns undefined for auto / undefined (omit --model)', () => {
    expect(getAgyModelDisplayName(undefined)).toBeUndefined();
    expect(getAgyModelDisplayName('auto')).toBeUndefined();
  });

  it('maps known terse ids to agy display names', () => {
    expect(getAgyModelDisplayName('gemini-3.5-flash-low')).toBe(
      'Gemini 3.5 Flash (Low)',
    );
    expect(getAgyModelDisplayName('claude-sonnet-4.6')).toBe(
      'Claude Sonnet 4.6 (Thinking)',
    );
  });

  it('passes through unknown ids unchanged', () => {
    expect(getAgyModelDisplayName('some-future-model')).toBe(
      'some-future-model',
    );
  });

  it('uses the live catalog for new ids and updated display names', () => {
    vi.mocked(getCachedAgyModels).mockReturnValue([
      { id: 'gemini-3.8-flash-low', displayName: 'Gemini 3.8 Flash (Low)' },
      { id: 'claude-sonnet-4.6', displayName: 'Updated Sonnet name' },
    ]);
    expect(getAgyModelDisplayName('gemini-3.8-flash-low')).toBe(
      'Gemini 3.8 Flash (Low)',
    );
    expect(getAgyModelDisplayName('claude-sonnet-4.6')).toBe(
      'Updated Sonnet name',
    );
  });

  it('has a display name for every catalog model id (except auto)', () => {
    for (const id of AGY_MODEL_IDS) {
      if (id === 'auto') continue;
      expect(AGY_MODEL_DISPLAY[id]).toBeTruthy();
    }
  });
});

describe('cleanAgyOutput', () => {
  it('strips OSC title-set sequences (the 0;<path> residue)', () => {
    // OSC set-title: ESC ] 0 ; <text> BEL
    const raw = 'before\x1b]0;C:\\agy.EXE\x07after';
    expect(cleanAgyOutput(raw)).toBe('beforeafter');
  });

  it('strips CSI/SGR color codes but keeps text + newlines', () => {
    const raw = '\x1b[31mhello\x1b[0m\r\nworld';
    expect(cleanAgyOutput(raw)).toBe('hello\r\nworld');
  });

  it('drops stray C0 control chars but keeps \\n \\r \\t', () => {
    const raw = 'a\x00b\x07c\td\ne';
    expect(cleanAgyOutput(raw)).toBe('abc\td\ne');
  });
});

describe('agyTokenLimit', () => {
  it('resolves the context window per model family', () => {
    expect(agyTokenLimit('agy-code:gemini-3.5-flash-low')).toBe(1_048_576);
    expect(agyTokenLimit('agy-code:gemini-3.1-pro-high')).toBe(1_048_576);
    expect(agyTokenLimit('agy-code:claude-sonnet-4.6')).toBe(200_000);
    expect(agyTokenLimit('agy-code:gpt-oss-120b')).toBe(128_000);
    expect(agyTokenLimit('agy-code:auto')).toBe(1_048_576);
  });
});

describe('mapAgyEntry', () => {
  const base = { step_index: 0, status: 'DONE' };

  it('skips user input and housekeeping rows', () => {
    for (const [source, type] of [
      ['USER_EXPLICIT', 'USER_INPUT'],
      ['SYSTEM', 'CONVERSATION_HISTORY'],
      ['SYSTEM', 'SYSTEM_MESSAGE'],
    ] as const) {
      const r = mapAgyEntry(
        { ...base, source, type } as AgyTranscriptEntry,
        [],
      );
      expect(r.processed).toBe(true);
      expect(r.events).toEqual([]);
    }
  });

  it('emits Thinking then Content for a PLANNER_RESPONSE', () => {
    const entry: AgyTranscriptEntry = {
      ...base,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      thinking: 'reasoning...',
      content: 'the answer',
    };
    const r = mapAgyEntry(entry, []);
    expect(r.processed).toBe(true);
    expect(r.events).toEqual([
      { type: ProviderEventType.Thinking, text: 'reasoning...' },
      { type: ProviderEventType.Content, text: 'the answer' },
    ]);
  });

  it('emits ToolUse for tool_calls and queues the id', () => {
    const pending: string[] = [];
    const entry: AgyTranscriptEntry = {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [{ name: 'list_dir', args: { DirectoryPath: '.' } }],
    };
    const r = mapAgyEntry(entry, pending);
    expect(r.events).toEqual([
      {
        type: ProviderEventType.ToolUse,
        toolName: 'list_dir',
        toolId: 'agy-2-0',
        input: { DirectoryPath: '.' },
      },
    ]);
    expect(pending).toEqual(['agy-2-0']);
  });

  it('pairs a tool-result step with the queued ToolUse id (FIFO)', () => {
    const pending = ['agy-2-0'];
    const entry: AgyTranscriptEntry = {
      step_index: 3,
      source: 'MODEL',
      type: 'LIST_DIRECTORY',
      status: 'DONE',
      content: 'Created At: x\nCompleted At: y\nfile1\nfile2',
    };
    const r = mapAgyEntry(entry, pending);
    expect(r.processed).toBe(true);
    expect(r.events).toEqual([
      {
        type: ProviderEventType.ToolResult,
        toolId: 'agy-2-0',
        output: 'file1\nfile2',
        isError: false,
      },
    ]);
    expect(pending).toEqual([]); // dequeued
  });

  it('leaves a RUNNING tool result unprocessed (re-read next poll)', () => {
    const entry: AgyTranscriptEntry = {
      step_index: 4,
      source: 'MODEL',
      type: 'RUN_COMMAND',
      status: 'RUNNING',
      content: 'partial...',
    };
    const r = mapAgyEntry(entry, []);
    expect(r.processed).toBe(false);
    expect(r.events).toEqual([]);
  });

  it('falls back to a step-derived id when no ToolUse is queued', () => {
    const entry: AgyTranscriptEntry = {
      step_index: 9,
      source: 'MODEL',
      type: 'VIEW_FILE',
      status: 'DONE',
      content: 'contents',
    };
    const r = mapAgyEntry(entry, []);
    expect(r.events[0]).toMatchObject({
      type: ProviderEventType.ToolResult,
      toolId: 'agy-9',
    });
  });
});

describe('AgyCLIDriver process results', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(readFileSync).mockReturnValue('');
    vi.mocked(getCachedAgyModels).mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runTurn(
    output: string,
    exitCode: number,
    partialTranscript?: string,
  ): Promise<ProviderEvent[]> {
    const disposable = { dispose: vi.fn() };
    vi.mocked(getPty).mockResolvedValue({
      name: 'node-pty',
      module: {
        spawn: () => ({
          pid: 0,
          write: vi.fn(),
          kill: vi.fn(),
          onData: (callback: (data: string) => void) => {
            callback(output);
            return disposable;
          },
          onExit: (callback: (event: { exitCode: number }) => void) => {
            callback({ exitCode });
            return disposable;
          },
        }),
      },
    });
    const driver = new AgyCLIDriver({ cwd: '.', model: 'auto' });
    if (partialTranscript) {
      driver.setSessionId('existing');
      vi.mocked(readFileSync)
        .mockReturnValue(partialTranscript)
        .mockReturnValueOnce('');
    }
    const result = (async () => {
      const events: ProviderEvent[] = [];
      for await (const event of driver.sendMessage(
        'Return the result',
        new AbortController().signal,
      )) {
        events.push(event);
      }
      return events;
    })();
    try {
      await vi.runAllTimersAsync();
      return await result;
    } finally {
      driver.dispose();
    }
  }

  it.each([0, 1])(
    'reports startup errors as failures instead of content (exit %s)',
    async (exitCode) => {
      const events = await runTurn(
        '\x1b[31merror: invalid model selection: retired-model\x1b[0m\r\n',
        exitCode,
      );
      expect(events).toEqual([
        {
          type: ProviderEventType.Error,
          message: 'error: invalid model selection: retired-model',
        },
        { type: ProviderEventType.Finished },
      ]);
    },
  );

  it('reports a nonzero exit after emitting partial transcript content', async () => {
    const events = await runTurn(
      '',
      7,
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Partial answer',
      }),
    );
    expect(events).toEqual([
      { type: ProviderEventType.Content, text: 'Partial answer' },
      { type: ProviderEventType.Error, message: 'agy exited with code 7.' },
      { type: ProviderEventType.Finished },
    ]);
  });

  it('keeps successful terminal fallback content', async () => {
    expect(await runTurn('Completed result', 0)).toEqual([
      { type: ProviderEventType.Content, text: 'Completed result' },
      { type: ProviderEventType.Finished },
    ]);
  });
});
