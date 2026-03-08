/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_TEAMS_FEATURE: This entire file is part of the Teams integration

/**
 * Response delivery mode for Teams messages.
 *
 * - 'sync': Return results in HTTP response (in-thread, 5s timeout)
 * - 'async': Return ack, POST results via incoming webhook (new post)
 * - 'labeled-async': Like async but with thread context label
 * - 'pull': Store results, return on next @mention (in-thread)
 * - 'hybrid': Try sync first, fall back to async if >4s
 */
export type TeamsResponseMode =
  | 'sync'
  | 'async'
  | 'labeled-async'
  | 'pull'
  | 'hybrid';

/**
 * Teams integration configuration.
 */
export interface TeamsConfig {
  /** Whether Teams integration is enabled */
  enabled: boolean;
  /** HMAC secret from outgoing webhook registration (base64) */
  hmacSecret: string;
  /** Port for the local HTTP server */
  port: number;
  /** User AAD Object IDs allowed to interact */
  allowFrom: string[];
  /** Incoming webhook URL for async responses */
  webhookUrl: string;
  /** How to deliver AI responses */
  responseMode: TeamsResponseMode;
  /** Whether to auto-start an ngrok tunnel (default: true) */
  tunnel: boolean;
}

/**
 * Default Teams configuration values.
 */
export const TEAMS_DEFAULTS: TeamsConfig = {
  enabled: false,
  hmacSecret: '',
  port: 3978,
  allowFrom: [],
  webhookUrl: '',
  responseMode: 'sync',
  tunnel: true,
};

/** Incoming webhook max payload size (bytes) */
export const INCOMING_WEBHOOK_MAX_SIZE = 28000;

/** Incoming webhook rate limit (messages per second) */
export const INCOMING_WEBHOOK_RATE_LIMIT = 4;

/** Sync response timeout (ms) — Power Automate HTTP action allows up to 120s */
export const SYNC_TIMEOUT_MS = 110000;

/** Hybrid mode timeout — try sync, fallback to async after this (ms) */
export const HYBRID_TIMEOUT_MS = 3500;

/**
 * Parsed incoming message from Teams outgoing webhook.
 */
export interface TeamsIncomingMessage {
  /** Message text with @mention stripped */
  text: string;
  /** Raw message text (with HTML) */
  rawText: string;
  /** User's AAD Object ID (unique, persistent) */
  userId: string;
  /** User's display name */
  userName: string;
  /** User's Teams ID (29:xxx format) */
  teamsUserId: string;
  /** Conversation/channel ID */
  conversationId: string;
  /** Conversation/channel name */
  conversationName: string;
  /** Message ID */
  messageId: string;
  /** Thread ID — top-level post ID that groups replies into one conversation context.
   *  Equals messageId for top-level posts; equals replyToId for replies. */
  threadId: string;
  /** Service URL (for reference) */
  serviceUrl: string;
  /** Full raw payload (for debugging) */
  rawPayload: Record<string, unknown>;
}
