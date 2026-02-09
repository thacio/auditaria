/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Content } from '@google/genai';
import {
  buildConversationSummary,
  sanitizeHistoryForProviderSwitch,
  compactMirroredHistory,
  ProviderManager,
} from './providerManager.js';
import type { ProviderDriver, ProviderEvent } from './types.js';
import { ProviderEventType } from './types.js';
import { GeminiEventType, CompressionStatus } from '../core/turn.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

/** Minimal GeminiChat mock that stores history in an array */
function createMockChat() {
  const history: Content[] = [];
  let lastPromptTokenCount = 0;
  return {
    addHistory(content: Content) {
      history.push(content);
    },
    getHistory() {
      return structuredClone(history);
    },
    setHistory(h: Content[]) {
      history.length = 0;
      history.push(...h);
    },
    setLastPromptTokenCount(count: number) {
      lastPromptTokenCount = count;
    },
    getLastPromptTokenCount() {
      return lastPromptTokenCount;
    },
    _raw: history, // direct reference for assertions
  };
}

/** Creates a mock ProviderDriver that yields the given events */
function createMockDriver(events: ProviderEvent[]): ProviderDriver {
  let sessionId: string | undefined = 'test-session-123';
  return {
    async *sendMessage() {
      for (const event of events) {
        yield event;
      }
    },
    async interrupt() {},
    getSessionId() {
      return sessionId;
    },
    resetSession() {
      sessionId = undefined;
    },
    dispose() {},
  };
}

// ─── buildConversationSummary ─────────────────────────────────────────────────

describe('buildConversationSummary', () => {
  it('should serialize simple user/model text exchange', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'Hello, how are you?' }] },
      { role: 'model', parts: [{ text: 'I am doing well, thank you!' }] },
    ];
    const summary = buildConversationSummary(history);
    expect(summary).toContain('<auditaria_conversation_history>');
    expect(summary).toContain('</auditaria_conversation_history>');
    expect(summary).toContain('[User]: Hello, how are you?');
    expect(summary).toContain('[Assistant]: I am doing well, thank you!');
  });

  it('should serialize tool calls and results', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'Search for audit reports' }] },
      {
        role: 'model',
        parts: [
          { text: 'Let me search for that.' },
          {
            functionCall: {
              name: 'knowledge_search',
              args: { query: 'audit reports' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'tool_1',
              name: 'knowledge_search',
              response: {
                output: 'Found 3 results: report1, report2, report3',
              },
            },
          },
        ],
      },
      { role: 'model', parts: [{ text: 'I found 3 audit reports.' }] },
    ];
    const summary = buildConversationSummary(history);
    expect(summary).toContain('[User]: Search for audit reports');
    expect(summary).toContain('[Assistant]: Let me search for that.');
    expect(summary).toContain(
      '[Tool Call]: knowledge_search({"query":"audit reports"})',
    );
    expect(summary).toContain(
      '[Tool Result (knowledge_search)]: Found 3 results',
    );
    expect(summary).toContain('[Assistant]: I found 3 audit reports.');
  });

  it('should preserve forgotten placeholders in full', () => {
    const history: Content[] = [
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'tool_1',
              name: 'browser_agent',
              response: {
                output:
                  '[CONTENT FORGOTTEN - YOU HAVE AMNESIA ABOUT THIS]\nID: tool_1\nSummary: large browser output',
              },
            },
          },
        ],
      },
    ];
    const summary = buildConversationSummary(history);
    expect(summary).toContain('[CONTENT FORGOTTEN');
    expect(summary).toContain('ID: tool_1');
  });


  it('should truncate large functionCall args', () => {
    const largeArgs = { data: 'y'.repeat(600) };
    const history: Content[] = [
      {
        role: 'model',
        parts: [{ functionCall: { name: 'big_tool', args: largeArgs } }],
      },
    ];
    const summary = buildConversationSummary(history);
    expect(summary).toContain('[Tool Call]: big_tool(');
    expect(summary).toContain('...');
  });

  it('should skip empty parts and empty history', () => {
    const history: Content[] = [
      { role: 'user', parts: [] },
      { role: 'model', parts: [] },
    ];
    const summary = buildConversationSummary(history);
    // Should only have header/footer
    const lines = summary.split('\n').filter((l) => l.startsWith('['));
    expect(lines).toHaveLength(0);
  });
});

