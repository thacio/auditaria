/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_DISCORD_FEATURE: This entire file is part of the Discord integration

import type { Config, ToolCallRequestInfo } from '@google/gemini-cli-core';
import {
  GeminiEventType,
  Scheduler,
  debugLogger,
  ToolErrorType,
  recordToolCallInteractions,
} from '@google/gemini-cli-core';
import type { Part } from '@google/genai';
import { DiscordBotWrapper } from './DiscordBot.js';
import {
  formatResponse,
  formatToolCall,
  formatError,
} from './DiscordFormatter.js';
import {
  DISCORD_DEFAULTS,
  DISCORD_STREAM_EDIT_THROTTLE_MS,
  type DiscordConfig,
} from './types.js';
import {
  pushToCliDisplay,
  setDiscordProcessing,
  injectCliInput,
} from './DiscordBridge.js';
import type { HistoryItem } from '../../ui/types.js';
import {
  attachmentsToParts,
  type ValidatedAttachment,
} from '../attachments.js';

/**
 * Main Discord service that bridges the discord.js bot with Auditaria's agent loop.
 *
 * Uses the CLI's shared GeminiClient (same conversation, same history).
 * A mutex ensures only one message is processed at a time (CLI or Discord).
 *
 * Bidirectional display sync:
 * - Discord -> CLI: pushes user messages and responses to CLI display via DiscordBridge
 * - CLI -> Discord: receives history items from useHistoryManager and forwards to last active channel
 *
 * Message flow:
 * 1. User sends message in Discord
 * 2. discord.js receives via gateway
 * 3. Access check + message routing
 * 4. Acquire mutex (blocks if CLI is processing)
 * 5. Push user message to CLI display
 * 6. Call sendMessageStream() on shared GeminiClient
 * 7. Process events: accumulate text, execute tools, handle errors
 * 8. Chunk response if needed
 * 9. Send back via Discord API + push response to CLI display, release mutex
 */
export class DiscordService {
  private bot: DiscordBotWrapper;
  private stopped = false;
  /** Mutex: resolves when the current message finishes processing */
  private processingLock: Promise<void> = Promise.resolve();
  /** Last channel ID that sent a message -- used for CLI -> Discord forwarding */
  private lastActiveChannelId: string | undefined;

  constructor(
    private readonly config: Config,
    private readonly discordConfig: DiscordConfig,
  ) {
    this.bot = new DiscordBotWrapper(discordConfig);
    // Track last active channel from any allowed-user message (even without @mention)
    this.bot.onChannelActivity((channelId) => {
      this.lastActiveChannelId = channelId;
    });
    this.registerHandlers();
  }

  /**
   * Starts the Discord bot (connects to gateway).
   */
  async start(): Promise<void> {
    await this.bot.start();
    debugLogger.debug('Discord: service started (shared session mode)');
  }

  /**
   * Returns the bot's username (available after start).
   */
  get botUsername(): string {
    return this.bot.username;
  }

  /**
   * Updates the allow list at runtime.
   */
  updateAllowList(allowFrom: string[]): void {
    this.bot.updateAllowList(allowFrom);
  }

  /**
   * Stops the bot.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.bot.stop();
    debugLogger.debug('Discord: service stopped');
  }

  /**
   * Forwards a CLI history item to the last active Discord channel.
   * Called by useHistoryManager via DiscordBridge when CLI produces output.
   * Only forwards user messages and AI responses; ignores tool groups, info, etc.
   */
  forwardCliItem(item: HistoryItem): void {
    if (!this.lastActiveChannelId || this.stopped) return;

    const channelId = this.lastActiveChannelId;

    if (item.type === 'user') {
      // CLI user typed something -- show in Discord
      const text = `\u{1F4BB} **[CLI]** ${item.text}`;
      void this.bot.sendToChannel(channelId, text).catch(() => {});
    } else if (item.type === 'gemini_content' || item.type === 'gemini') {
      // AI response from CLI -- forward to Discord
      const chunks = formatResponse(
        item.text,
        this.discordConfig.textChunkLimit,
      );
      for (const chunk of chunks) {
        void this.bot.sendToChannel(channelId, chunk).catch(() => {});
      }
    }
  }

  // --- Handler registration ---

