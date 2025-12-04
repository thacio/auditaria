/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session Manager for Browser Agent
 *
 * Manages multiple concurrent browser sessions with:
 * - Named sessions (AI can specify sessionId)
 * - Smart defaults (auto-select when 0-1 sessions)
 * - Race condition protection (per-session init Promises)
 * - Process cleanup hooks (SIGINT, SIGTERM)
 */

import { StagehandAdapter } from './stagehand-adapter.js';
import { BrowserAgentError, BrowserAgentErrorType } from './errors.js';
import type { BrowserAgentModel } from './types.js';
import { logger } from './logger.js';

/**
 * Configuration for creating a browser session
 */
export interface SessionConfig {
  /** Optional session identifier. If not provided, uses smart resolution */
  sessionId?: string;

  // Credentials (from CredentialBridge)
  apiKey?: string;
  authClient?: import('google-auth-library').AuthClient;
  project?: string;
  location?: string;

  // Stagehand options
  model: BrowserAgentModel;
  headless?: boolean;
  verbose?: boolean;
}

/**
 * Session lifecycle states
 */
export enum SessionState {
  IDLE = 'idle',
  INITIALIZING = 'initializing',
  READY = 'ready',
  RUNNING = 'running',
  PAUSED = 'paused',
  STOPPING = 'stopping',
  TAKING_OVER = 'taking_over',
  TAKEN_OVER = 'taken_over',
  ENDING_TAKEOVER = 'ending_takeover',
  CLOSING = 'closing',
  ERROR = 'error',
}

/**
 * Public session information
 */
export interface SessionInfo {
  sessionId: string;
  state: SessionState;
  createdAt: Date;
  headless: boolean;
}

/**
 * Internal session entry with adapter and init promise
 */
interface SessionEntry {
  adapter: StagehandAdapter | null;
  state: SessionState;
  config: SessionConfig;
  createdAt: Date;
  initPromise: Promise<StagehandAdapter> | null;

  // Execution control for pause/resume/stop
  pausePromise: Promise<void> | null;
  pauseResolver: (() => void) | null;
  abortController: AbortController | null;
}

/**
 * SessionManager - Manages multiple concurrent browser sessions
 *
 * Features:
 * - Up to MAX_SESSIONS concurrent browser sessions
 * - Named sessions with AI-friendly identifiers
 * - Smart resolution when sessionId not provided
 * - Per-session race condition protection
 * - Process exit cleanup hooks
 */
export class SessionManager {
  private static instance: SessionManager | null = null;
  private static readonly MAX_SESSIONS = 5;
  private static readonly DEFAULT_SESSION_ID = 'default';

  private sessions: Map<string, SessionEntry> = new Map();
  private cleanupRegistered = false;

  /**
   * Private constructor - use getInstance()
   */
  private constructor() {}

  /**
   * Get the singleton SessionManager instance
   */
  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  /**
   * Reset the singleton instance (for testing)
   */
  static resetInstance(): void {
    if (SessionManager.instance) {
      // Close all sessions synchronously (best effort)
      SessionManager.instance.sessions.clear();
    }
    SessionManager.instance = null;
  }

  // ─────────────────────────────────────────────────────────────────
  // Core Operations
  // ─────────────────────────────────────────────────────────────────

  /**
   * Get or create a browser session
   *
   * Smart resolution when sessionId not provided:
   * - 0 sessions: Creates with DEFAULT_SESSION_ID
   * - 1 session: Returns that session
   * - 2+ sessions: Throws error (ambiguous)
   *
   * @param config Session configuration including optional sessionId
   * @returns The StagehandAdapter for the session
   */
  async getOrCreateSession(config: SessionConfig): Promise<StagehandAdapter> {
    // Register cleanup hooks on first use
    this.registerCleanupHooks();

    let sessionId = config.sessionId;

    // Smart resolution if no sessionId provided
    if (!sessionId) {
      if (this.sessions.size === 0) {
        // No sessions exist - create default
        sessionId = SessionManager.DEFAULT_SESSION_ID;
      } else if (this.sessions.size === 1) {
        // Exactly one session - use it
        sessionId = this.sessions.keys().next().value!;
      } else {
        // Multiple sessions - ambiguous, require explicit ID
        const activeIds = this.getSessionIds().join(', ');
        throw new BrowserAgentError(
          `Multiple browser sessions active (${activeIds}). ` +
            `Please specify sessionId to identify which session to use.`,
          BrowserAgentErrorType.INVALID_PARAMS,
        );
      }
    }

    return this.getOrCreateSessionById(sessionId, config);
  }

