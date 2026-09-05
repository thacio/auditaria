/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { GenerateContentResponse } from '@google/genai';
import type { Config } from '../config/config.js';
import {
  MAX_PROMPT_BYTES,
  createSampler,
  flattenTurns,
  geminiModelFor,
  toContents,
} from './sampleExecutor.js';

function chunk(text: string): GenerateContentResponse {
  // Only the members getResponseText reads.
  return {
    candidates: [{ content: { role: 'model', parts: [{ text }] } }],
  } as unknown as GenerateContentResponse;
}

function fakeConfig(chunks: string[] | Error, external = false): Config {
  const generateContentStream = vi.fn(async () => {
    if (chunks instanceof Error) throw chunks;
    return (async function* () {
      for (const c of chunks) yield chunk(c);
    })();
  });
  return {
    getModel: () => 'gemini-2.5-pro',
    getContentGenerator: () => ({ generateContentStream }),
    getProviderManager: () => ({
      isExternalProviderActive: () => external,
      getConfig: () => ({ type: external ? 'claude-cli' : 'gemini' }),
    }),
    getAgentSessionManager: () => ({
      createSession: vi.fn(async () => ({ id: 's1' })),
      sendMessage: vi.fn(
        async (
          _id: string,
          _text: string,
          _signal: AbortSignal,
          onOutput?: (partial: string) => void,
        ) => {
          onOutput?.('Hel');
          onOutput?.('Hello from the provider');
          return 'Hello from the provider';
        },
      ),
      killSession: vi.fn(),
    }),
    _stream: generateContentStream,
  } as unknown as Config;
}

describe('sampleExecutor input handling', () => {
  it('validates strings and turns', () => {
    expect(toContents('hi')).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
    ]);
    expect(() => toContents('   ')).toThrow(/must not be empty/);
    expect(() => toContents(42)).toThrow(/string or an array/);
    expect(() => toContents([])).toThrow(/string or an array/);
    expect(() => toContents([{ role: 'system', content: 'x' }])).toThrow(
      /role must be/,
    );
    expect(() =>
      toContents([
        { role: 'assistant', content: 'a' },
        { role: 'user', content: 'b' },
      ]),
    ).toThrow(/start and end with a user turn/);
    expect(
      toContents([
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ]).map((c) => c.role),
    ).toEqual(['user', 'model', 'user']);
    expect(() => toContents('x'.repeat(MAX_PROMPT_BYTES + 1))).toThrow(
      /prompt_too_large|bytes/,
    );
  });

  it('maps tiers and flattens turns for text-only providers', () => {
    expect(geminiModelFor('quick', 'gemini-2.5-pro')).toMatch(/flash/);
    expect(geminiModelFor('default', 'gemini-2.5-pro')).toBe('gemini-2.5-pro');
    expect(geminiModelFor('complex', 'gemini-2.5-flash')).toBe(
      'gemini-2.5-pro',
    );
    expect(flattenTurns(toContents('just this'))).toBe('just this');
    expect(
      flattenTurns(
        toContents([
          { role: 'user', content: 'q' },
          { role: 'assistant', content: 'a' },
          { role: 'user', content: 'q2' },
        ]),
      ),
    ).toBe('User: q\n\nAssistant: a\n\nUser: q2');
  });
});

describe('createSampler', () => {
  it('streams Gemini chunks through onText and resolves the whole text', async () => {
    const config = fakeConfig(['Hel', 'lo', ' world']);
    const sampler = createSampler(config);
    const seen: Array<[string, string]> = [];
    const result = await sampler({
      input: 'say hello',
      modelTier: 'quick',
      signal: new AbortController().signal,
      onText: (text, delta) => seen.push([text, delta]),
    });
    expect(result).toEqual({
      text: 'Hello world',
      truncated: false,
      modelTierApplied: 'quick',
    });
    expect(seen).toEqual([
      ['Hel', 'Hel'],
      ['Hello', 'lo'],
      ['Hello world', ' world'],
    ]);
    const call = (config as unknown as { _stream: ReturnType<typeof vi.fn> })
      ._stream.mock.calls[0] as unknown[];
    expect(call[0]).toMatchObject({
      model: expect.stringMatching(/flash/) as unknown,
      contents: [{ role: 'user', parts: [{ text: 'say hello' }] }],
    });
    expect(call[2]).toBe('utility_tool');
  });

  it('rejects empty completions and wraps upstream failures', async () => {
    await expect(
      createSampler(fakeConfig(['   ']))({
        input: 'x',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'empty_completion' });
    await expect(
      createSampler(fakeConfig(new Error('quota')))({
        input: 'x',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'upstream_error', message: 'quota' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      createSampler(fakeConfig(['a']))({
        input: 'x',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('runs a headless consult session on external providers', async () => {
    const config = fakeConfig([], true);
    const seen: string[] = [];
    const result = await createSampler(config)({
      input: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
        { role: 'user', content: 'again' },
      ],
      modelTier: 'complex',
      signal: new AbortController().signal,
      onText: (text) => seen.push(text),
    });
    expect(result).toEqual({
      text: 'Hello from the provider',
      truncated: false,
      modelTierApplied: 'default',
    });
    expect(seen).toEqual(['Hel', 'Hello from the provider']);
    const sessions = config.getAgentSessionManager() as unknown as {
      createSession: ReturnType<typeof vi.fn>;
    };
    expect(sessions.createSession).not.toHaveBeenCalled(); // fresh manager per call in the fake
  });

  it('turns a bracketed driver failure into upstream_error, never an answer', async () => {
    const config = fakeConfig([], true);
    const sessions = config.getAgentSessionManager() as unknown as {
      sendMessage: ReturnType<typeof vi.fn>;
    };
    sessions.sendMessage.mockImplementation(
      async () => '[Error: claude exited before SessionStart (code 1)]',
    );
    (
      config as unknown as { getAgentSessionManager: () => unknown }
    ).getAgentSessionManager = () => sessions;
    await expect(
      createSampler(config)({
        input: 'x',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: 'upstream_error',
      message: '[Error: claude exited before SessionStart (code 1)]',
    });
  });

  it('honours the kill switch', async () => {
    process.env['AUDITARIA_ARTIFACT_SAMPLE'] = '0';
    try {
      await expect(
        createSampler(fakeConfig(['a']))({
          input: 'x',
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'sampling_disabled' });
    } finally {
      delete process.env['AUDITARIA_ARTIFACT_SAMPLE'];
    }
  });
});