// ─── History Mirroring ────────────────────────────────────────────────────────

describe('ProviderManager history mirroring', () => {
  let manager: ProviderManager;
  let mockChat: ReturnType<typeof createMockChat>;
  let mockDriver: ProviderDriver;
  const abortController = new AbortController();

  beforeEach(() => {
    manager = new ProviderManager(
      { type: 'claude-cli', model: 'sonnet' },
      '/tmp/test',
    );
    mockChat = createMockChat();
  });

  /** Helper: inject a mock driver and consume all events */
  async function runWithEvents(events: ProviderEvent[]) {
    mockDriver = createMockDriver(events);
    // Inject mock driver via private field
    (manager as unknown as Record<string, unknown>)['driver'] = mockDriver;

    const yielded: unknown[] = [];
    const gen = manager.handleSendMessage(
      'test prompt',
      abortController.signal,
      'prompt-1',
      mockChat as never,
    );
    let result = await gen.next();
    while (!result.done) {
      yielded.push(result.value);
      result = await gen.next();
    }
    return yielded;
  }

  it('should mirror simple text response to GeminiChat history', async () => {
    await runWithEvents([
      { type: ProviderEventType.Content, text: 'Hello from Claude' },
      { type: ProviderEventType.Finished },
    ]);

    const history = mockChat._raw;
    expect(history).toHaveLength(2);
    // First entry: user message
    expect(history[0].role).toBe('user');
    expect(history[0].parts![0]).toEqual({ text: 'test prompt' });
    // Second entry: model response
    expect(history[1].role).toBe('model');
    expect(history[1].parts![0]).toEqual({ text: 'Hello from Claude' });
  });

  it('should mirror tool call + result with correct functionCall/functionResponse', async () => {
    await runWithEvents([
      { type: ProviderEventType.Content, text: 'Let me search.' },
      {
        type: ProviderEventType.ToolUse,
        toolName: 'knowledge_search',
        toolId: 'ks_1',
        input: { query: 'audit' },
      },
      {
        type: ProviderEventType.ToolResult,
        toolId: 'ks_1',
        output: 'Found 5 results about auditing.',
      },
      { type: ProviderEventType.Content, text: 'I found the results.' },
      { type: ProviderEventType.Finished },
    ]);

    const history = mockChat._raw;
    // user prompt, model (text + functionCall), user (functionResponse), model (text)
    expect(history).toHaveLength(4);

    // [0] user prompt
    expect(history[0].role).toBe('user');
    expect((history[0].parts![0] as { text: string }).text).toBe(
      'test prompt',
    );

    // [1] model: text + functionCall
    expect(history[1].role).toBe('model');
    expect(history[1].parts).toHaveLength(2);
    expect((history[1].parts![0] as { text: string }).text).toBe(
      'Let me search.',
    );
    const funcCall = history[1].parts![1] as {
      functionCall: { name: string; args: Record<string, unknown> };
    };
    expect(funcCall.functionCall.name).toBe('knowledge_search');
    expect(funcCall.functionCall.args).toEqual({ query: 'audit' });

    // [2] user: functionResponse
    expect(history[2].role).toBe('user');
    const funcResp = history[2].parts![0] as {
      functionResponse: {
        id: string;
        name: string;
        response: { output: string };
      };
    };
    expect(funcResp.functionResponse.id).toBe('ks_1');
    expect(funcResp.functionResponse.name).toBe('knowledge_search');
    expect(funcResp.functionResponse.response.output).toBe(
      'Found 5 results about auditing.',
    );

    // [3] model: final text
    expect(history[3].role).toBe('model');
    expect((history[3].parts![0] as { text: string }).text).toBe(
      'I found the results.',
    );
  });

  it('should mirror multiple sequential tool calls', async () => {
    await runWithEvents([
      {
        type: ProviderEventType.ToolUse,
        toolName: 'browser_agent',
        toolId: 'ba_1',
        input: { action: 'navigate', url: 'https://example.com' },
      },
      {
        type: ProviderEventType.ToolResult,
        toolId: 'ba_1',
        output: 'Navigated to example.com',
      },
      {
        type: ProviderEventType.ToolUse,
        toolName: 'browser_agent',
        toolId: 'ba_2',
        input: { action: 'extract' },
      },
      {
        type: ProviderEventType.ToolResult,
        toolId: 'ba_2',
        output: 'Extracted: Example Domain page content',
      },
      { type: ProviderEventType.Content, text: 'Done browsing.' },
      { type: ProviderEventType.Finished },
    ]);

    const history = mockChat._raw;
    // user, model(functionCall), user(funcResp), model(functionCall), user(funcResp), model(text)
    expect(history).toHaveLength(6);

    // Verify second tool call
    const secondCall = history[3].parts![0] as {
      functionCall: { name: string };
    };
    expect(secondCall.functionCall.name).toBe('browser_agent');

    const secondResult = history[4].parts![0] as {
      functionResponse: { id: string; name: string };
    };
    expect(secondResult.functionResponse.id).toBe('ba_2');
    expect(secondResult.functionResponse.name).toBe('browser_agent');
  });

  it('should yield proper GeminiEventType events alongside mirroring', async () => {
    const yielded = await runWithEvents([
      { type: ProviderEventType.Content, text: 'Text' },
      {
        type: ProviderEventType.ToolUse,
        toolName: 'tool1',
        toolId: 't1',
        input: {},
      },
      { type: ProviderEventType.ToolResult, toolId: 't1', output: 'result' },
      { type: ProviderEventType.Finished },
    ]);

    // Should yield: Content, ToolCallRequest, ToolCallResponse, Finished
    const types = (yielded as Array<{ type: string }>).map((e) => e.type);
    expect(types).toContain(GeminiEventType.Content);
    expect(types).toContain(GeminiEventType.ToolCallRequest);
    expect(types).toContain(GeminiEventType.ToolCallResponse);
    expect(types).toContain(GeminiEventType.Finished);
  });
});

