/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_TELEGRAM_FEATURE: This entire file is part of the Telegram integration

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Config } from '@google/gemini-cli-core';
import { GeminiClient, debugLogger } from '@google/gemini-cli-core';
import {
  TELEGRAM_SESSIONS_DIR,
  MAX_TURNS_PER_SESSION,
  type TelegramSessionState,
  type TelegramConfig,
} from './types.js';

/**
 * A single Telegram chat session with its own GeminiClient and conversation history.
 */
export interface TelegramSession {
  chatId: string;
  userId: string;
  username?: string;
  displayName?: string;
  client: GeminiClient;
  createdAt: number;
  lastActiveAt: number;
  /** Whether the client has been initialized (startChat called) */
  initialized: boolean;
}

/**
 * Manages per-chat Telegram sessions with independent conversation histories.
 * Each chat (DM or group) gets its own GeminiClient with its own GeminiChat.
 */
export class TelegramSessionManager {
  private sessions = new Map<string, TelegramSession>();
  private readonly sessionsDir: string;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: Config,
    private readonly telegramConfig: TelegramConfig,
  ) {
    const auditariaDir = path.join(os.homedir(), '.auditaria');
    this.sessionsDir = path.join(auditariaDir, TELEGRAM_SESSIONS_DIR);
    fs.mkdirSync(this.sessionsDir, { recursive: true });

    // Cleanup idle sessions every 10 minutes
    this.cleanupTimer = setInterval(
      () => this.cleanupIdleSessions(),
      10 * 60 * 1000,
    );
  }

  /**
   * Gets or creates a session for a given chat.
   * Each session has its own GeminiClient with independent conversation history.
   */
  async getOrCreateSession(
    chatId: string,
    userId: string,
    username?: string,
    displayName?: string,
  ): Promise<TelegramSession> {
    const sessionKey = String(chatId);
    let session = this.sessions.get(sessionKey);

    if (session) {
      session.lastActiveAt = Date.now();
      return session;
    }

    // Create a new GeminiClient sharing the same Config
    const client = new GeminiClient(this.config);

    session = {
      chatId: sessionKey,
      userId: String(userId),
      username,
      displayName,
      client,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      initialized: false,
    };

    this.sessions.set(sessionKey, session);

    // Try to restore previous history
    const savedState = this.loadSessionState(sessionKey);
    if (savedState && savedState.history.length > 0) {
      try {
        await client.resumeChat(savedState.history);
        session.initialized = true;
        session.createdAt = savedState.createdAt;
        debugLogger.debug(
          `Telegram: restored session for chat ${sessionKey} with ${savedState.history.length} history entries`,
        );
      } catch (err) {
        debugLogger.error(
          `Telegram: failed to restore session for chat ${sessionKey}:`,
          err,
        );
        // Fall through to fresh initialization
      }
    }

    if (!session.initialized) {
      await client.initialize();
      session.initialized = true;
    }

    return session;
  }

  /**
   * Resets a session (clears conversation history).
   */
  async resetSession(chatId: string): Promise<void> {
    const sessionKey = String(chatId);
    const session = this.sessions.get(sessionKey);

    if (session) {
      await session.client.resetChat();
      session.lastActiveAt = Date.now();
      debugLogger.debug(`Telegram: reset session for chat ${sessionKey}`);
    }

    // Delete persisted state
    this.deleteSessionState(sessionKey);
  }

  /**
   * Saves the current session state to disk.
   */
  saveSession(chatId: string): void {
    const sessionKey = String(chatId);
    const session = this.sessions.get(sessionKey);
    if (!session || !session.initialized) return;

    try {
      const history = session.client.getHistory();
      const state: TelegramSessionState = {
        chatId: session.chatId,
        userId: session.userId,
        username: session.username,
        displayName: session.displayName,
        history,
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt,
      };

      const filePath = this.getSessionFilePath(sessionKey);
      fs.writeFileSync(filePath, JSON.stringify(state), 'utf-8');
    } catch (err) {
      debugLogger.error(`Telegram: failed to save session ${sessionKey}:`, err);
    }
  }

  /**
   * Saves all active sessions to disk.
   */
  saveAllSessions(): void {
    for (const [chatId] of this.sessions) {
      this.saveSession(chatId);
    }
  }

  /**
   * Gets the turn count for a session (number of user messages).
   */
  getSessionTurnCount(chatId: string): number {
    const session = this.sessions.get(String(chatId));
    if (!session || !session.initialized) return 0;
    return session.client.getHistory().filter((c) => c.role === 'user').length;
  }

  /**
   * Checks if a session should be auto-compacted.
   */
  shouldAutoCompact(chatId: string): boolean {
    return this.getSessionTurnCount(chatId) > MAX_TURNS_PER_SESSION;
  }

  /**
   * Gets info about an active session.
   */
  getSessionInfo(
    chatId: string,
  ): { turns: number; created: Date; lastActive: Date } | undefined {
    const session = this.sessions.get(String(chatId));
    if (!session) return undefined;
    return {
      turns: this.getSessionTurnCount(chatId),
      created: new Date(session.createdAt),
      lastActive: new Date(session.lastActiveAt),
    };
  }

  /**
   * Disposes all sessions and cleanup timers.
   */
  dispose(): void {
    this.saveAllSessions();

    for (const [, session] of this.sessions) {
      session.client.dispose();
    }
    this.sessions.clear();

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  // --- Private helpers ---

  private loadSessionState(
    sessionKey: string,
  ): TelegramSessionState | undefined {
    const filePath = this.getSessionFilePath(sessionKey);
    try {
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf-8');
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        return JSON.parse(data) as TelegramSessionState;
      }
    } catch (err) {
      debugLogger.error(
        `Telegram: failed to load session state ${sessionKey}:`,
        err,
      );
    }
    return undefined;
  }

  private deleteSessionState(sessionKey: string): void {
    const filePath = this.getSessionFilePath(sessionKey);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      debugLogger.error(
        `Telegram: failed to delete session state ${sessionKey}:`,
        err,
      );
    }
  }

  private getSessionFilePath(sessionKey: string): string {
    // Sanitize chat ID for use as filename (groups have negative IDs)
    const safeId = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.sessionsDir, `${safeId}.json`);
  }

  private cleanupIdleSessions(): void {
    const timeoutMs = this.telegramConfig.sessionTimeout * 60 * 1000;
    const now = Date.now();

    for (const [key, session] of this.sessions) {
      if (now - session.lastActiveAt > timeoutMs) {
        this.saveSession(key);
        session.client.dispose();
        this.sessions.delete(key);
        debugLogger.debug(`Telegram: cleaned up idle session ${key}`);
      }
    }
  }
}
