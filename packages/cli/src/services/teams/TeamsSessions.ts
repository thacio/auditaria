/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_TEAMS_FEATURE: This entire file is part of the Teams integration

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Config } from '@google/gemini-cli-core';
import type { Content } from '@google/genai';
import { GeminiClient, debugLogger } from '@google/gemini-cli-core';

/** Directory for persisted Teams sessions */
const TEAMS_SESSIONS_DIR = 'teams-sessions';

/** Auto-compact after this many user turns */
const MAX_TURNS_PER_SESSION = 40;

/** Idle session timeout (ms) — 30 minutes */
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Persisted state for a single Teams thread session.
 */
interface TeamsSessionState {
  threadId: string;
  history: Content[];
  createdAt: number;
  lastActiveAt: number;
}

/**
 * A single Teams thread session with its own GeminiClient and conversation history.
 */
export interface TeamsSession {
  threadId: string;
  client: GeminiClient;
  createdAt: number;
  lastActiveAt: number;
  initialized: boolean;
}

/**
 * Manages per-thread Teams sessions with independent conversation histories.
 * Each thread (top-level post + its replies) gets its own GeminiClient.
 */
export class TeamsSessionManager {
  private sessions = new Map<string, TeamsSession>();
  private readonly sessionsDir: string;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly config: Config) {
    const auditariaDir = path.join(os.homedir(), '.auditaria');
    this.sessionsDir = path.join(auditariaDir, TEAMS_SESSIONS_DIR);
    fs.mkdirSync(this.sessionsDir, { recursive: true });

    // Cleanup idle sessions every 10 minutes
    this.cleanupTimer = setInterval(
      () => this.cleanupIdleSessions(),
      10 * 60 * 1000,
    );
  }

  /**
   * Gets or creates a session for a given thread.
   * Each session has its own GeminiClient with independent conversation history.
   */
  async getOrCreateSession(threadId: string): Promise<TeamsSession> {
    let session = this.sessions.get(threadId);

    if (session) {
      session.lastActiveAt = Date.now();
      return session;
    }

    // Create a new GeminiClient sharing the same Config
    const client = new GeminiClient(this.config);

    session = {
      threadId,
      client,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      initialized: false,
    };

    this.sessions.set(threadId, session);

    // Try to restore previous history
    const savedState = this.loadSessionState(threadId);
    if (savedState && savedState.history.length > 0) {
      try {
        await client.resumeChat(savedState.history);
        session.initialized = true;
        session.createdAt = savedState.createdAt;
        debugLogger.debug(
          `Teams: restored session for thread ${threadId} with ${savedState.history.length} history entries`,
        );
      } catch (err) {
        debugLogger.error(
          `Teams: failed to restore session for thread ${threadId}:`,
          err,
        );
      }
    }

    if (!session.initialized) {
      await client.initialize();
      session.initialized = true;
    }

    return session;
  }

  /**
   * Gets the turn count for a session (number of user messages).
   */
  getSessionTurnCount(threadId: string): number {
    const session = this.sessions.get(threadId);
    if (!session || !session.initialized) return 0;
    return session.client.getHistory().filter((c) => c.role === 'user').length;
  }

  /**
   * Checks if a session should be auto-compacted.
   */
  shouldAutoCompact(threadId: string): boolean {
    return this.getSessionTurnCount(threadId) > MAX_TURNS_PER_SESSION;
  }

  /**
   * Saves the current session state to disk.
   */
  saveSession(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (!session || !session.initialized) return;

    try {
      const history = session.client.getHistory();
      const state: TeamsSessionState = {
        threadId: session.threadId,
        history,
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt,
      };

      const filePath = this.getSessionFilePath(threadId);
      fs.writeFileSync(filePath, JSON.stringify(state), 'utf-8');
    } catch (err) {
      debugLogger.error(`Teams: failed to save session ${threadId}:`, err);
    }
  }

  /**
   * Saves all active sessions to disk.
   */
  saveAllSessions(): void {
    for (const [threadId] of this.sessions) {
      this.saveSession(threadId);
    }
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

  private loadSessionState(threadId: string): TeamsSessionState | undefined {
    const filePath = this.getSessionFilePath(threadId);
    try {
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, 'utf-8');
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        return JSON.parse(data) as TeamsSessionState;
      }
    } catch (err) {
      debugLogger.error(
        `Teams: failed to load session state ${threadId}:`,
        err,
      );
    }
    return undefined;
  }

  private getSessionFilePath(threadId: string): string {
    const safeId = threadId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.sessionsDir, `${safeId}.json`);
  }

  private cleanupIdleSessions(): void {
    const now = Date.now();

    for (const [key, session] of this.sessions) {
      if (now - session.lastActiveAt > SESSION_IDLE_TIMEOUT_MS) {
        this.saveSession(key);
        session.client.dispose();
        this.sessions.delete(key);
        debugLogger.debug(`Teams: cleaned up idle session ${key}`);
      }
    }
  }
}