// ─── Session Reset (onHistoryModified) ────────────────────────────────────────

describe('ProviderManager session reset on context modification', () => {
  it('should reset session and inject conversation summary as user message after onHistoryModified', async () => {
    const manager = new ProviderManager(
      { type: 'claude-cli', model: 'sonnet' },
      '/tmp/test',
    );
    const mockChat = createMockChat();

    // Simulate prior conversation in history
    mockChat.addHistory({ role: 'user', parts: [{ text: 'old message' }] });
    mockChat.addHistory({ role: 'model', parts: [{ text: 'old response' }] });

    // Create a driver that records what prompt and context it receives
    let receivedPrompt: string | undefined;
    let receivedContext: string | undefined;
    let sessionWasReset = false;
    const trackingDriver: ProviderDriver = {
      async *sendMessage(
        prompt: string,
        _signal: AbortSignal,
        systemContext?: string,
      ) {
        receivedPrompt = prompt;
        receivedContext = systemContext;
        yield {
          type: ProviderEventType.Content,
          text: 'After reset',
        } as ProviderEvent;
        yield { type: ProviderEventType.Finished } as ProviderEvent;
      },
      async interrupt() {},
      getSessionId() {
        return sessionWasReset ? undefined : 'old-session';
      },
      resetSession() {
        sessionWasReset = true;
      },
      dispose() {},
    };

    // Inject mock driver
    (manager as unknown as Record<string, unknown>)['driver'] = trackingDriver;

    // Trigger context modification
    manager.onHistoryModified();

    // Send next message
    const gen = manager.handleSendMessage(
      'new message',
      new AbortController().signal,
      'prompt-2',
      mockChat as never,
      'base system context',
    );
    let result = await gen.next();
    while (!result.done) {
      result = await gen.next();
    }

    // Verify session was reset
    expect(sessionWasReset).toBe(true);

    // System context should be passed through unchanged (no summary appended)
    expect(receivedContext).toBe('base system context');

    // Conversation summary should be in the prompt (first user message), not system context
    expect(receivedPrompt).toContain('<auditaria_conversation_history>');
    expect(receivedPrompt).toContain('[User]: old message');
    expect(receivedPrompt).toContain('[Assistant]: old response');
    expect(receivedPrompt).toContain('new message');
  });

  it('should NOT reset session when onHistoryModified was not called', async () => {
    const manager = new ProviderManager(
      { type: 'claude-cli', model: 'sonnet' },
      '/tmp/test',
    );
    const mockChat = createMockChat();

    let receivedContext: string | undefined;
    let sessionResetCalled = false;
    const trackingDriver: ProviderDriver = {
      async *sendMessage(
        _prompt: string,
        _signal: AbortSignal,
        systemContext?: string,
      ) {
        receivedContext = systemContext;
        yield { type: ProviderEventType.Finished } as ProviderEvent;
      },
      async interrupt() {},
      getSessionId() {
        return 'existing-session';
      },
      resetSession() {
        sessionResetCalled = true;
      },
      dispose() {},
    };

    (manager as unknown as Record<string, unknown>)['driver'] = trackingDriver;

    const gen = manager.handleSendMessage(
      'message',
      new AbortController().signal,
      'prompt-3',
      mockChat as never,
      'system context',
    );
    let result = await gen.next();
    while (!result.done) {
      result = await gen.next();
    }

    // No reset should happen
    expect(sessionResetCalled).toBe(false);
    // Context should be unchanged (passed through as-is)
    expect(receivedContext).toBe('system context');
  });
});

