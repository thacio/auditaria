/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_TELEGRAM_FEATURE: This entire file is part of the Telegram integration

import type { Config, ToolCallRequestInfo } from '@google/gemini-cli-core';
import {
  GeminiEventType,
  Scheduler,
  debugLogger,
  ToolErrorType,
  recordToolCallInteractions,
} from '@google/gemini-cli-core';
import type { Part } from '@google/genai';
import { TelegramBotWrapper } from './TelegramBot.js';
import {
  formatResponse,
  formatToolCall,
  formatError,
  markdownToTelegramHtml,
} from './TelegramFormatter.js';
import {
  TELEGRAM_DEFAULTS,
  STREAM_EDIT_THROTTLE_MS,
  type TelegramConfig,
} from './types.js';
import {
  pushToCliDisplay,
  setTelegramProcessing,
  injectCliInput,
} from './TelegramBridge.js';
import type { HistoryItem } from '../../ui/types.js';

/**
 * Main Telegram service that bridges the grammY bot with Auditaria's agent loop.
 *
 * Uses the CLI's shared GeminiClient (same conversation, same history).
 * A mutex ensures only one message is processed at a time (CLI or Telegram).
 *
 * Bidirectional display sync:
 * - Telegram → CLI: pushes user messages and responses to CLI display via TelegramBridge
 * - CLI → Telegram: receives history items from useHistoryManager and forwards to last active chat
 *
 * Message flow:
 * 1. User sends message in Telegram
 * 2. grammY receives via long polling
 * 3. Access check + sequential processing per chat
 * 4. Acquire mutex (blocks if CLI is processing)
 * 5. Push user message to CLI display
 * 6. Call sendMessageStream() on shared GeminiClient
 * 7. Process events: accumulate text, execute tools, handle errors
 * 8. Format response as Telegram HTML, chunk if needed
 * 9. Send back via Telegram API + push response to CLI display, release mutex
 */
export class TelegramService {
  private bot: TelegramBotWrapper;
  private stopped = false;
  /** Mutex: resolves when the current message finishes processing */
  private processingLock: Promise<void> = Promise.resolve();
  /** Last chat ID that sent a message — used for CLI → Telegram forwarding */
  private lastActiveChatId: number | undefined;

  constructor(
    private readonly config: Config,
    private readonly telegramConfig: TelegramConfig,
  ) {
    this.bot = new TelegramBotWrapper(telegramConfig);
    this.registerHandlers();
  }

  /**
   * Starts the Telegram bot (long polling).
   */
  async start(): Promise<void> {
    await this.bot.start();
    debugLogger.debug('Telegram: service started (shared session mode)');
  }

  /**
   * Returns the bot's @username (available after start).
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
    debugLogger.debug('Telegram: service stopped');
  }

  /**
   * Forwards a CLI history item to the last active Telegram chat.
   * Called by useHistoryManager via TelegramBridge when CLI produces output.
   * Only forwards user messages and AI responses; ignores tool groups, info, etc.
   */
  forwardCliItem(item: HistoryItem): void {
    if (!this.lastActiveChatId || this.stopped) return;

    const chatId = this.lastActiveChatId;

    if (item.type === 'user') {
      // CLI user typed something — show in Telegram
      const label = '\u{1F4BB} <b>[CLI]</b> ';
      const html = label + markdownToTelegramHtml(item.text);
      void this.bot.sendToChat(chatId, html, 'HTML').catch(() => {});
    } else if (item.type === 'gemini_content' || item.type === 'gemini') {
      // AI response from CLI — forward to Telegram
      const chunks = formatResponse(
        item.text,
        this.telegramConfig.textChunkLimit,
      );
      for (const chunk of chunks) {
        void this.bot.sendToChat(chatId, chunk, 'HTML').catch(() => {});
      }
    }
  }

  // --- Handler registration ---

