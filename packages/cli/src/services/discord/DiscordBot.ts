/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_DISCORD_FEATURE: This entire file is part of the Discord integration

import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  type Message,
} from 'discord.js';
import { debugLogger } from '@google/gemini-cli-core';
import type { DiscordConfig } from './types.js';

/** Callback for incoming text messages */
export type MessageHandler = (ctx: {
  channelId: string;
  userId: string;
  username?: string;
  displayName?: string;
  text: string;
  messageId: string;
  isGuild: boolean;
  /** Reply to the message */
  reply: (text: string) => Promise<string>;
  /** Edit a sent message */
  editMessage: (messageId: string, text: string) => Promise<void>;
  /** Send typing indicator */
  sendTyping: () => Promise<void>;
  /** React to the trigger message */
  react: (emoji: string) => Promise<void>;
  /** Remove a reaction */
  unreact: (emoji: string) => Promise<void>;
}) => Promise<void>;

/** Callback for bot commands */
export type CommandHandler = (ctx: {
  channelId: string;
  userId: string;
  command: string;
  args: string;
  reply: (text: string) => Promise<string>;
}) => Promise<void>;

/**
 * Wraps discord.js Client with access control and message routing.
 * Follows the same pattern as TelegramBotWrapper for consistency.
 */
export class DiscordBotWrapper {
  private client: Client;
  private botUsername = '';
  private botId = '';
  private messageHandler?: MessageHandler;
  private commandHandlers = new Map<string, CommandHandler>();
  private started = false;
  /** Cache of sent messages for editing — maps messageId to Message object */
  private sentMessages = new Map<string, Message>();
  /** Tracks channels where the mention hint has been sent (avoid spam) */
  private hintedChannels = new Set<string>();
  /** Fires when any allowed user sends a message (even without mention) */
  private channelActivityHandler?: (channelId: string) => void;