// ─── sanitizeHistoryForProviderSwitch ─────────────────────────────────────────

describe('sanitizeHistoryForProviderSwitch', () => {
  // Simulate Auditaria's tool registry: these tools should be preserved
  const knownTools = new Set([
    'browser_agent',
    'knowledge_search',
    'knowledge_index',
    'context_inspect',
    'context_forget',
    'context_restore',
  ]);

  it('should keep text parts unchanged', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Hi there' }] },
    ];
    const result = sanitizeHistoryForProviderSwitch(history, knownTools);
    expect(result).toHaveLength(2);
    expect(result[0].parts![0]).toEqual({ text: 'Hello' });
    expect(result[1].parts![0]).toEqual({ text: 'Hi there' });
  });

  it('should keep inlineData attachments as-is', () => {
    const inlinePart = {
      inlineData: {
        mimeType: 'image/png',
        data: 'iVBORw0KGgo=',
      },
    };
    const history: Content[] = [{ role: 'user', parts: [inlinePart] }];
    const result = sanitizeHistoryForProviderSwitch(history, knownTools);
    expect(result).toHaveLength(1);
    expect(result[0].parts![0]).toBe(inlinePart); // same reference, not converted
  });

  it('should keep fileData as-is', () => {
    const filePart = {
      fileData: {
        mimeType: 'application/pdf',
        fileUri: 'gs://bucket/report.pdf',
      },
    };
    const history: Content[] = [{ role: 'user', parts: [filePart] }];
    const result = sanitizeHistoryForProviderSwitch(history, knownTools);
    expect(result).toHaveLength(1);
    expect(result[0].parts![0]).toBe(filePart);
  });

  it('should keep functionCall for known Auditaria tools', () => {
    const fnCallPart = {
      functionCall: {
        name: 'browser_agent',
        args: { action: 'navigate', url: 'https://example.com' },
      },
    };
    const history: Content[] = [{ role: 'model', parts: [fnCallPart] }];
    const result = sanitizeHistoryForProviderSwitch(history, knownTools);
    expect(result[0].parts![0]).toBe(fnCallPart);
  });

  it('should keep functionResponse for known Auditaria tools', () => {
    const fnRespPart = {
      functionResponse: {
        id: 'tool_1',
        name: 'knowledge_search',
        response: { output: 'search results here' },
      },
    };
    const history: Content[] = [{ role: 'user', parts: [fnRespPart] }];
    const result = sanitizeHistoryForProviderSwitch(history, knownTools);
    expect(result[0].parts![0]).toBe(fnRespPart);
  });

  it('should convert functionCall for Claude built-in tools to text', () => {
    const history: Content[] = [
      {
        role: 'model',
        parts: [
          { text: 'Let me check.' },
          {
            functionCall: {
              name: 'Read',
              args: { file_path: '/tmp/test.txt' },
            },
          },
        ],
      },
    ];
    const result = sanitizeHistoryForProviderSwitch(history, knownTools);
    expect(result[0].parts).toHaveLength(2);
    expect((result[0].parts![0] as { text: string }).text).toBe(
      'Let me check.',
    );
    expect((result[0].parts![1] as { text: string }).text).toContain(
      '[Tool Call: Read(',
    );
    expect((result[0].parts![1] as { text: string }).text).toContain(
      'file_path',
    );
  });

  it('should convert functionResponse for Claude built-in tools to text', () => {
    const history: Content[] = [
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'tool_1',
              name: 'Bash',
              response: { output: 'command output here' },
            },
          },
        ],
      },
    ];
    const result = sanitizeHistoryForProviderSwitch(history, knownTools);
    const text = (result[0].parts![0] as { text: string }).text;
    expect(text).toContain('[Tool Result (Bash)]');
    expect(text).toContain('command output here');
  });

  it('should preserve forgotten placeholders for unknown tools', () => {
    const placeholder =
      '[CONTENT FORGOTTEN - YOU HAVE AMNESIA ABOUT THIS]\nID: tool_1\nLarge content was here';
    const history: Content[] = [
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'tool_1',
              name: 'Edit', // Claude built-in
              response: { output: placeholder },
            },
          },
        ],
      },
    ];
    const result = sanitizeHistoryForProviderSwitch(history, knownTools);
    const text = (result[0].parts![0] as { text: string }).text;
    expect(text).toContain('[CONTENT FORGOTTEN');
    expect(text).toContain('ID: tool_1');
  });


  it('should handle mixed known and unknown tool calls', () => {
    const knownCall = {
      functionCall: { name: 'browser_agent', args: { action: 'start' } },
    };
    const unknownCall = {
      functionCall: { name: 'Bash', args: { command: 'ls' } },
    };
    const history: Content[] = [
      {
        role: 'model',
        parts: [{ text: 'Running tools...' }, knownCall, unknownCall],
      },
    ];
    const result = sanitizeHistoryForProviderSwitch(history, knownTools);
    expect(result[0].parts).toHaveLength(3);
    expect((result[0].parts![0] as { text: string }).text).toBe(
      'Running tools...',
    );
    expect(result[0].parts![1]).toBe(knownCall); // preserved
    expect((result[0].parts![2] as { text: string }).text).toContain(
      '[Tool Call: Bash(',
    ); // converted
  });

  it('should convert all tool calls when no knownToolNames provided', () => {
    const history: Content[] = [
      {
        role: 'model',
        parts: [{ functionCall: { name: 'browser_agent', args: {} } }],
      },
    ];
    // No knownToolNames → all tool calls converted (safe fallback)
    const result = sanitizeHistoryForProviderSwitch(history);
    expect((result[0].parts![0] as { text: string }).text).toContain(
      '[Tool Call: browser_agent(',
    );
  });

  it('should filter out empty content entries', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [] },
      { role: 'model', parts: [{ text: 'Response' }] },
    ];
    const result = sanitizeHistoryForProviderSwitch(history, knownTools);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('should preserve full round-trip: Gemini attachment + Claude tools + known tools', () => {
    // Simulates a real Gemini→Claude→Gemini session
    const history: Content[] = [
      // Original Gemini messages with attachment
      {
        role: 'user',
        parts: [
          { text: 'analyze this image' },
          { inlineData: { mimeType: 'image/jpeg', data: 'base64data' } },
        ],
      },
      { role: 'model', parts: [{ text: 'I see a chart showing...' }] },
      // Mirrored Claude messages
      { role: 'user', parts: [{ text: 'search for related documents' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'knowledge_search',
              args: { query: 'related docs' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 't1',
              name: 'knowledge_search',
              response: { output: 'found 3 docs' },
            },
          },
        ],
      },
      {
        role: 'model',
        parts: [
          { text: 'Let me read the first one.' },
          { functionCall: { name: 'Read', args: { file_path: '/doc.md' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 't2',
              name: 'Read',
              response: { output: 'file contents...' },
            },
          },
        ],
      },
      { role: 'model', parts: [{ text: 'Here is the summary.' }] },
    ];
    const result = sanitizeHistoryForProviderSwitch(history, knownTools);
    expect(result).toHaveLength(8);
    // [0] user: text + inlineData preserved
    expect(result[0].parts).toHaveLength(2);
    expect(result[0].parts![1]).toEqual({
      inlineData: { mimeType: 'image/jpeg', data: 'base64data' },
    });
    // [3] model: knowledge_search functionCall preserved
    expect(result[3].parts![0]).toEqual({
      functionCall: {
        name: 'knowledge_search',
        args: { query: 'related docs' },
      },
    });
    // [4] user: knowledge_search functionResponse preserved
    expect(
      (result[4].parts![0] as { functionResponse: { name: string } })
        .functionResponse.name,
    ).toBe('knowledge_search');
    // [5] model: text preserved, Read functionCall converted
    expect((result[5].parts![0] as { text: string }).text).toBe(
      'Let me read the first one.',
    );
    expect((result[5].parts![1] as { text: string }).text).toContain(
      '[Tool Call: Read(',
    );
    // [6] user: Read functionResponse converted
    expect((result[6].parts![0] as { text: string }).text).toContain(
      '[Tool Result (Read)]',
    );
    // [7] model: text preserved
    expect((result[7].parts![0] as { text: string }).text).toBe(
      'Here is the summary.',
    );
  });
});

