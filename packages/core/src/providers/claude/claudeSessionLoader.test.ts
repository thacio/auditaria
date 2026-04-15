/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Content } from '@google/genai';
import { loadClaudeSessionAsContent } from './claudeSessionLoader.js';

// Build a Claude JSONL file in a temp dir from an array of entry objects,
// then parse it and return the Content[].
async function parseEntries(
  entries: Array<Record<string, unknown>>,
): Promise<Content[]> {
  const dir = mkdtempSync(join(tmpdir(), 'claude-loader-'));
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n'));
  try {
    return await loadClaudeSessionAsContent(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Convenience factories matching real Claude JSONL shapes.
const userText = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { role: 'user', content: text },
  ...extra,
});
const assistantLine = (id: string, blocks: Array<Record<string, unknown>>) => ({
  type: 'assistant',
  message: { id, role: 'assistant', content: blocks },
});
const userToolResult = (toolUseId: string, output: string | unknown[]) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content: output }],
  },
});

describe('loadClaudeSessionAsContent', () => {
  it('returns [] for a missing file', async () => {
    const result = await loadClaudeSessionAsContent('/nonexistent/path.jsonl');
    expect(result).toEqual([]);
  });

  it('parses a simple text-only exchange', async () => {
    const result = await parseEntries([
      userText('hello'),
      assistantLine('msg1', [{ type: 'text', text: 'hi there' }]),
    ]);
    expect(result).toEqual([
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'hi there' }] },
    ]);
  });

  it('groups multi-line assistant streaming by message.id', async () => {
    // Real Claude JSONL splits blocks across lines sharing message.id.
    const result = await parseEntries([
      userText('search'),
      assistantLine('msg1', [{ type: 'text', text: 'Let me check.' }]),
      assistantLine('msg1', [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Bash',
          input: { command: 'ls' },
        },
      ]),
      userToolResult('toolu_1', 'file1\nfile2'),
      assistantLine('msg2', [{ type: 'text', text: 'Found 2 files.' }]),
    ]);

    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ role: 'user', parts: [{ text: 'search' }] });
    // msg1 became ONE model entry with text + functionCall
    expect(result[1]).toEqual({
      role: 'model',
      parts: [
        { text: 'Let me check.' },
        { functionCall: { name: 'Bash', args: { command: 'ls' } } },
      ],
    });
    // tool_result became a user functionResponse
    expect(result[2]).toEqual({
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'toolu_1',
            name: 'Bash',
            response: { output: 'file1\nfile2' },
          },
        },
      ],
    });
    expect(result[3]).toEqual({
      role: 'model',
      parts: [{ text: 'Found 2 files.' }],
    });
  });

  it('decodes image blocks into inlineData', async () => {
    const result = await parseEntries([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'look at this' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'AAAA',
              },
            },
          ],
        },
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].parts).toEqual([
      { text: 'look at this' },
      { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
    ]);
  });

  it('skips system_context and auditaria_conversation_history prefixes', async () => {
    const result = await parseEntries([
      userText('<session_context>\nEnv info</session_context>'),
      userText(
        '<auditaria_conversation_history>\nstuff</auditaria_conversation_history>',
      ),
      userText('actual message'),
      assistantLine('msg1', [{ type: 'text', text: 'ack' }]),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].parts).toEqual([{ text: 'actual message' }]);
  });

  it('skips meta, sidechain, and bookkeeping entries', async () => {
    const result = await parseEntries([
      { type: 'file-history-snapshot', messageId: 'x' },
      { type: 'queue-operation', operation: 'enqueue' },
      { type: 'last-prompt', prompt: 'stale' },
      userText('real prompt', { isMeta: true }),
      userText('sidechain prompt', { isSidechain: true }),
      userText('kept'),
      assistantLine('msg1', [{ type: 'text', text: 'ok' }]),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].parts).toEqual([{ text: 'kept' }]);
  });

  it('skips local_command system messages', async () => {
    const result = await parseEntries([
      userText('hello'),
      { type: 'system', subtype: 'local_command', content: 'foo' },
      assistantLine('msg1', [{ type: 'text', text: 'hi' }]),
    ]);
    expect(result).toHaveLength(2);
  });

  it('skips thinking blocks', async () => {
    const result = await parseEntries([
      userText('q'),
      assistantLine('msg1', [
        { type: 'thinking', thinking: 'internal reasoning' },
        { type: 'text', text: 'answer' },
      ]),
    ]);
    expect(result[1]).toEqual({
      role: 'model',
      parts: [{ text: 'answer' }],
    });
  });

  it('handles tool_result where content is an array of text blocks', async () => {
    const result = await parseEntries([
      userText('q'),
      assistantLine('msg1', [
        {
          type: 'tool_use',
          id: 'toolu_2',
          name: 'Read',
          input: { file: 'a.txt' },
        },
      ]),
      userToolResult('toolu_2', [
        { type: 'text', text: 'line1' },
        { type: 'text', text: 'line2' },
      ]),
    ]);
    const resp = result[2].parts![0];
    expect(resp).toHaveProperty('functionResponse');
    const fr = (
      resp as {
        functionResponse: { name: string; response: { output: string } };
      }
    ).functionResponse;
    expect(fr.response.output).toBe('line1\nline2');
    expect(fr.name).toBe('Read');
  });

  it('pads a dangling tool call at end-of-session with a placeholder response', async () => {
    const result = await parseEntries([
      userText('q'),
      assistantLine('msg1', [
        {
          type: 'tool_use',
          id: 'toolu_hang',
          name: 'Bash',
          input: { command: 'sleep' },
        },
      ]),
      // No tool_result follows — session was truncated mid-tool.
    ]);

    expect(result).toHaveLength(3);
    expect(result[1].role).toBe('model');
    expect(result[2].role).toBe('user');
    const part = result[2].parts![0];
    expect(part).toHaveProperty('functionResponse');
    const fr = (
      part as { functionResponse: { id: string; response: { output: string } } }
    ).functionResponse;
    expect(fr.id).toBe('toolu_hang');
    expect(fr.response.output).toContain('not captured');
  });

  it('applies compaction with Claude-provided summary', async () => {
    // Build a small conversation that crosses findCompressSplitPoint.
    // 4-entry threshold in compactMirroredHistory; we give > 4 entries.
    const entries: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 6; i++) {
      entries.push(userText(`msg-${i}`));
      entries.push(
        assistantLine(`m${i}`, [{ type: 'text', text: `reply-${i}` }]),
      );
    }
    entries.push({ type: 'system', subtype: 'compact_boundary' });
    entries.push(userText('CLAUDE SUMMARY TEXT'));
    entries.push(userText('after compact'));
    entries.push(
      assistantLine('final', [{ type: 'text', text: 'post-compact reply' }]),
    );

    const result = await parseEntries(entries);

    // First entry should be <state_snapshot> user turn.
    expect(result.length).toBeGreaterThanOrEqual(2);
    const firstText = (result[0].parts![0] as { text: string }).text;
    expect(firstText).toContain('<state_snapshot>');
    expect(firstText).toContain('CLAUDE SUMMARY TEXT');
    // Model ack
    expect((result[1].parts![0] as { text: string }).text).toMatch(/Got it\./);
    // Post-compact content is preserved at the tail.
    const lastModel = result[result.length - 1];
    expect(lastModel.role).toBe('model');
    expect((lastModel.parts![0] as { text: string }).text).toBe(
      'post-compact reply',
    );
  });

  it('applies fallback marker when compact_boundary is not followed by a summary', async () => {
    const entries: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 5; i++) {
      entries.push(userText(`msg-${i}`));
      entries.push(
        assistantLine(`m${i}`, [{ type: 'text', text: `reply-${i}` }]),
      );
    }
    entries.push({ type: 'system', subtype: 'compact_boundary' });
    // Next message is an assistant turn — summary never came.
    entries.push(
      assistantLine('after', [{ type: 'text', text: 'straight to reply' }]),
    );

    const result = await parseEntries(entries);
    const firstText = (result[0].parts![0] as { text: string }).text;
    expect(firstText).toContain('<context_compacted>');
  });

  it('skips malformed JSONL lines without crashing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-loader-'));
    const file = join(dir, 'session.jsonl');
    const raw = [
      JSON.stringify(userText('valid')),
      'not-json garbage',
      JSON.stringify(assistantLine('m1', [{ type: 'text', text: 'ok' }])),
    ].join('\n');
    writeFileSync(file, raw);
    try {
      const result = await loadClaudeSessionAsContent(file);
      expect(result).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