  /**
   * Get or create a session by explicit ID
   */
  private async getOrCreateSessionById(
    sessionId: string,
    config: SessionConfig,
  ): Promise<StagehandAdapter> {
    let entry = this.sessions.get(sessionId);

    // If session exists and ready, return it
    if (entry?.adapter && entry.state === SessionState.READY) {
      this.warnIfConfigMismatch(entry.config, config, sessionId);
      return entry.adapter;
    }

    // If session is initializing, wait for it
    if (entry?.initPromise) {
      return entry.initPromise;
    }

    // Check max sessions limit before creating new
    if (!entry && this.sessions.size >= SessionManager.MAX_SESSIONS) {
      const activeIds = this.getSessionIds().join(', ');
      throw new BrowserAgentError(
        `Maximum ${SessionManager.MAX_SESSIONS} concurrent sessions allowed. ` +
          `Close a session before creating a new one. Active: ${activeIds}`,
        BrowserAgentErrorType.INVALID_PARAMS,
      );
    }

    // Create new session entry
    if (!entry) {
      entry = {
        adapter: null,
        state: SessionState.IDLE,
        config: { ...config, sessionId },
        createdAt: new Date(),
        initPromise: null,
        pausePromise: null,
        pauseResolver: null,
        abortController: null,
      };
      this.sessions.set(sessionId, entry);
    }

    // Start initialization with Promise-based lock
    entry.state = SessionState.INITIALIZING;
    entry.initPromise = this.doInit(sessionId, config);

    try {
      entry.adapter = await entry.initPromise;
      entry.state = SessionState.READY;
      return entry.adapter;
    } catch (error) {
      entry.state = SessionState.ERROR;
      this.sessions.delete(sessionId); // Clean up failed session
      throw error;
    } finally {
      entry.initPromise = null;
    }
  }

  /**
   * Perform actual initialization
   */
  private async doInit(
    sessionId: string,
    config: SessionConfig,
  ): Promise<StagehandAdapter> {
    const adapter = new StagehandAdapter({
      apiKey: config.apiKey,
      authClient: config.authClient,
      project: config.project,
      location: config.location,
      model: config.model,
      headless: config.headless,
      verbose: config.verbose,
    });

    await adapter.init();
    return adapter;
  }

  /**
   * Warn if config differs from existing session
   */
  private warnIfConfigMismatch(
    existing: SessionConfig,
    requested: SessionConfig,
    sessionId: string,
  ): void {
    if (existing.headless !== requested.headless && requested.headless !== undefined) {
      logger.warn(
        `[SessionManager] Session "${sessionId}" already running with headless=${existing.headless}. ` +
          `Ignoring requested headless=${requested.headless}. Use a different sessionId for different settings.`,
      );
    }
  }

  /**
   * Close a specific session or the only active session
   *
   * @param sessionId Session to close. If not provided:
   *   - 0 sessions: Returns silently
   *   - 1 session: Closes that session
   *   - 2+ sessions: Throws error (ambiguous)
   */
  async closeSession(sessionId?: string): Promise<void> {
    // Smart resolution if no sessionId
    if (!sessionId) {
      if (this.sessions.size === 0) {
        return; // Nothing to close
      } else if (this.sessions.size === 1) {
        sessionId = this.sessions.keys().next().value!;
      } else {
        const activeIds = this.getSessionIds().join(', ');
        throw new BrowserAgentError(
          `Multiple sessions active (${activeIds}). ` +
            `Specify sessionId or use closeAllSessions().`,
          BrowserAgentErrorType.INVALID_PARAMS,
        );
      }
    }

    const entry = this.sessions.get(sessionId);
    if (!entry) return; // Session doesn't exist, idempotent

    // Wait for init if in progress
    if (entry.initPromise) {
      try {
        await entry.initPromise;
      } catch {
        // Init failed, proceed to cleanup
      }
    }

    entry.state = SessionState.CLOSING;

    if (entry.adapter) {
      try {
        await entry.adapter.close();
      } catch (error) {
        logger.warn(`[SessionManager] Error closing session "${sessionId}":`, error);
      }
    }

    this.sessions.delete(sessionId);
  }