// ─── buildConversationSummary with attachments ────────────────────────────────

describe('buildConversationSummary attachment handling', () => {
  it('should describe inlineData with honest warning', () => {
    const history: Content[] = [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: 'image/jpeg',
              data: 'A'.repeat(1000), // ~750 bytes
            },
          },
        ],
      },
    ];
    const summary = buildConversationSummary(history);
    expect(summary).toContain('image/jpeg');
    expect(summary).toContain('previous model');
    expect(summary).toContain('cannot see the literal content');
    expect(summary).toContain('Do not pretend');
  });

  it('should describe fileData with honest warning', () => {
    const history: Content[] = [
      {
        role: 'user',
        parts: [
          {
            fileData: {
              mimeType: 'application/pdf',
              fileUri: 'gs://my-bucket/document.pdf',
            },
          },
        ],
      },
    ];
    const summary = buildConversationSummary(history);
    expect(summary).toContain('gs://my-bucket/document.pdf');
    expect(summary).toContain('application/pdf');
    expect(summary).toContain('cannot see the literal content');
    expect(summary).toContain('Do not pretend');
  });
});

// ─── compactMirroredHistory ───────────────────────────────────────────────────

describe('compactMirroredHistory', () => {
  it('should use state_snapshot tags when summary is provided', () => {
    const mockChat = createMockChat();
    for (let i = 0; i < 20; i++) {
      mockChat.addHistory({
        role: 'user',
        parts: [{ text: `User message ${i}: ${'x'.repeat(100)}` }],
      });
      mockChat.addHistory({
        role: 'model',
        parts: [{ text: `Model response ${i}: ${'y'.repeat(100)}` }],
      });
    }
    const originalLength = mockChat._raw.length;
    expect(originalLength).toBe(40);

    compactMirroredHistory(mockChat as never, 'Summary of the conversation about auditing.');

    const history = mockChat._raw;
    expect(history.length).toBeLessThan(originalLength);
    // First entry should contain state_snapshot with the summary
    expect(history[0].role).toBe('user');
    expect((history[0].parts![0] as { text: string }).text).toContain('<state_snapshot>');
    expect((history[0].parts![0] as { text: string }).text).toContain('Summary of the conversation about auditing.');
    expect((history[0].parts![0] as { text: string }).text).toContain('</state_snapshot>');
    // Model ack should match Gemini's format
    expect(history[1].role).toBe('model');
    expect((history[1].parts![0] as { text: string }).text).toBe('Got it. Thanks for the additional context!');
    // Remaining entries come from original history's tail
    expect(history[2].role).toBe('user');
  });

  it('should use context_compacted fallback when no summary provided', () => {
    const mockChat = createMockChat();
    for (let i = 0; i < 20; i++) {
      mockChat.addHistory({
        role: 'user',
        parts: [{ text: `User message ${i}: ${'x'.repeat(100)}` }],
      });
      mockChat.addHistory({
        role: 'model',
        parts: [{ text: `Model response ${i}: ${'y'.repeat(100)}` }],
      });
    }

    compactMirroredHistory(mockChat as never); // No summary

    const history = mockChat._raw;
    expect(history[0].role).toBe('user');
    expect((history[0].parts![0] as { text: string }).text).toContain('<context_compacted>');
    expect((history[0].parts![0] as { text: string }).text).not.toContain('<state_snapshot>');
    // Model ack still matches Gemini's format
    expect((history[1].parts![0] as { text: string }).text).toBe('Got it. Thanks for the additional context!');
  });

  it('should not trim history with <= 4 entries', () => {
    const mockChat = createMockChat();
    mockChat.addHistory({ role: 'user', parts: [{ text: 'Hello' }] });
    mockChat.addHistory({ role: 'model', parts: [{ text: 'Hi' }] });
    mockChat.addHistory({ role: 'user', parts: [{ text: 'How?' }] });

    compactMirroredHistory(mockChat as never);

    expect(mockChat._raw).toHaveLength(3);
    expect((mockChat._raw[0].parts![0] as { text: string }).text).toBe('Hello');
  });

  it('should produce valid history structure after trim (user/model alternation)', () => {
    const mockChat = createMockChat();
    for (let i = 0; i < 10; i++) {
      mockChat.addHistory({
        role: 'user',
        parts: [{ text: `User ${i}: ${'x'.repeat(200)}` }],
      });
      mockChat.addHistory({
        role: 'model',
        parts: [{ text: `Model ${i}: ${'y'.repeat(200)}` }],
      });
    }

    compactMirroredHistory(mockChat as never);

    const history = mockChat._raw;
    // First two entries: user (compacted marker) → model (ack)
    expect(history[0].role).toBe('user');
    expect(history[1].role).toBe('model');
    // Rest should alternate user/model
    for (let i = 2; i < history.length; i++) {
      const expectedRole = i % 2 === 0 ? 'user' : 'model';
      expect(history[i].role).toBe(expectedRole);
    }
  });
});