  constructor(private readonly discordConfig: DiscordConfig) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel], // needed for DM events
    });
  }

  /**
   * Sets the handler for incoming text messages.
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * Registers a command handler (e.g., 'start', 'status').
   */
  onCommand(command: string, handler: CommandHandler): void {
    this.commandHandlers.set(command, handler);
  }

  /**
   * Starts the bot (connects to Discord gateway).
   */
  async start(): Promise<void> {
    if (this.started) return;

    // Set up event handlers before login
    this.setupMessageHandler();

    await this.client.login(this.discordConfig.botToken);

    // Wait for ready event
    await new Promise<void>((resolve) => {
      if (this.client.isReady()) {
        this.botUsername = this.client.user.username;
        this.botId = this.client.user.id;
        resolve();
      } else {
        this.client.once(Events.ClientReady, (readyClient) => {
          this.botUsername = readyClient.user.username;
          this.botId = readyClient.user.id;
          debugLogger.debug(
            `Discord: bot started as ${this.botUsername} (${this.botId})`,
          );
          resolve();
        });
      }
    });

    this.started = true;
  }

  /**
   * Stops the bot.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    await this.client.destroy();
    this.sentMessages.clear();
    this.started = false;
    debugLogger.debug('Discord: bot stopped');
  }

  get username(): string {
    return this.botUsername;
  }

  /**
   * Sends a message to a specific channel (for CLI -> Discord forwarding).
   */
  async sendToChannel(channelId: string, text: string): Promise<string> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'send' in channel && typeof channel.send === 'function') {
         
        const sent = await (
          channel as { send: (t: string) => Promise<Message> }
        ).send(text);
        return sent.id;
      }
      throw new Error('Channel not found or not text-based');
    } catch (err) {
      debugLogger.error(
        `Discord: failed to send to channel ${channelId}:`,
        err,
      );
      throw err;
    }
  }

  /**
   * Registers a callback for any allowed-user activity (even without @mention).
   * Used by DiscordService to track lastActiveChannelId for CLI->Discord forwarding.
   */
  onChannelActivity(handler: (channelId: string) => void): void {
    this.channelActivityHandler = handler;
  }

  /**
   * Updates the allow list at runtime.
   */
  updateAllowList(allowFrom: string[]): void {
    this.discordConfig.allowFrom = allowFrom;
  }

  // --- Private setup ---

  private setupMessageHandler(): void {
    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including our own)
      if (message.author.bot) return;

      // Access control
      if (!this.isAllowed(message)) {
        debugLogger.debug(
          `Discord: blocked message from user ${message.author.id} (not in allowFrom)`,
        );
        // Reply with the user's ID so they can add themselves
        try {
          await message.reply(
            `Access denied.\n\nYour Discord user ID is: \`${message.author.id}\`\n\n` +
              `To grant access, run this in Auditaria CLI:\n` +
              `\`/discord allow ${message.author.id}\``,
          );
        } catch {
          // Ignore reply errors
        }
        return;
      }

      const text = message.content.trim();
      if (!text) return;

      const isGuild = !!message.guild;

      // Track channel activity for CLI -> Discord forwarding
      this.channelActivityHandler?.(message.channel.id);

      // Check for !commands (Discord prefix commands)
      if (text.startsWith('!')) {
        const parts = text.slice(1).split(/\s+/);
        const command = parts[0]?.toLowerCase();
        const args = parts.slice(1).join(' ');

        if (command) {
          const handler = this.commandHandlers.get(command);
          if (handler) {
            try {
              await handler({
                channelId: message.channel.id,
                userId: message.author.id,
                command,
                args,
                reply: async (replyText) => {
                  const sent = await message.reply(replyText);
                  return sent.id;
                },
              });
            } catch (err) {
              debugLogger.error(`Discord: error in !${command} handler:`, err);
              await message.reply('An error occurred. Please try again.');
            }
            return;
          }
        }
      }

      // Guild mention check — require @mention in server channels
      if (isGuild && this.discordConfig.guilds?.requireMention) {
        if (!this.isMentioned(message)) {
          // One-time hint per channel so the user knows to @mention
          if (!this.hintedChannels.has(message.channel.id)) {
            this.hintedChannels.add(message.channel.id);
            try {
              await message.reply(
                `In server channels, please **@mention me** to get a response.\n` +
                  `Example: <@${this.botId}> your question here\n\n` +
                  `Or send me a DM for conversation without mentions.`,
              );
            } catch {
              // Ignore reply errors
            }
          }
          return;
        }
      }

      // Strip bot mention from text
      let cleanText = text;
      if (this.botId) {
        cleanText = cleanText
          .replace(new RegExp(`<@!?${this.botId}>`, 'g'), '')
          .trim();
      }

      if (!cleanText) return;

      if (!this.messageHandler) return;

      const displayName =
        message.member?.displayName || message.author.displayName;

      try {
        await this.messageHandler({
          channelId: message.channel.id,
          userId: message.author.id,
          username: message.author.username,
          displayName,
          text: cleanText,
          messageId: message.id,
          isGuild,
          reply: async (replyText) => {
            const sent = await message.reply(replyText);
            this.sentMessages.set(sent.id, sent);
            return sent.id;
          },
          editMessage: async (messageId, newText) => {
            try {
              const cached = this.sentMessages.get(messageId);
              if (cached) {
                await cached.edit(newText);
              }
            } catch {
              // Ignore edit errors (message too old, etc.)
            }
          },
          sendTyping: async () => {
            try {
              if ('sendTyping' in message.channel) {
                await (
                  message.channel as { sendTyping: () => Promise<void> }
                ).sendTyping();
              }
            } catch {
              // Ignore typing errors
            }
          },
          react: async (emoji) => {
            try {
              await message.react(emoji);
            } catch {
              // Reactions may not be supported
            }
          },
          unreact: async (emoji) => {
            try {
              const reaction = message.reactions.cache.find(
                (r) => r.emoji.name === emoji,
              );
              if (reaction && this.botId) {
                await reaction.users.remove(this.botId);
              }
            } catch {
              // Ignore
            }
          },
        });
      } catch (err) {
        debugLogger.error('Discord: error in message handler:', err);
        await message.reply('An error occurred processing your message.');
      }
    });
  }

  /**
   * Checks if a user is allowed to interact with the bot.
   */
  private isAllowed(message: Message): boolean {
    const userId = message.author.id;
    if (!userId) return false;

    // Empty allow list = deny all (security: require explicit user IDs)
    if (this.discordConfig.allowFrom.length === 0) return false;

    return this.discordConfig.allowFrom.includes(userId);
  }

  /**
   * Checks if the bot is mentioned in the message (for guild channels).
   */
  private isMentioned(message: Message): boolean {
    if (!this.botId) return false;
    return message.mentions.has(this.botId);
  }
}
