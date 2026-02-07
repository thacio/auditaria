// AUDITARIA_CLAUDE_PROVIDER: SDK-based driver using @anthropic-ai/claude-agent-sdk

import type { ProviderDriver, ProviderEvent } from '../types.js';
import { ProviderEventType } from '../types.js';
import { ClaudeSessionManager } from './claudeSessionManager.js';
import type {
  ClaudeStreamMessage,
  ClaudeAssistantMessage,
  ClaudeUserMessage,
  ClaudeResultMessage,
  ClaudeDriverConfig,
} from './types.js';

export class ClaudeSDKDriver implements ProviderDriver {
  private sessionManager = new ClaudeSessionManager();
  private activeInstance: { interrupt(): void } | null = null;
  private queryFn:
    | ((args: {
        prompt: string;
        options: Record<string, unknown>;
      }) => AsyncIterable<ClaudeStreamMessage> & { interrupt(): void })
    | null = null;

  constructor(private readonly config: ClaudeDriverConfig) {}

  async *sendMessage(
    prompt: string,
    signal: AbortSignal,
    systemContext?: string,
  ): AsyncGenerator<ProviderEvent> {
    const queryFn = await this.loadSDK();

    const sdkOptions: Record<string, unknown> = {
      model: this.config.model,
      cwd: this.config.cwd,
      permissionMode: this.config.permissionMode || 'bypassPermissions',
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    };

    // AUDITARIA_CLAUDE_PROVIDER: Inject audit context, memory, skills
    if (systemContext) {
      sdkOptions.appendSystemPrompt = systemContext;
    }

    if (this.config.allowedTools) {
      sdkOptions.allowedTools = this.config.allowedTools;
    }

    const sessionId = this.sessionManager.getSessionId();
    if (sessionId) {
      sdkOptions.resume = sessionId;
    }

    const instance = queryFn({ prompt, options: sdkOptions });
    this.activeInstance = instance as { interrupt(): void };

    // Handle abort
    const abortHandler = () => {
      this.activeInstance?.interrupt();
    };
    signal.addEventListener('abort', abortHandler, { once: true });

    try {
      for await (const message of instance) {
        if (signal.aborted) return;

        // Capture session ID from first system message
        if (message.type === 'system' && message.session_id) {
          this.sessionManager.setSessionId(
            message.session_id as string,
          );
          continue;
        }

        // Process assistant messages
        if (message.type === 'assistant') {
          yield* this.processAssistantMessage(
            message as ClaudeAssistantMessage,
          );
          continue;
        }

        // Process user messages (tool results)
        if (message.type === 'user') {
          yield* this.processUserMessage(message as ClaudeUserMessage);
          continue;
        }

        // Process result messages
        if (message.type === 'result') {
          yield* this.processResultMessage(message as ClaudeResultMessage);
          continue;
        }
      }

      // Stream ended, emit finished
      yield { type: ProviderEventType.Finished };
    } finally {
      signal.removeEventListener('abort', abortHandler);
      this.activeInstance = null;
    }
  }

  async interrupt(): Promise<void> {
    this.activeInstance?.interrupt();
  }

  getSessionId(): string | undefined {
    return this.sessionManager.getSessionId();
  }

  dispose(): void {
    this.activeInstance?.interrupt();
    this.activeInstance = null;
  }

  private async loadSDK(): Promise<
    (args: {
      prompt: string;
      options: Record<string, unknown>;
    }) => AsyncIterable<ClaudeStreamMessage> & { interrupt(): void }
  > {
    if (this.queryFn) return this.queryFn;

    try {
      // @ts-expect-error - SDK is optional, installed separately by user
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      // The SDK exports `query` as the main function
      this.queryFn = sdk.query as unknown as typeof this.queryFn;
      if (!this.queryFn) {
        throw new Error(
          'claude-agent-sdk does not export `query`. Check SDK version.',
        );
      }
      return this.queryFn;
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : String(e);
      throw new Error(
        `Failed to load @anthropic-ai/claude-agent-sdk: ${msg}. ` +
          `Install it with: npm install @anthropic-ai/claude-agent-sdk`,
      );
    }
  }

  private *processAssistantMessage(
    message: ClaudeAssistantMessage,
  ): Generator<ProviderEvent> {
    const content = message.message?.content;
    if (!content || !Array.isArray(content)) return;

    // Emit model info from first assistant message
    if (message.message?.model) {
      yield {
        type: ProviderEventType.ModelInfo,
        model: message.message.model,
      };
    }

    for (const block of content) {
      switch (block.type) {
        case 'text':
          if (block.text) {
            yield {
              type: ProviderEventType.Content,
              text: block.text,
            };
          }
          break;

        case 'thinking':
          if (block.thinking) {
            yield {
              type: ProviderEventType.Thinking,
              text: block.thinking,
            };
          }
          break;

        case 'tool_use':
          yield {
            type: ProviderEventType.ToolUse,
            toolName: block.name,
            toolId: block.id,
            input: block.input,
          };
          break;

        case 'tool_result':
          yield {
            type: ProviderEventType.ToolResult,
            toolId: block.tool_use_id,
            output: block.content,
            isError: block.is_error,
          };
          break;
      }
    }
  }

  private *processUserMessage(
    message: ClaudeUserMessage,
  ): Generator<ProviderEvent> {
    const content = message.message?.content;
    if (!content || !Array.isArray(content)) return;

    for (const block of content) {
      if (block.type === 'tool_result') {
        yield {
          type: ProviderEventType.ToolResult,
          toolId: block.tool_use_id,
          output: block.content,
          isError: block.is_error,
        };
      }
    }
  }

  private *processResultMessage(
    message: ClaudeResultMessage,
  ): Generator<ProviderEvent> {
    if (!message.modelUsage) return;

    const modelKey = Object.keys(message.modelUsage)[0];
    const usage = message.modelUsage[modelKey];
    if (!usage) return;

    yield {
      type: ProviderEventType.Finished,
      usage: {
        inputTokens:
          usage.cumulativeInputTokens ?? usage.inputTokens,
        outputTokens:
          usage.cumulativeOutputTokens ?? usage.outputTokens,
        cacheReadTokens:
          usage.cumulativeCacheReadInputTokens ??
          usage.cacheReadInputTokens,
        cacheCreationTokens:
          usage.cumulativeCacheCreationInputTokens ??
          usage.cacheCreationInputTokens,
      },
    };
  }
}
