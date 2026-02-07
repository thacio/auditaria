// AUDITARIA_CLAUDE_PROVIDER: Translates ProviderEvent → ServerGeminiStreamEvent

import type { FinishReason } from '@google/genai';
import {
  GeminiEventType,
  type ServerGeminiStreamEvent,
} from '../core/turn.js';
import type { ThoughtSummary } from '../utils/thoughtUtils.js';
import {
  type ProviderEvent,
  ProviderEventType,
} from './types.js';

/**
 * Adapts a ProviderEvent into a ServerGeminiStreamEvent that the UI can consume.
 * Note: ToolUse/ToolResult events are handled directly in ProviderManager as
 * native ToolCallRequest/Response events for proper UI rendering.
 */
export function adaptProviderEvent(
  event: ProviderEvent,
): ServerGeminiStreamEvent | null {
  switch (event.type) {
    case ProviderEventType.Content:
      return {
        type: GeminiEventType.Content,
        value: event.text,
      };

    case ProviderEventType.Thinking: {
      const thought: ThoughtSummary = {
        subject: '',
        description: event.text,
      };
      return {
        type: GeminiEventType.Thought,
        value: thought,
      };
    }

    // ToolUse and ToolResult are handled in providerManager.ts directly
    case ProviderEventType.ToolUse:
    case ProviderEventType.ToolResult:
      return null;

    case ProviderEventType.ModelInfo:
      return {
        type: GeminiEventType.ModelInfo,
        value: event.model,
      };

    case ProviderEventType.Finished:
      return {
        type: GeminiEventType.Finished,
        value: {
          reason: 'STOP' as FinishReason,
          usageMetadata: event.usage
            ? {
                promptTokenCount: event.usage.inputTokens,
                candidatesTokenCount: event.usage.outputTokens,
                cachedContentTokenCount: event.usage.cacheReadTokens,
              }
            : undefined,
        },
      };

    case ProviderEventType.Error:
      return {
        type: GeminiEventType.Error,
        value: {
          error: {
            message: event.message,
            status: event.status,
          },
        },
      };

    default:
      return null;
  }
}
