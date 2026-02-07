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
  ProviderManager,
} from './providerManager.js';
import type { ProviderDriver, ProviderEvent } from './types.js';
import { ProviderEventType } from './types.js';
import { GeminiEventType } from '../core/turn.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

/** Minimal GeminiChat mock that stores history in an array */
function createMockChat() {
  const history: Content[] = [];
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

  it('should truncate large tool outputs', () => {
    const largeOutput = 'x'.repeat(3000);
    const history: Content[] = [
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'tool_1',
              name: 'knowledge_search',
              response: { output: largeOutput },
            },
          },
        ],
      },
    ];
    const summary = buildConversationSummary(history);
    expect(summary).toContain('... (truncated)');
    expect(summary.length).toBeLessThan(largeOutput.length);
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
  it('should reset session and inject conversation summary after onHistoryModified', async () => {
    const manager = new ProviderManager(
      { type: 'claude-cli', model: 'sonnet' },
      '/tmp/test',
    );
    const mockChat = createMockChat();

    // Simulate prior conversation in history
    mockChat.addHistory({ role: 'user', parts: [{ text: 'old message' }] });
    mockChat.addHistory({ role: 'model', parts: [{ text: 'old response' }] });

    // Create a driver that records what context it receives
    let receivedContext: string | undefined;
    let sessionWasReset = false;
    const trackingDriver: ProviderDriver = {
      async *sendMessage(
        _prompt: string,
        _signal: AbortSignal,
        systemContext?: string,
      ) {
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

    // Verify conversation summary was injected into context
    expect(receivedContext).toContain('base system context');
    expect(receivedContext).toContain('<auditaria_conversation_history>');
    expect(receivedContext).toContain('[User]: old message');
    expect(receivedContext).toContain('[Assistant]: old response');
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

  it('should truncate large functionResponse outputs for unknown tools', () => {
    const largeOutput = 'x'.repeat(3000);
    const history: Content[] = [
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'tool_1',
              name: 'Read', // Claude built-in
              response: { output: largeOutput },
            },
          },
        ],
      },
    ];
    const result = sanitizeHistoryForProviderSwitch(history, knownTools);
    const text = (result[0].parts![0] as { text: string }).text;
    expect(text).toContain('... (truncated)');
    expect(text.length).toBeLessThan(largeOutput.length);
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
