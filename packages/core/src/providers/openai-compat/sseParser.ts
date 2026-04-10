/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_OPENAI_COMPAT: SSE stream parser for OpenAI-compatible APIs

import type { ProviderEvent } from '../types.js';
import { ProviderEventType } from '../types.js';
import type { OpenAISSEChunk } from './types.js';

/**
 * Parses an SSE stream from an OpenAI-compatible /chat/completions response.
 * Yields ProviderEvents for content, thinking, and finished.
 *
 * Handles variations:
 * - "data: [DONE]" and "data:[DONE]" (with/without space)
 * - "reasoning_content" field (DeepSeek-style reasoning tokens)
 * - Usage in the final chunk
 * - Malformed lines (silently skipped)
 */
export async function* parseOpenAISSEStream(
  body: ReadableStream<Uint8Array>,
  model: string,
): AsyncGenerator<ProviderEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let hasContent = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete last line

      for (const line of lines) {
        const trimmed = line.trim();

        // Skip empty lines and SSE comments
        if (!trimmed || trimmed.startsWith(':')) continue;

        // Extract data payload: handle both "data: ..." and "data:..."
        if (!trimmed.startsWith('data')) continue;
        let data: string;
        if (trimmed.startsWith('data: ')) {
          data = trimmed.slice(6);
        } else if (trimmed.startsWith('data:')) {
          data = trimmed.slice(5);
        } else {
          continue;
        }

        // Check for stream terminator
        const dataTrimmed = data.trim();
        if (dataTrimmed === '[DONE]') {
          yield {
            type: ProviderEventType.Finished,
            usage: {
              inputTokens: inputTokens || undefined,
              outputTokens: outputTokens || undefined,
            },
          };
          return;
        }

        // Parse JSON chunk
        let chunk: OpenAISSEChunk;
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- OpenAI SSE format
          chunk = JSON.parse(dataTrimmed) as OpenAISSEChunk;
        } catch {
          // Silently skip malformed JSON (some providers send partial data)
          continue;
        }

        // Extract content delta
        const delta = chunk.choices?.[0]?.delta;
        if (delta) {
          if (delta.content) {
            hasContent = true;
            yield { type: ProviderEventType.Content, text: delta.content };
          }
          // DeepSeek-style reasoning tokens
          if (delta.reasoning_content) {
            yield {
              type: ProviderEventType.Thinking,
              text: delta.reasoning_content,
            };
          }
        }

        // Capture usage (some providers include it in the final chunk before [DONE])
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens || 0;
          outputTokens = chunk.usage.completion_tokens || 0;
        }

        // Some providers use finish_reason without [DONE]
        const finishReason = chunk.choices?.[0]?.finish_reason;
        if (finishReason === 'stop' || finishReason === 'length') {
          // Don't yield Finished here — wait for [DONE] or stream end
          // Just note that we're done receiving content
        }
      }
    }

    // Stream ended without [DONE] — emit Finished anyway
    if (hasContent) {
      yield {
        type: ProviderEventType.Finished,
        usage: {
          inputTokens: inputTokens || undefined,
          outputTokens: outputTokens || undefined,
        },
      };
    }
  } finally {
    reader.releaseLock();
  }
}
