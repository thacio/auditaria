/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_TELEGRAM_FEATURE: This entire file is part of the Telegram integration

import { Bot, type Context } from 'grammy';
import { debugLogger } from '@google/gemini-cli-core';
import type { TelegramConfig } from './types.js';

/**
 * Simple per-key sequential processing middleware.
 * Ensures messages from the same chat are processed in order.
 * Based on OpenClaw's sequentialize pattern.
 */
function sequentialize(getKey: (ctx: Context) => string | undefined) {
  const locks = new Map<string, Promise<void>>();

  return async (ctx: Context, next: () => Promise<void>) => {
    const key = getKey(ctx);
    if (!key) {
      await next();
      return;
    }

    const prev = locks.get(key) ?? Promise.resolve();
    let resolve: () => void;
    const current = new Promise<void>((r) => {
      resolve = r;
    });
    locks.set(key, current);

    await prev;
    try {
      await next();
    } finally {
      resolve!();
      // Clean up if this is the last in the chain
      if (locks.get(key) === current) {
        locks.delete(key);
      }
    }
  };
}

/** Callback for incoming text messages */
export type MessageHandler = (ctx: {
  chatId: number;
  userId: number;
  username?: string;
  displayName?: string;
  text: string;
  messageId: number;
  isGroup: boolean;
  /** Reply to the message */
  reply: (text: string, parseMode?: 'HTML' | 'Markdown') => Promise<number>;
  /** Edit a sent message */
  editMessage: (
    messageId: number,
    text: string,
    parseMode?: 'HTML' | 'Markdown',
  ) => Promise<void>;
  /** Send typing indicator */
  sendTyping: () => Promise<void>;
  /** React to the trigger message */
  react: (emoji: string) => Promise<void>;
  /** Remove a reaction */
  unreact: (emoji: string) => Promise<void>;
}) => Promise<void>;

/** Callback for bot commands */
export type CommandHandler = (ctx: {
  chatId: number;
  userId: number;
  command: string;
  args: string;
  reply: (text: string, parseMode?: 'HTML' | 'Markdown') => Promise<number>;
}) => Promise<void>;

/**
 * Wraps grammY Bot with access control, sequential processing, and message routing.
 * Follows OpenClaw's pattern of sequentialize() per chat for safe concurrent handling.
 */
export class TelegramBotWrapper {
  private bot: Bot;
  private botUsername = '';
  private messageHandler?: MessageHandler;
  private commandHandlers = new Map<string, CommandHandler>();
  private started = false;

  constructor(private readonly telegramConfig: TelegramConfig) {
    this.bot = new Bot(telegramConfig.botToken);
    this.setupMiddleware();
  }

  /**
   * Sets the handler for incoming text messages.
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * Registers a command handler (e.g., 'start', 'new', 'status').
   */
  onCommand(command: string, handler: CommandHandler): void {
    this.commandHandlers.set(command, handler);
  }

  /**
   * Starts long polling.
   */
  async start(): Promise<void> {
    if (this.started) return;

    // Get bot info (username for mention detection)
    const me = await this.bot.api.getMe();
    this.botUsername = me.username || '';
    debugLogger.debug(`Telegram: bot started as @${this.botUsername}`);

    this.setupCommandHandlers();
    this.setupMessageHandler();

    // Start polling (non-blocking)
    void this.bot.start({
      onStart: () => {
        debugLogger.debug('Telegram: polling started');
      },
    });
    this.started = true;
  }

  /**
   * Stops the bot.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    await this.bot.stop();
    this.started = false;
    debugLogger.debug('Telegram: bot stopped');
  }

  get username(): string {
    return this.botUsername;
  }

  /**
   * Sends a message to a specific chat (for CLI → Telegram forwarding).
   */
  async sendToChat(
    chatId: number,
    text: string,
    parseMode?: 'HTML' | 'Markdown',
  ): Promise<number> {
    try {
      const sent = await this.bot.api.sendMessage(chatId, text, {
        parse_mode: parseMode || 'HTML',
      });
      return sent.message_id;
    } catch {
      // Fallback: send without parse mode if HTML fails
      const sent = await this.bot.api.sendMessage(chatId, text);
      return sent.message_id;
    }
  }

  // --- Private setup ---

