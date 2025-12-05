/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Error types for browser agent operations
 */
export enum BrowserAgentErrorType {
  BROWSER_NOT_AVAILABLE = 'BROWSER_NOT_AVAILABLE',
  NAVIGATION_FAILED = 'NAVIGATION_FAILED',
  ELEMENT_NOT_FOUND = 'ELEMENT_NOT_FOUND',
  ACTION_TIMEOUT = 'ACTION_TIMEOUT',
  EXTRACTION_FAILED = 'EXTRACTION_FAILED',
  AGENT_STUCK = 'AGENT_STUCK',
  SCREENSHOT_FAILED = 'SCREENSHOT_FAILED',
  CONNECTION_LOST = 'CONNECTION_LOST',
  NOT_INITIALIZED = 'NOT_INITIALIZED',
  INVALID_PARAMS = 'INVALID_PARAMS',
  API_KEY_MISSING = 'API_KEY_MISSING',
}

/**
 * Custom error class for browser agent errors
 */
export class BrowserAgentError extends Error {
  constructor(
    message: string,
    public readonly type: BrowserAgentErrorType,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BrowserAgentError';
  }

  /**
   * Format error for LLM to understand and potentially retry
   */
  toLLMContext(): string {
    const contextStr = this.context
      ? ` Context: ${JSON.stringify(this.context)}`
      : '';
    return `Browser agent error (${this.type}): ${this.message}.${contextStr}`;
  }
}
