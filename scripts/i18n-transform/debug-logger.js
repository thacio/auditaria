/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Debug logger for i18n transformation
 * Provides colored console output and debug mode support
 */

class DebugLogger {
  constructor() {
    this.debugMode = false;
    this.prefix = '[i18n-transform]';
  }

  setDebugMode(enabled) {
    this.debugMode = enabled;
  }

  // Info level - always shown
  info(message) {
    console.log(`${this.prefix} ${message}`);
  }

  // Debug level - only shown in debug mode
  debug(message) {
    if (this.debugMode) {
      console.log(`${this.prefix} [DEBUG] ${message}`);
    }
  }

  // Warning level - always shown
  warn(message) {
    console.warn(`${this.prefix} [WARN] ${message}`);
  }

  // Error level - always shown
  error(message) {
    console.error(`${this.prefix} [ERROR] ${message}`);
  }

  // Success message - always shown in green
  success(message) {
    console.log(`${this.prefix} ✓ ${message}`);
  }
}

export const debugLogger = new DebugLogger();