  private registerHandlers(): void {
    // Commands
    this.bot.onCommand('start', async (ctx) => {
      await ctx.reply(
        '<b>Auditaria CLI Bot</b>\n\n' +
          "Send me any message and I'll process it with the AI agent.\n" +
          'This is a mirror of your CLI session — same conversation, same tools.\n\n' +
          '<b>Commands:</b>\n' +
          '/status - Show session info\n' +
          '/help - Show this message',
      );
    });

    this.bot.onCommand('help', async (ctx) => {
      await ctx.reply(
        '<b>Available commands:</b>\n\n' +
          '/status - Show current model and session info\n' +
          '/help - Show this help message\n\n' +
          '<i>This bot shares the same conversation as your Auditaria CLI.</i>',
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

      let statusText = `<b>Status</b>\n\n`;
      statusText += `<b>Model:</b> ${model}\n`;
      statusText += `<b>Provider:</b> ${provider}\n`;
      statusText += `<b>Session:</b> shared with CLI\n`;

      if (geminiClient?.isInitialized()) {
        const history = geminiClient.getHistory();
        const turns = history.filter((c) => c.role === 'user').length;
        statusText += `<b>Turns:</b> ${turns}\n`;
      }

      statusText += `\n<b>Your user ID:</b> <code>${ctx.userId}</code>\n`;
      const isAllowed = this.telegramConfig.allowFrom.includes(
        String(ctx.userId),
      );
      statusText += `<b>Access:</b> ${isAllowed ? 'allowed' : 'denied'}\n`;
      statusText += `<b>Allow list:</b> ${this.telegramConfig.allowFrom.length > 0 ? this.telegramConfig.allowFrom.join(', ') : 'empty (all denied)'}`;

      await ctx.reply(statusText);
    });

    // Message handler — uses shared GeminiClient with mutex
    this.bot.onMessage(async (ctx) => {
      await this.processMessage(ctx);
    });
  }

  // --- Mutex ---

  /**
   * Acquires the processing lock. Returns a release function.
   * While locked, other messages (CLI or Telegram) must wait.
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
    chatId: number;
    userId: number;
    username?: string;
    displayName?: string;
    text: string;
    messageId: number;
    isGroup: boolean;
    reply: (text: string, parseMode?: 'HTML' | 'Markdown') => Promise<number>;
    editMessage: (
      messageId: number,
      text: string,
      parseMode?: 'HTML' | 'Markdown',
    ) => Promise<void>;
    sendTyping: () => Promise<void>;
    react: (emoji: string) => Promise<void>;
    unreact: (emoji: string) => Promise<void>;
  }): Promise<void> {
    const { text } = ctx;

    // Track last active chat for CLI → Telegram forwarding
    this.lastActiveChatId = ctx.chatId;

    // Detect Auditaria slash commands (e.g., /quit, /compress, /model)
    // and inject them into the CLI command processor instead of sending to AI
    if (text.startsWith('/')) {
      const injected = injectCliInput(text);
      if (injected) {
        await ctx.react('\u{2705}'); // checkmark
        const userLabel = ctx.username
          ? `@${ctx.username}`
          : ctx.displayName || String(ctx.userId);
        pushToCliDisplay({
          type: 'user',
          text: `[Telegram ${userLabel}] ${text}`,
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

    // Acquire mutex — blocks if CLI or another Telegram message is processing
    const release = await this.acquireLock();

    // Mark as processing to prevent echo (CLI → Telegram → CLI loop)
    setTelegramProcessing(true);

    // Show user message in CLI display
    const userLabel = ctx.username
      ? `@${ctx.username}`
      : ctx.displayName || String(ctx.userId);
    pushToCliDisplay({ type: 'user', text: `[Telegram ${userLabel}] ${text}` });

    const abortController = new AbortController();
    const promptId = `telegram-${Date.now()}`;

    // Streaming state
    let previewMessageId: number | undefined;
    let accumulatedText = '';
    let lastEditTime = 0;
    const isStreaming = this.telegramConfig.streaming === 'edit';

    // Keep typing indicator alive
    const typingInterval = setInterval(async () => {
      if (!this.stopped) {
        await ctx.sendTyping();
      }
    }, 4000);

    try {
      const scheduler = new Scheduler({
        config: this.config,
        messageBus: this.config.getMessageBus(),
        getPreferredEditor: () => undefined,
        schedulerId: `telegram-${ctx.chatId}`,
      });

      let currentParts: Part[] = [{ text }];
      let turnCount = 0;

      // Agent loop — same pattern as nonInteractiveCli.ts
      while (true) {
        if (this.stopped) break;

        turnCount++;
        if (turnCount > 50) {
          await ctx.reply('<i>Maximum turns reached.</i>', 'HTML');
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
              if (now - lastEditTime >= STREAM_EDIT_THROTTLE_MS) {
                const previewHtml = markdownToTelegramHtml(
                  accumulatedText + ' ...',
                );
                if (previewMessageId) {
                  await ctx.editMessage(previewMessageId, previewHtml, 'HTML');
                } else {
                  previewMessageId = await ctx.reply(previewHtml, 'HTML');
                }
                lastEditTime = now;
              }
            }
          } else if (event.type === GeminiEventType.ToolCallRequest) {
            toolCallRequests.push(event.value);

            // Notify user about tool execution
            const toolNotice = formatToolCall(event.value.name);
            if (isStreaming && previewMessageId) {
              const currentHtml = markdownToTelegramHtml(accumulatedText);
              await ctx.editMessage(
                previewMessageId,
                currentHtml + '\n\n' + toolNotice,
                'HTML',
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
                `Telegram: tool ${completed.request.name} error:`,
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
            debugLogger.error('Telegram: error recording tool calls:', err);
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
          // No more tool calls — done
          break;
        }
      }

      // Send final response
      if (accumulatedText.trim()) {
        const chunks = formatResponse(
          accumulatedText,
          this.telegramConfig.textChunkLimit,
        );

        if (isStreaming && previewMessageId && chunks.length === 1) {
          await ctx.editMessage(previewMessageId, chunks[0], 'HTML');
        } else {
          if (isStreaming && previewMessageId) {
            await ctx.editMessage(previewMessageId, chunks[0], 'HTML');
            for (let i = 1; i < chunks.length; i++) {
              await ctx.reply(chunks[i], 'HTML');
            }
          } else {
            for (const chunk of chunks) {
              await ctx.reply(chunk, 'HTML');
            }
          }
        }

        // Show AI response in CLI display
        pushToCliDisplay({ type: 'gemini_content', text: accumulatedText });
      } else {
        await ctx.reply(
          '<i>No response generated. Try rephrasing your message.</i>',
          'HTML',
        );
      }
    } catch (err) {
      debugLogger.error('Telegram: error processing message:', err);
      await ctx.reply(formatError(err), 'HTML');
    } finally {
      setTelegramProcessing(false);
      clearInterval(typingInterval);
      await ctx.unreact('\u{1F440}');
      release();
    }
  }
}

// --- Public API ---

/**
 * Creates and starts the Telegram service.
 * Uses the CLI's shared GeminiClient — same conversation, same history.
 */
export async function startTelegramService(
  config: Config,
  overrides?: Partial<TelegramConfig>,
): Promise<TelegramService> {
  const token = overrides?.botToken || process.env['TELEGRAM_BOT_TOKEN'] || '';

  if (!token) {
    throw new Error(
      'Telegram bot token not configured. Set TELEGRAM_BOT_TOKEN env var or pass --telegram-token.',
    );
  }

  const allowFrom =
    overrides?.allowFrom ||
    process.env['TELEGRAM_ALLOW_FROM']
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ||
    [];

  const telegramConfig: TelegramConfig = {
    ...TELEGRAM_DEFAULTS,
    ...overrides,
    enabled: true,
    botToken: token,
    allowFrom,
  };

  const service = new TelegramService(config, telegramConfig);
  await service.start();
  return service;
}