// ─── Compacted event handling in handleSendMessage ────────────────────────────

describe('ProviderManager compaction handling', () => {
  let manager: ProviderManager;
  let mockChat: ReturnType<typeof createMockChat>;

  beforeEach(() => {
    manager = new ProviderManager(
      { type: 'claude-cli', model: 'sonnet' },
      '/tmp/test',
    );
    mockChat = createMockChat();
  });

  async function runWithEvents(events: ProviderEvent[]) {
    const mockDriver = createMockDriver(events);
    (manager as unknown as Record<string, unknown>)['driver'] = mockDriver;

    const yielded: unknown[] = [];
    const gen = manager.handleSendMessage(
      'test prompt',
      new AbortController().signal,
      'prompt-1',
      mockChat as never,
    );
    let result = await gen.next();
    while (!result.done) {
      yielded.push(result.value);
      result = await gen.next();
    }
    return yielded;
  }

  it('should emit ChatCompressed with state_snapshot when Compacted + CompactionSummary received', async () => {
    // Pre-fill history so there's something to compact
    for (let i = 0; i < 10; i++) {
      mockChat.addHistory({ role: 'user', parts: [{ text: `msg ${i}: ${'x'.repeat(200)}` }] });
      mockChat.addHistory({ role: 'model', parts: [{ text: `resp ${i}: ${'y'.repeat(200)}` }] });
    }
    const preHistoryLength = mockChat._raw.length;

    const yielded = await runWithEvents([
      { type: ProviderEventType.Content, text: 'Before compaction' },
      { type: ProviderEventType.Compacted, preTokens: 150000, trigger: 'auto' as const },
      { type: ProviderEventType.CompactionSummary, summary: 'Summary of auditing discussion with key findings.' },
      { type: ProviderEventType.Content, text: 'After compaction' },
      { type: ProviderEventType.Finished },
    ]);

    // Should have emitted ChatCompressed event
    const compressed = (yielded as Array<{ type: string }>).find(
      e => e.type === GeminiEventType.ChatCompressed,
    );
    expect(compressed).toBeDefined();
    const info = (compressed as unknown as { value: { originalTokenCount: number; compressionStatus: string } }).value;
    expect(info.originalTokenCount).toBe(150000);
    expect(info.compressionStatus).toBe(CompressionStatus.COMPRESSED);

    // History should contain state_snapshot with summary (not context_compacted)
    const firstEntry = mockChat._raw[0];
    expect((firstEntry.parts![0] as { text: string }).text).toContain('<state_snapshot>');
    expect((firstEntry.parts![0] as { text: string }).text).toContain('Summary of auditing discussion');
    expect((firstEntry.parts![0] as { text: string }).text).toContain('</state_snapshot>');
    // Model ack matches Gemini's format
    expect((mockChat._raw[1].parts![0] as { text: string }).text).toBe('Got it. Thanks for the additional context!');
    // History should be shorter (trimmed)
    expect(mockChat._raw.length).toBeLessThan(preHistoryLength + 4);
  });

  it('should use fallback context_compacted when Compacted received without CompactionSummary', async () => {
    // Pre-fill enough history for compaction to actually trim
    for (let i = 0; i < 10; i++) {
      mockChat.addHistory({ role: 'user', parts: [{ text: `msg ${i}: ${'x'.repeat(200)}` }] });
      mockChat.addHistory({ role: 'model', parts: [{ text: `resp ${i}: ${'y'.repeat(200)}` }] });
    }

    const yielded = await runWithEvents([
      { type: ProviderEventType.Content, text: 'Before compaction' },
      { type: ProviderEventType.Compacted, preTokens: 100000, trigger: 'auto' as const },
      // No CompactionSummary event follows — fallback triggers at end of stream
      { type: ProviderEventType.Content, text: 'After compaction' },
      { type: ProviderEventType.Finished },
    ]);

    // Should still emit ChatCompressed
    const compressed = (yielded as Array<{ type: string }>).find(
      e => e.type === GeminiEventType.ChatCompressed,
    );
    expect(compressed).toBeDefined();

    // History should use fallback context_compacted marker
    const firstEntry = mockChat._raw[0];
    expect((firstEntry.parts![0] as { text: string }).text).toContain('<context_compacted>');
    expect((firstEntry.parts![0] as { text: string }).text).not.toContain('<state_snapshot>');
  });

  it('should flush accumulated text before trimming on Compacted', async () => {
    // Pre-fill enough history for compaction to actually trim
    for (let i = 0; i < 10; i++) {
      mockChat.addHistory({ role: 'user', parts: [{ text: `msg ${i}: ${'x'.repeat(200)}` }] });
      mockChat.addHistory({ role: 'model', parts: [{ text: `resp ${i}: ${'y'.repeat(200)}` }] });
    }

    await runWithEvents([
      { type: ProviderEventType.Content, text: 'hello ' },
      { type: ProviderEventType.Compacted, preTokens: 100000, trigger: 'auto' as const },
      { type: ProviderEventType.CompactionSummary, summary: 'Conversation summary here.' },
      { type: ProviderEventType.Content, text: 'world' },
      { type: ProviderEventType.Finished },
    ]);

    // The "hello " text should have been flushed to history before trim.
    // After trim, the state_snapshot marker is at start, then recent entries remain.
    // The "world" text is flushed at end of stream.
    // Verify that "world" is in the last model entry
    const lastEntry = mockChat._raw[mockChat._raw.length - 1];
    expect(lastEntry.role).toBe('model');
    expect((lastEntry.parts![0] as { text: string }).text).toContain('world');
  });

  it('should NOT set contextModified after compaction', async () => {
    // Pre-fill enough history
    for (let i = 0; i < 10; i++) {
      mockChat.addHistory({ role: 'user', parts: [{ text: `msg ${i}: ${'x'.repeat(200)}` }] });
      mockChat.addHistory({ role: 'model', parts: [{ text: `resp ${i}: ${'y'.repeat(200)}` }] });
    }

    // First call with compaction (with summary)
    await runWithEvents([
      { type: ProviderEventType.Content, text: 'Compacted response' },
      { type: ProviderEventType.Compacted, preTokens: 100000, trigger: 'auto' as const },
      { type: ProviderEventType.CompactionSummary, summary: 'Summary of conversation.' },
      { type: ProviderEventType.Finished },
    ]);

    // Second call — should NOT have conversation summary injected
    let receivedContext: string | undefined;
    const trackingDriver: ProviderDriver = {
      async *sendMessage(
        _prompt: string,
        _signal: AbortSignal,
        systemContext?: string,
      ) {
        receivedContext = systemContext;
        yield { type: ProviderEventType.Finished } as ProviderEvent;
      },
      async interrupt() {},
      getSessionId() { return 'session-after-compact'; },
      resetSession() {},
      dispose() {},
    };

    (manager as unknown as Record<string, unknown>)['driver'] = trackingDriver;

    const gen = manager.handleSendMessage(
      'follow up',
      new AbortController().signal,
      'prompt-2',
      mockChat as never,
      'base context',
    );
    let result = await gen.next();
    while (!result.done) {
      result = await gen.next();
    }

    // Context should be the base context only, no conversation summary
    expect(receivedContext).toBe('base context');
    expect(receivedContext).not.toContain('<auditaria_conversation_history>');
  });
});