  /**
   * Close all active sessions
   */
  async closeAllSessions(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());

    // Close all in parallel (best effort)
    await Promise.all(
      sessionIds.map((id) =>
        this.closeSession(id).catch((error) => {
          logger.warn(`[SessionManager] Error closing session "${id}":`, error);
        }),
      ),
    );
  }

  // ─────────────────────────────────────────────────────────────────
  // Query Methods
  // ─────────────────────────────────────────────────────────────────

  /**
   * Get all active session IDs
   */
  getSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Get count of active sessions
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get state of a specific session
   */
  getSessionState(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId)?.state;
  }

  /**
   * Check if a session exists
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Get info about a specific session
   */
  getSessionInfo(sessionId: string): SessionInfo | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;

    return {
      sessionId,
      state: entry.state,
      createdAt: entry.createdAt,
      headless: entry.config.headless ?? false,  // Default to headed mode (with takeover support)
    };
  }

  /**
   * Get info about all sessions
   */
  getAllSessionInfo(): SessionInfo[] {
    return this.getSessionIds().map((id) => this.getSessionInfo(id)!);
  }

  /**
   * Get the Stagehand Page for a session (for streaming)
   * Returns null if session doesn't exist or isn't ready
   *
   * Note: Returns Stagehand's Page object which has CDP support
   * via getSessionForFrame() and sendCDP() methods.
   */
  async getPage(sessionId: string): Promise<import('./streaming/types.js').StagehandPage | null> {
    const entry = this.sessions.get(sessionId);
    // Allow getPage during READY, RUNNING, and PAUSED states (for streaming)
    if (!entry?.adapter || (entry.state !== SessionState.READY && entry.state !== SessionState.RUNNING && entry.state !== SessionState.PAUSED)) {
      return null;
    }
    // StagehandAdapter.getPage() returns stagehand.context.pages()[0]
    // which is a Stagehand Page, not a Playwright Page
    return entry.adapter.getPage() as unknown as import('./streaming/types.js').StagehandPage;
  }

  // ─────────────────────────────────────────────────────────────────
  // Execution Control (Pause/Resume/Stop)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Pause agent execution for a session
   * Next step will block until resumed
   */
  pauseExecution(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.state !== SessionState.RUNNING) {
      logger.warn(`[SessionManager] Cannot pause session "${sessionId}" - not running (state: ${entry?.state || 'not found'})`);
      return;
    }

    entry.state = SessionState.PAUSED;
    entry.pausePromise = new Promise<void>((resolve) => {
      entry.pauseResolver = resolve;
    });

    logger.debug(`[SessionManager] Paused execution for session "${sessionId}"`);
  }

  /**
   * Resume agent execution for a session
   * Releases the pause Promise, allowing next step to proceed
   */
  resumeExecution(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.state !== SessionState.PAUSED) {
      logger.warn(`[SessionManager] Cannot resume session "${sessionId}" - not paused (state: ${entry?.state || 'not found'})`);
      return;
    }

    entry.state = SessionState.RUNNING;
    if (entry.pauseResolver) {
      entry.pauseResolver();
      entry.pausePromise = null;
      entry.pauseResolver = null;
    }

    logger.debug(`[SessionManager] Resumed execution for session "${sessionId}"`);
  }

  /**
   * Stop agent execution for a session
   * Aborts current execution gracefully
   */
  stopExecution(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || (entry.state !== SessionState.RUNNING && entry.state !== SessionState.PAUSED)) {
      logger.warn(`[SessionManager] Cannot stop session "${sessionId}" - not executing (state: ${entry?.state || 'not found'})`);
      return;
    }

    entry.state = SessionState.STOPPING;

    // If paused, resume to allow loop to exit
    if (entry.pauseResolver) {
      entry.pauseResolver();
      entry.pausePromise = null;
      entry.pauseResolver = null;
    }

    // Abort via AbortController if available
    if (entry.abortController) {
      entry.abortController.abort(new Error('Stopped by user'));
    }

    logger.debug(`[SessionManager] Stopped execution for session "${sessionId}"`);
  }

  /**
   * Check if execution should pause
   * Called by agent loop at step boundaries
   * Blocks (async) until resumed if paused
   * @returns true if stop was requested, false otherwise
   */
  async checkPauseState(sessionId: string): Promise<boolean> {
    let entry = this.sessions.get(sessionId);
    if (!entry) return false;

    // Check if stop was requested
    if (entry.state === SessionState.STOPPING) {
      return true; // Signal to exit loop
    }

    // Also block during takeover states (not just PAUSED)
    // If paused, taking over, or taken over, block until resumed
    if ((entry.state === SessionState.PAUSED || entry.state === SessionState.TAKING_OVER || entry.state === SessionState.TAKEN_OVER || entry.state === SessionState.ENDING_TAKEOVER) && entry.pausePromise) {
      logger.debug(`[SessionManager] Agent paused at step boundary for session "${sessionId}" (state: ${entry.state})`);
      await entry.pausePromise;
      // Re-fetch entry after await - state may have changed to STOPPING during pause
      entry = this.sessions.get(sessionId);
      if (!entry) return false;
    }

    return entry.state === SessionState.STOPPING; // Return true if stop requested during pause
  }

  /**
   * Mark session as running (agent task started)
   */
  setRunning(sessionId: string, abortController: AbortController): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.state = SessionState.RUNNING;
      entry.abortController = abortController;
    }
  }

  /**
   * Mark session as ready (agent task completed)
   */
  setReady(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      entry.state = SessionState.READY;
      entry.abortController = null;
      entry.pausePromise = null;
      entry.pauseResolver = null;
    }
  }

  /**
   * Take over a session - pause and switch to headful (visible) mode
   * Allows user to manually interact with the browser
   *
   * Process:
   * 1. Pause agent execution (if running)
   * 2. Save current browser state
   * 3. Close headless browser
   * 4. Reopen browser in headful mode
   * 5. Restore saved state
   * 6. Transition to TAKEN_OVER state
   *
   * @param sessionId - Session to take over
   * @throws if session not found or not in valid state
   */
  async takeOverSession(sessionId: string): Promise<void> {
    logger.debug(`[SessionManager] ====== takeOverSession called for "${sessionId}" ======`);

    const entry = this.sessions.get(sessionId);
    if (!entry) {
      logger.error(`[SessionManager] Session "${sessionId}" not found!`);
      throw new BrowserAgentError(
        `Session "${sessionId}" not found`,
        BrowserAgentErrorType.INVALID_PARAMS,
      );
    }

    logger.debug(`[SessionManager] Current session state: ${entry.state}`);
    logger.debug(`[SessionManager] Current headless: ${entry.config.headless}`);

    // Check valid state (RUNNING, PAUSED, or already TAKEN_OVER)
    if (entry.state === SessionState.TAKEN_OVER) {
      // Already taken over - idempotent
      logger.debug(`[SessionManager] Session "${sessionId}" already taken over - returning`);
      return;
    }

    if (entry.state !== SessionState.RUNNING && entry.state !== SessionState.PAUSED) {
      logger.error(`[SessionManager] Invalid state for takeover: ${entry.state}`);
      throw new BrowserAgentError(
        `Cannot take over session "${sessionId}" in state ${entry.state}. Must be RUNNING or PAUSED.`,
        BrowserAgentErrorType.INVALID_PARAMS,
      );
    }

    logger.debug(`[SessionManager] Taking over session "${sessionId}"...`);

    try {
      // Use CDP to show window instead of restarting browser
      // This keeps the agent task alive and streaming active

      // Step 1: Show browser window (bring to front)
      logger.debug(`[SessionManager] Showing browser window...`);
      await entry.adapter!.showWindow();

      // Step 2: Set up pause promise to block agent execution during takeover
      // This ensures the agent waits for the user to end takeover before continuing
      entry.pausePromise = new Promise<void>((resolve) => {
        entry.pauseResolver = resolve;
      });
      logger.debug(`[SessionManager] Pause promise set up for takeover`);

      // Step 3: Transition to TAKEN_OVER
      entry.state = SessionState.TAKEN_OVER;
      logger.debug(`[SessionManager] ====== TAKEOVER COMPLETE for session "${sessionId}" ======`);
      logger.debug(`[SessionManager] Browser window is now visible, agent execution paused`);

    } catch (error) {
      logger.error(`[SessionManager] ====== TAKEOVER FAILED for session "${sessionId}" ======`);
      logger.error(`[SessionManager] Error:`, error);
      logger.error(`[SessionManager] Stack:`, error instanceof Error ? error.stack : 'No stack');
      entry.state = SessionState.ERROR;
      throw new BrowserAgentError(
        `Failed to take over session: ${error instanceof Error ? error.message : String(error)}`,
        BrowserAgentErrorType.BROWSER_NOT_AVAILABLE,
      );
    }
  }

  /**
   * End takeover - switch back to headless mode and resume agent execution
   *
   * Process:
   * 1. Save current browser state
   * 2. Close headful browser
   * 3. Reopen browser in headless mode (using original preference)
   * 4. Restore saved state
   * 5. Resume agent execution
   *
   * @param sessionId - Session to release from takeover
   * @throws if session not found or not in TAKEN_OVER state
   */
  async endTakeOver(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new BrowserAgentError(
        `Session "${sessionId}" not found`,
        BrowserAgentErrorType.INVALID_PARAMS,
      );
    }

    if (entry.state !== SessionState.TAKEN_OVER) {
      throw new BrowserAgentError(
        `Cannot end takeover for session "${sessionId}" in state ${entry.state}. Must be TAKEN_OVER.`,
        BrowserAgentErrorType.INVALID_PARAMS,
      );
    }

    logger.debug(`[SessionManager] Ending takeover for session "${sessionId}"...`);

    try {
      // Use CDP to minimize window instead of restarting browser
      // This keeps the agent task alive and streaming active

      // Step 1: Minimize browser window (hide it again)
      logger.debug(`[SessionManager] Minimizing browser window...`);
      await entry.adapter!.minimizeWindow();

      // Step 2: Transition back to RUNNING and auto-resume if paused
      entry.state = SessionState.RUNNING;

      // Auto-resume execution if there's a pause promise
      // This ensures the agent continues automatically after takeover ends
      if (entry.pauseResolver) {
        logger.debug(`[SessionManager] Auto-resuming agent execution after takeover...`);
        entry.pauseResolver();
        entry.pausePromise = null;
        entry.pauseResolver = null;
      }

      logger.debug(`[SessionManager] Takeover ended for session "${sessionId}". Browser window minimized, agent continues.`);

    } catch (error) {
      logger.error(`[SessionManager] End takeover failed for session "${sessionId}":`, error);
      entry.state = SessionState.ERROR;
      throw new BrowserAgentError(
        `Failed to end takeover: ${error instanceof Error ? error.message : String(error)}`,
        BrowserAgentErrorType.BROWSER_NOT_AVAILABLE,
      );
    }
  }


  /**
   * Register process cleanup hooks (SIGINT, SIGTERM)
   * Called automatically on first getOrCreateSession()
   */
  registerCleanupHooks(): void {
    if (this.cleanupRegistered) return;

    const cleanup = async (signal: string) => {
      if (this.sessions.size > 0) {
        logger.debug(`\n[SessionManager] Received ${signal}, closing ${this.sessions.size} browser session(s)...`);
        await this.closeAllSessions();
      }
      process.exit(0);
    };

    // Handle Ctrl+C
    process.on('SIGINT', () => cleanup('SIGINT'));

    // Handle termination signal
    process.on('SIGTERM', () => cleanup('SIGTERM'));

    // beforeExit allows async operations (unlike 'exit')
    process.on('beforeExit', async () => {
      if (this.sessions.size > 0) {
        await this.closeAllSessions();
      }
    });

    this.cleanupRegistered = true;
  }
}