  private registerHandlers(): void {
    // Commands (Discord uses ! prefix instead of /)
    this.bot.onCommand('start', async (ctx) => {
      await ctx.reply(
        '**Auditaria CLI Bot**\n\n' +
          "Send me any message and I'll process it with the AI agent.\n" +
          'This is a mirror of your CLI session -- same conversation, same tools.\n\n' +
          '**Commands:**\n' +
          '`!status` - Show session info\n' +
          '`!help` - Show this message',
      );
    });

    this.bot.onCommand('help', async (ctx) => {
      await ctx.reply(
        '**Available commands:**\n\n' +
          '`!status` - Show current model and session info\n' +
          '`!help` - Show this help message\n\n' +
          '*This bot shares the same conversation as your Auditaria CLI.*',
      );
    });

    this.bot.onCommand('status', async (ctx) => {
      const geminiClient = this.config.getGeminiClient();
      const model = this.config.getModel();
      const provider = this.config
        .getProviderManager?.()
        ?.isExternalProviderActive()
        ? 'External provider'
        : 'Gemini';

      let statusText = '**Status**\n\n';
      statusText += `**Model:** ${model}\n`;
      statusText += `**Provider:** ${provider}\n`;
      statusText += `**Session:** shared with CLI\n`;

      if (geminiClient?.isInitialized()) {
        const history = geminiClient.getHistory();
        const turns = history.filter((c) => c.role === 'user').length;
        statusText += `**Turns:** ${turns}\n`;
      }

      statusText += `\n**Your user ID:** \`${ctx.userId}\`\n`;
      const isAllowed = this.discordConfig.allowFrom.includes(ctx.userId);
      statusText += `**Access:** ${isAllowed ? 'allowed' : 'denied'}\n`;
      statusText += `**Allow list:** ${this.discordConfig.allowFrom.length > 0 ? this.discordConfig.allowFrom.join(', ') : 'empty (all denied)'}`;

      await ctx.reply(statusText);
    });

    // Message handler -- uses shared GeminiClient with mutex
    this.bot.onMessage(async (ctx) => {
      await this.processMessage(ctx);
    });
  }

  // --- Mutex ---

  /**
   * Acquires the processing lock. Returns a release function.
   * While locked, other messages (CLI or Discord) must wait.
   */
  private acquireLock(): Promise<() => void> {
    let release: () => void;
    const prev = this.processingLock;
    this.processingLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    return prev.then(() => release!);
  }

  // --- Core message processing ---

