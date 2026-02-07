import { describe, it, expect } from 'vitest';
import { adaptProviderEvent } from './eventAdapter.js';
import { ProviderEventType } from './types.js';
import { GeminiEventType } from '../core/turn.js';

describe('adaptProviderEvent', () => {
  it('should adapt Content event', () => {
    const result = adaptProviderEvent({
      type: ProviderEventType.Content,
      text: 'Hello world',
    });
    expect(result).toEqual({
      type: GeminiEventType.Content,
      value: 'Hello world',
    });
  });

  it('should adapt Thinking event to Thought with empty subject', () => {
    const result = adaptProviderEvent({
      type: ProviderEventType.Thinking,
      text: 'Let me think about this...',
    });
    expect(result).toEqual({
      type: GeminiEventType.Thought,
      value: { subject: '', description: 'Let me think about this...' },
    });
  });

  it('should return null for ToolUse events (handled in providerManager)', () => {
    const result = adaptProviderEvent({
      type: ProviderEventType.ToolUse,
      toolName: 'Read',
      toolId: 'tool_123',
      input: { file_path: '/tmp/test.txt' },
    });
    expect(result).toBeNull();
  });

  it('should return null for ToolResult events (handled in providerManager)', () => {
    const result = adaptProviderEvent({
      type: ProviderEventType.ToolResult,
      toolId: 'tool_123',
      output: 'file contents here',
    });
    expect(result).toBeNull();
  });

  it('should adapt ModelInfo event', () => {
    const result = adaptProviderEvent({
      type: ProviderEventType.ModelInfo,
      model: 'claude-sonnet-4-5-20250929',
    });
    expect(result).toEqual({
      type: GeminiEventType.ModelInfo,
      value: 'claude-sonnet-4-5-20250929',
    });
  });

  it('should adapt Finished event with usage metadata', () => {
    const result = adaptProviderEvent({
      type: ProviderEventType.Finished,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 20,
      },
    });
    expect(result).not.toBeNull();
    expect(result!.type).toBe(GeminiEventType.Finished);
    const value = (result as { value: { reason: string; usageMetadata: unknown } }).value;
    expect(value.reason).toBe('STOP');
    expect(value.usageMetadata).toEqual({
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      cachedContentTokenCount: 20,
    });
  });

  it('should adapt Finished event without usage', () => {
    const result = adaptProviderEvent({
      type: ProviderEventType.Finished,
    });
    expect(result).not.toBeNull();
    expect(result!.type).toBe(GeminiEventType.Finished);
    const value = (result as { value: { reason: string; usageMetadata: unknown } }).value;
    expect(value.reason).toBe('STOP');
    expect(value.usageMetadata).toBeUndefined();
  });

  it('should adapt Error event', () => {
    const result = adaptProviderEvent({
      type: ProviderEventType.Error,
      message: 'Something went wrong',
      status: 500,
    });
    expect(result).toEqual({
      type: GeminiEventType.Error,
      value: { error: { message: 'Something went wrong', status: 500 } },
    });
  });
});
