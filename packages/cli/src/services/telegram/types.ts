/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_TELEGRAM_FEATURE: This entire file is part of the Telegram integration

import type { Content } from '@google/genai';

/**
 * Telegram bot configuration.
 */
export interface TelegramConfig {
  /** Whether Telegram bot is enabled */
  enabled: boolean;
  /** Telegram Bot API token from @BotFather */
  botToken: string;
  /** Numeric Telegram user IDs allowed to interact with the bot */
  allowFrom: string[];
  /** Group chat settings */
  groups?: {
    /** Whether the bot responds in groups */
    enabled: boolean;
    /** Whether the bot requires @mention to respond in groups */
    requireMention: boolean;
  };
  /** Streaming mode: 'off' = wait for full response, 'edit' = edit message as response builds */
  streaming: 'off' | 'edit';
  /** Maximum text chunk size for Telegram messages (default 4000) */
  textChunkLimit: number;
  /** Minutes before idle session cleanup (default 1440 = 24h) */
  sessionTimeout: number;
}

/**
 * Persisted state for a Telegram chat session.
 */
export interface TelegramSessionState {
  chatId: string;
  userId: string;
  username?: string;
  displayName?: string;
  history: readonly Content[];
  createdAt: number;
  lastActiveAt: number;
}

/**
 * Default Telegram configuration values.
 */
export const TELEGRAM_DEFAULTS: TelegramConfig = {
  enabled: false,
  botToken: '',
  allowFrom: [],
  groups: {
    enabled: true,
    requireMention: true,
  },
  streaming: 'edit',
  textChunkLimit: 4000,
  sessionTimeout: 1440,
};

/** Telegram message character limit */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/** Throttle interval for edit-in-place streaming (ms) */
export const STREAM_EDIT_THROTTLE_MS = 1000;

/** Telegram sessions directory name under .auditaria/ */
export const TELEGRAM_SESSIONS_DIR = 'telegram-sessions';

/** Maximum number of turns before auto-compacting */
export const MAX_TURNS_PER_SESSION = 200;