  private setupMiddleware(): void {
    // Sequential processing per chat (OpenClaw pattern)
    // Ensures messages from the same chat are processed in order
    this.bot.use(
      sequentialize((ctx) => {
        const chatId = ctx.chat?.id;
        if (!chatId) return undefined;
        // Include thread ID for forum topics
        const threadId = ctx.message?.message_thread_id ?? 0;
        return `${chatId}:${threadId}`;
      }),
    );

    // Access control middleware
    this.bot.use(async (ctx: Context, next: () => Promise<void>) => {
      if (!this.isAllowed(ctx)) {
        const userId = ctx.from?.id;
        debugLogger.debug(
          `Telegram: blocked message from user ${userId} (not in allowFrom)`,
        );
        // Reply with the user's ID so they can add themselves via /telegram allow
        if (userId && ctx.chat) {
          try {
            await ctx.reply(
              `Access denied.\n\nYour Telegram user ID is: <code>${userId}</code>\n\n` +
                `To grant access, run this in Auditaria CLI:\n` +
                `<code>/telegram allow ${userId}</code>`,
              { parse_mode: 'HTML' },
            );
          } catch {
            // Ignore reply errors
          }
        }
        return;
      }
      await next();
    });
  }

  private setupCommandHandlers(): void {
    for (const [command, handler] of this.commandHandlers) {
      this.bot.command(command, async (ctx) => {
        if (!ctx.chat || !ctx.from) return;

        const args = ctx.match?.toString() || '';
        try {
          await handler({
            chatId: ctx.chat.id,
            userId: ctx.from.id,
            command,
            args,
            reply: async (text, parseMode) => {
              const sent = await ctx.reply(text, {
                parse_mode: parseMode || 'HTML',
              });
              return sent.message_id;
            },
          });
        } catch (err) {
          debugLogger.error(`Telegram: error in /${command} handler:`, err);
          await ctx.reply('An error occurred. Please try again.');
        }
      });
    }
  }

  private setupMessageHandler(): void {
    // Handle text messages
    this.bot.on('message:text', async (ctx) => {
      if (!this.messageHandler || !ctx.chat || !ctx.from) return;
      if (!ctx.message.text) return;

      // Skip if it's a command (already handled)
      if (ctx.message.text.startsWith('/')) return;

      // Group mention check
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      if (isGroup && this.telegramConfig.groups?.requireMention) {
        if (!this.isMentioned(ctx.message.text)) return;
      }

      // Strip bot mention from text
      let text = ctx.message.text;
      if (this.botUsername) {
        text = text
          .replace(new RegExp(`@${this.botUsername}\\b`, 'gi'), '')
          .trim();
      }

      if (!text) return;

      const displayName = [ctx.from.first_name, ctx.from.last_name]
        .filter(Boolean)
        .join(' ');

      try {
        await this.messageHandler({
          chatId: ctx.chat.id,
          userId: ctx.from.id,
          username: ctx.from.username,
          displayName,
          text,
          messageId: ctx.message.message_id,
          isGroup,
          reply: async (replyText, parseMode) => {
            try {
              const sent = await ctx.reply(replyText, {
                parse_mode: parseMode || 'HTML',
              });
              return sent.message_id;
            } catch {
              // Fallback: send without parse mode if HTML fails
              const sent = await ctx.reply(replyText);
              return sent.message_id;
            }
          },
          editMessage: async (messageId, newText, parseMode) => {
            try {
              await ctx.api.editMessageText(ctx.chat.id, messageId, newText, {
                parse_mode: parseMode || 'HTML',
              });
            } catch {
              // Ignore edit errors (message too old, unchanged, etc.)
            }
          },
          sendTyping: async () => {
            try {
              await ctx.api.sendChatAction(ctx.chat.id, 'typing');
            } catch {
              // Ignore typing errors
            }
          },
          react: async (emoji) => {
            try {
              await ctx.api.setMessageReaction(
                ctx.chat.id,
                ctx.message.message_id,
                [
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
                  { type: 'emoji', emoji } as any,
                ],
              );
            } catch {
              // Reactions may not be supported in all chats
            }
          },
          unreact: async (_emoji) => {
            try {
              await ctx.api.setMessageReaction(
                ctx.chat.id,
                ctx.message.message_id,
                [],
              );
            } catch {
              // Ignore
            }
          },
        });
      } catch (err) {
        debugLogger.error('Telegram: error in message handler:', err);
        await ctx.reply(
          'An error occurred processing your message. Use /new to reset.',
        );
      }
    });
  }

  /**
   * Checks if a user is allowed to interact with the bot.
   */
  private isAllowed(ctx: Context): boolean {
    const userId = ctx.from?.id;
    if (!userId) return false;

    // Empty allow list = deny all (security: require explicit user IDs)
    if (this.telegramConfig.allowFrom.length === 0) return false;

    // Check if user ID is in allowlist
    return this.telegramConfig.allowFrom.includes(String(userId));
  }

  /**
   * Updates the allow list at runtime (e.g., from /telegram allow command).
   */
  updateAllowList(allowFrom: string[]): void {
    this.telegramConfig.allowFrom = allowFrom;
  }

  /**
   * Checks if the bot is mentioned in the text (for group chats).
   */
  private isMentioned(text: string): boolean {
    if (!this.botUsername) return false;
    return text.toLowerCase().includes(`@${this.botUsername.toLowerCase()}`);
  }
}