  private async processMessage(ctx: {
    channelId: string;
    userId: string;
    username?: string;
    displayName?: string;
    text: string;
    messageId: string;
    isGuild: boolean;
    attachments?: ValidatedAttachment[];
    reply: (text: string) => Promise<string>;
    editMessage: (messageId: string, text: string) => Promise<void>;
    sendTyping: () => Promise<void>;
    react: (emoji: string) => Promise<void>;
    unreact: (emoji: string) => Promise<void>;
  }): Promise<void> {
    const { text } = ctx;

    // Track last active channel for CLI -> Discord forwarding
    this.lastActiveChannelId = ctx.channelId;

    // Detect Auditaria slash commands (e.g., /quit, /compress, /model)
    // and inject them into the CLI command processor instead of sending to AI
    if (text.startsWith('/')) {
      const injected = injectCliInput(text);
      if (injected) {
        await ctx.react('\u{2705}'); // checkmark
        const userLabel = ctx.username
          ? `@${ctx.username}`
          : ctx.displayName || ctx.userId;
        pushToCliDisplay({
          type: 'user',
          text: `[Discord ${userLabel}] ${text}`,
        });
        return;
      }
      // If CLI input callback not registered, fall through to AI processing
    }

    // Acknowledge receipt
    await ctx.react('\u{1F440}'); // eyes emoji
    await ctx.sendTyping();

    const geminiClient = this.config.getGeminiClient();
    if (!geminiClient?.isInitialized()) {
      await ctx.reply(
        'CLI session not initialized yet. Please wait for Auditaria to finish starting.',
      );
      await ctx.unreact('\u{1F440}');
      return;
    }

    // Acquire mutex -- blocks if CLI or another Discord message is processing
    const release = await this.acquireLock();

    // Mark as processing to prevent echo (CLI -> Discord -> CLI loop)
    setDiscordProcessing(true);

    // Show user message in CLI display
    const userLabel = ctx.username
      ? `@${ctx.username}`
      : ctx.displayName || ctx.userId;
    pushToCliDisplay({ type: 'user', text: `[Discord ${userLabel}] ${text}` });

    const abortController = new AbortController();
    const promptId = `discord-${Date.now()}`;

    // Streaming state
    let previewMessageId: string | undefined;
    let accumulatedText = '';
    let lastEditTime = 0;
    const isStreaming = this.discordConfig.streaming === 'edit';

    // Keep typing indicator alive (Discord typing lasts ~10 seconds)
    const typingInterval = setInterval(async () => {
      if (!this.stopped) {
        await ctx.sendTyping();
      }
    }, 8000);

    try {
      const scheduler = new Scheduler({
        config: this.config,
        messageBus: this.config.getMessageBus(),
        getPreferredEditor: () => undefined,
        schedulerId: `discord-${ctx.channelId}`,
      });

      let currentParts: Part[] = [
        ...(text ? [{ text }] : []),
        ...attachmentsToParts(ctx.attachments || []),
      ];
      // Fallback if only attachments with no text
      if (currentParts.length === 0) currentParts = [{ text: '' }];

      // AUDITARIA_ATTACHMENTS: Warn user if images won't be seen by the model
      if (ctx.attachments && ctx.attachments.length > 0) {
        const pm = this.config.getProviderManager?.();
        if (pm && !pm.supportsImages()) {
          await ctx.reply(
            '\u{26A0}\u{FE0F} The current model does not support image attachments. ' +
              'Your image was sent but the AI cannot see it. ' +
              'Switch to Gemini or Codex for image support.',
          );
        }
      }

      let turnCount = 0;

      // Agent loop -- same pattern as nonInteractiveCli.ts
      while (true) {
        if (this.stopped) break;

        turnCount++;
        if (turnCount > 50) {
          await ctx.reply('*Maximum turns reached.*');
          break;
        }

        const toolCallRequests: ToolCallRequestInfo[] = [];

        const responseStream = geminiClient.sendMessageStream(
          currentParts,
          abortController.signal,
          promptId,
          undefined,
          false,
          turnCount === 1 ? text : undefined,
        );

        for await (const event of responseStream) {
          if (this.stopped || abortController.signal.aborted) break;

          if (event.type === GeminiEventType.Content) {
            accumulatedText += event.value;

            // Edit-in-place streaming
            if (isStreaming && accumulatedText.length > 0) {
              const now = Date.now();
              if (now - lastEditTime >= DISCORD_STREAM_EDIT_THROTTLE_MS) {
                const previewText = accumulatedText + ' ...';
                if (previewMessageId) {
                  await ctx.editMessage(previewMessageId, previewText);
                } else {
                  previewMessageId = await ctx.reply(previewText);
                }
                lastEditTime = now;
              }
            }
          } else if (event.type === GeminiEventType.ToolCallRequest) {
            toolCallRequests.push(event.value);

            // Notify user about tool execution
            const toolNotice = formatToolCall(event.value.name);
            if (isStreaming && previewMessageId) {
              await ctx.editMessage(
                previewMessageId,
                accumulatedText + '\n\n' + toolNotice,
              );
            }
          } else if (event.type === GeminiEventType.Error) {
            throw event.value.error;
          } else if (event.type === GeminiEventType.AgentExecutionStopped) {
            break;
          }
        }

        // Handle tool calls
        if (toolCallRequests.length > 0) {
          const completedToolCalls = await scheduler.schedule(
            toolCallRequests,
            abortController.signal,
          );

          const toolResponseParts: Part[] = [];

          for (const completed of completedToolCalls) {
            if (completed.response.error) {
              debugLogger.error(
                `Discord: tool ${completed.request.name} error:`,
                completed.response.error,
              );
            }
            if (completed.response.responseParts) {
              toolResponseParts.push(...completed.response.responseParts);
            }
          }

          // Record tool calls
          try {
            const currentModel =
              geminiClient.getCurrentSequenceModel?.() ??
              this.config.getModel();
            geminiClient
              .getChat()
              .recordCompletedToolCalls(currentModel, completedToolCalls);
            await recordToolCallInteractions(this.config, completedToolCalls);
          } catch (err) {
            debugLogger.error('Discord: error recording tool calls:', err);
          }

          // Check for stop execution
          const stopTool = completedToolCalls.find(
            (tc) => tc.response.errorType === ToolErrorType.STOP_EXECUTION,
          );
          if (stopTool) break;

          // Continue with tool results
          currentParts =
            toolResponseParts.length > 0
              ? toolResponseParts
              : [{ text: 'Tool execution completed.' }];
        } else {
          // No more tool calls -- done
          break;
        }
      }

      // Send final response
      if (accumulatedText.trim()) {
        const chunks = formatResponse(
          accumulatedText,
          this.discordConfig.textChunkLimit,
        );

        if (isStreaming && previewMessageId && chunks.length === 1) {
          await ctx.editMessage(previewMessageId, chunks[0]);
        } else {
          if (isStreaming && previewMessageId) {
            await ctx.editMessage(previewMessageId, chunks[0]);
            for (let i = 1; i < chunks.length; i++) {
              await ctx.reply(chunks[i]);
            }
          } else {
            for (const chunk of chunks) {
              await ctx.reply(chunk);
            }
          }
        }

        // Show AI response in CLI display
        pushToCliDisplay({ type: 'gemini_content', text: accumulatedText });
      } else {
        await ctx.reply(
          '*No response generated. Try rephrasing your message.*',
        );
      }
    } catch (err) {
      debugLogger.error('Discord: error processing message:', err);
      await ctx.reply(formatError(err));
    } finally {
      setDiscordProcessing(false);
      clearInterval(typingInterval);
      await ctx.unreact('\u{1F440}');
      release();
    }
  }
}

// --- Public API ---

/**
 * Creates and starts the Discord service.
 * Uses the CLI's shared GeminiClient -- same conversation, same history.
 */
export async function startDiscordService(
  config: Config,
  overrides?: Partial<DiscordConfig>,
): Promise<DiscordService> {
  const token = overrides?.botToken || process.env['DISCORD_BOT_TOKEN'] || '';

  if (!token) {
    throw new Error(
      'Discord bot token not configured. Set DISCORD_BOT_TOKEN env var or pass --discord-token.',
    );
  }

  const allowFrom =
    overrides?.allowFrom ||
    process.env['DISCORD_ALLOW_FROM']
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ||
    [];

  const discordConfig: DiscordConfig = {
    ...DISCORD_DEFAULTS,
    ...overrides,
    enabled: true,
    botToken: token,
    allowFrom,
  };

  const service = new DiscordService(config, discordConfig);
  await service.start();
  return service;
}
