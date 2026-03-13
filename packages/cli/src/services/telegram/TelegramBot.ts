/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_TELEGRAM_FEATURE: This entire file is part of the Telegram integration

import { Bot, type Context } from 'grammy';
import { debugLogger } from '@google/gemini-cli-core';
import { TELEGRAM_MAX_MESSAGE_LENGTH, type TelegramConfig } from './types.js';
import { chunkText } from './TelegramFormatter.js';
import {
  ALLOWED_MIME_TYPES,
  validateAttachment,
  MAX_ATTACHMENT_SIZE,
  type ValidatedAttachment,
} from '../attachments.js';

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

/**
 * Detects Telegram API "message is too long" errors from grammY.
 */
function isMessageTooLong(err: unknown): boolean {
  return err instanceof Error && err.message.includes('message is too long');
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
  /** Validated image attachments (inline, never saved to disk) */
  attachments?: ValidatedAttachment[];
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
    } catch (err) {
      // Message too long — auto-chunk and send multiple messages
      if (isMessageTooLong(err)) {
        return this.sendChunked(chatId, text, parseMode);
      }
      // Fallback: send without parse mode if HTML fails
      try {
        const sent = await this.bot.api.sendMessage(chatId, text);
        return sent.message_id;
      } catch (err2) {
        if (isMessageTooLong(err2)) {
          return this.sendChunked(chatId, text);
        }
        throw err2;
      }
    }
  }

  /**
   * Splits text into chunks and sends each one. Used as fallback when
   * a single sendMessage exceeds Telegram's 4096-character limit.
   */
  private async sendChunked(
    chatId: number,
    text: string,
    parseMode?: 'HTML' | 'Markdown',
  ): Promise<number> {
    const chunks = chunkText(text, TELEGRAM_MAX_MESSAGE_LENGTH - 100);
    let lastMsgId = 0;
    for (const chunk of chunks) {
      try {
        const sent = await this.bot.api.sendMessage(chatId, chunk, {
          parse_mode: parseMode || 'HTML',
        });
        lastMsgId = sent.message_id;
      } catch {
        const sent = await this.bot.api.sendMessage(chatId, chunk);
        lastMsgId = sent.message_id;
      }
    }
    return lastMsgId;
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
    // Handle text messages (may have no attachments)
    this.bot.on('message:text', async (ctx) => {
      await this.handleIncoming(ctx, ctx.message.text || '', []);
    });

    // Handle photo messages (compressed images — Telegram sends as photo array)
    this.bot.on('message:photo', async (ctx) => {
      const caption = ctx.message.caption || '';
      const attachments = await this.downloadPhoto(ctx);
      await this.handleIncoming(ctx, caption, attachments);
    });

    // Handle document messages (images sent as files, uncompressed)
    this.bot.on('message:document', async (ctx) => {
      const doc = ctx.message.document;
      if (!doc) return;
      const mime = doc.mime_type || '';
      if (!ALLOWED_MIME_TYPES.has(mime)) {
        try {
          await ctx.reply(
            'Only image attachments (PNG, JPG, GIF, WEBP) are supported.',
          );
        } catch {
          // Ignore
        }
        return;
      }
      const caption = ctx.message.caption || '';
      const attachments = await this.downloadDocument(ctx, doc);
      await this.handleIncoming(ctx, caption, attachments);
    });
  }

  /**
   * Common handler for text, photo, and document messages.
   */
  private async handleIncoming(
    ctx: Context,
    rawText: string,
    attachments: ValidatedAttachment[],
  ): Promise<void> {
    if (!this.messageHandler || !ctx.chat || !ctx.from) return;
    if (!ctx.message) return;

    const chat = ctx.chat;
    const from = ctx.from;
    const message = ctx.message;
    let text = rawText;

    // Skip if it's a registered Telegram bot command (already handled by grammY)
    if (text.startsWith('/')) {
      const cmdName = text.slice(1).split(/[\s@]/)[0]?.toLowerCase();
      if (cmdName && this.commandHandlers.has(cmdName)) return;
      // Other /commands pass through to messageHandler (Auditaria slash commands)
    }

    // Need either text or attachments
    if (!text && attachments.length === 0) return;

    // Group mention check
    const isGroup = chat.type === 'group' || chat.type === 'supergroup';
    if (isGroup && this.telegramConfig.groups?.requireMention) {
      if (!this.isMentioned(text)) return;
    }

    // Strip bot mention from text
    if (this.botUsername) {
      text = text
        .replace(new RegExp(`@${this.botUsername}\\b`, 'gi'), '')
        .trim();
    }

    if (!text && attachments.length === 0) return;

    const displayName = [from.first_name, from.last_name]
      .filter(Boolean)
      .join(' ');

    try {
      await this.messageHandler({
        chatId: chat.id,
        userId: from.id,
        username: from.username,
        displayName,
        text,
        messageId: message.message_id,
        isGroup,
        attachments: attachments.length > 0 ? attachments : undefined,
        reply: async (replyText, parseMode) => {
          const sendChunkedReplies = async (
            mode?: 'HTML' | 'Markdown',
          ): Promise<number> => {
            const chunks = chunkText(
              replyText,
              TELEGRAM_MAX_MESSAGE_LENGTH - 100,
            );
            let lastMsgId = 0;
            for (const chunk of chunks) {
              try {
                const sent = await ctx.reply(
                  chunk,
                  mode ? { parse_mode: mode } : undefined,
                );
                lastMsgId = sent.message_id;
              } catch {
                const sent = await ctx.reply(chunk);
                lastMsgId = sent.message_id;
              }
            }
            return lastMsgId;
          };

          try {
            const sent = await ctx.reply(replyText, {
              parse_mode: parseMode || 'HTML',
            });
            return sent.message_id;
          } catch (err) {
            // Message too long — auto-chunk and send multiple messages
            if (isMessageTooLong(err)) {
              return sendChunkedReplies(parseMode || 'HTML');
            }
            // Fallback: send without parse mode if HTML fails
            try {
              const sent = await ctx.reply(replyText);
              return sent.message_id;
            } catch (err2) {
              if (isMessageTooLong(err2)) {
                return sendChunkedReplies();
              }
              throw err2;
            }
          }
        },
        editMessage: async (msgId, newText, parseMode) => {
          try {
            await ctx.api.editMessageText(chat.id, msgId, newText, {
              parse_mode: parseMode || 'HTML',
            });
          } catch {
            // Ignore edit errors (message too old, unchanged, etc.)
          }
        },
        sendTyping: async () => {
          try {
            await ctx.api.sendChatAction(chat.id, 'typing');
          } catch {
            // Ignore typing errors
          }
        },
        react: async (emoji) => {
          try {
            await ctx.api.setMessageReaction(chat.id, message.message_id, [
              // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
              { type: 'emoji', emoji } as any,
            ]);
          } catch {
            // Reactions may not be supported in all chats
          }
        },
        unreact: async (_emoji) => {
          try {
            await ctx.api.setMessageReaction(chat.id, message.message_id, []);
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
  }

  /**
   * Downloads a photo from Telegram (picks the largest size).
   * Returns validated attachment array (in-memory, never saved to disk).
   */
  private async downloadPhoto(ctx: Context): Promise<ValidatedAttachment[]> {
    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) return [];

    // Telegram sends multiple sizes — pick the largest
    const largest = photos[photos.length - 1];
    if (!largest) return [];

    try {
      const file = await ctx.api.getFile(largest.file_id);
      if (!file.file_path) return [];

      const url = `https://api.telegram.org/file/bot${this.telegramConfig.botToken}/${file.file_path}`;
      const response = await fetch(url);
      if (!response.ok) return [];

      const buffer = Buffer.from(await response.arrayBuffer());

      // Telegram photos are always JPEG
      const mimeType = 'image/jpeg';
      const fileName = file.file_path.split('/').pop() || 'photo.jpg';
      const error = validateAttachment(
        buffer,
        mimeType,
        fileName,
        buffer.length,
      );
      if (error) {
        debugLogger.debug(`Telegram: photo validation failed: ${error}`);
        try {
          await ctx.reply(error);
        } catch {
          // Ignore
        }
        return [];
      }

      return [{ data: buffer, mimeType, fileName }];
    } catch (err) {
      debugLogger.error('Telegram: failed to download photo:', err);
      return [];
    }
  }

  /**
   * Downloads a document (file) from Telegram.
   * Only called for documents with allowed MIME types.
   */
  private async downloadDocument(
    ctx: Context,
    doc: {
      file_id: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    },
  ): Promise<ValidatedAttachment[]> {
    const mimeType = doc.mime_type || '';

    // Size check before downloading
    if (doc.file_size && doc.file_size > MAX_ATTACHMENT_SIZE) {
      try {
        await ctx.reply('File is too large. Max: 5 MB.');
      } catch {
        // Ignore
      }
      return [];
    }

    try {
      const file = await ctx.api.getFile(doc.file_id);
      if (!file.file_path) return [];

      const url = `https://api.telegram.org/file/bot${this.telegramConfig.botToken}/${file.file_path}`;
      const response = await fetch(url);
      if (!response.ok) return [];

      const buffer = Buffer.from(await response.arrayBuffer());
      const fileName =
        doc.file_name || file.file_path.split('/').pop() || 'file';
      const error = validateAttachment(
        buffer,
        mimeType,
        fileName,
        buffer.length,
      );
      if (error) {
        try {
          await ctx.reply(error);
        } catch {
          // Ignore
        }
        return [];
      }

      return [{ data: buffer, mimeType, fileName }];
    } catch (err) {
      debugLogger.error('Telegram: failed to download document:', err);
      return [];
    }
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
