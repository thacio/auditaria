/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_DISCORD_FEATURE: This entire file is part of the Discord integration

/**
 * Discord bot configuration.
 */
export interface DiscordConfig {
  /** Whether Discord bot is enabled */
  enabled: boolean;
  /** Discord Bot API token from Developer Portal */
  botToken: string;
  /** Discord user IDs (snowflakes) allowed to interact with the bot */
  allowFrom: string[];
  /** Guild (server) chat settings */
  guilds?: {
    /** Whether the bot requires @mention to respond in guild channels */
    requireMention: boolean;
  };
  /** Streaming mode: 'off' = wait for full response, 'edit' = edit message as response builds */
  streaming: 'off' | 'edit';
  /** Maximum text chunk size for Discord messages (default 1900) */
  textChunkLimit: number;
}

/**
 * Default Discord configuration values.
 */
export const DISCORD_DEFAULTS: DiscordConfig = {
  enabled: false,
  botToken: '',
  allowFrom: [],
  guilds: {
    requireMention: true,
  },
  streaming: 'edit',
  textChunkLimit: 1900,
};

/** Discord message character limit */
export const DISCORD_MAX_MESSAGE_LENGTH = 2000;

/** Throttle interval for edit-in-place streaming (ms) */
export const DISCORD_STREAM_EDIT_THROTTLE_MS = 1000;
