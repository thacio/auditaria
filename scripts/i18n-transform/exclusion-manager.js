/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Manages file and pattern exclusions for i18n transformation
 */

import fs from 'node:fs';
import path from 'node:path';
import { minimatch } from 'minimatch';
import { debugLogger } from './debug-logger.js';

export class ExclusionManager {
  constructor() {
    this.patterns = [];
    this.loaded = false;
  }

  loadExclusions() {
    const ignorePath = path.join(process.cwd(), '.i18n-ignore');

    // Default exclusions
    // Note: **/dist/** removed - now handled explicitly in .i18n-ignore
    // to allow packages/core/dist/src/** to be processed
    this.patterns = [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.test.js',
      '**/*.spec.ts',
      '**/*.spec.tsx',
      '**/*.spec.js',
      '**/test/**',
      '**/tests/**',
      '**/mocks/**',
      '**/__mocks__/**',
      '**/node_modules/**',
      '**/build/**',
      '**/bundle/**',
      '**/*.d.ts',
    ];

    // Load custom exclusions from .i18n-ignore file
    if (fs.existsSync(ignorePath)) {
      try {
        const content = fs.readFileSync(ignorePath, 'utf8');
        const customPatterns = content
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'));

        this.patterns.push(...customPatterns);
        debugLogger.debug(
          `Loaded ${customPatterns.length} custom exclusion patterns`,
        );
      } catch (error) {
        debugLogger.warn(`Failed to load .i18n-ignore: ${error.message}`);
      }
    } else {
      debugLogger.debug(
        '.i18n-ignore file not found, using default exclusions',
      );
    }

    this.loaded = true;
    debugLogger.debug(`Total exclusion patterns: ${this.patterns.length}`);
  }

  isExcluded(filePath) {
    if (!this.loaded) {
      this.loadExclusions();
    }

    // Normalize path and convert to forward slashes
    const normalizedPath = path.normalize(filePath).replace(/\\/g, '/');

    // Convert absolute path to relative path for pattern matching
    const cwd = process.cwd().replace(/\\/g, '/');
    let relativePath = normalizedPath;
    if (normalizedPath.startsWith(cwd)) {
      relativePath = normalizedPath.slice(cwd.length).replace(/^\//, '');
    } else {
      // Try to extract relative path from common project structure patterns
      // This handles cases like D:/a/auditaria/auditaria/packages/...
      const projectMatch = normalizedPath.match(/\/packages\//);
      if (projectMatch) {
        relativePath = 'packages/' + normalizedPath.split('/packages/').pop();
      }
    }

    for (const pattern of this.patterns) {
      // Match against both the relative path and the full normalized path
      if (
        minimatch(relativePath, pattern, { matchBase: true }) ||
        minimatch(normalizedPath, pattern, { matchBase: true })
      ) {
        return true;
      }
    }

    return false;
  }

  // Check if a specific line or function should be excluded based on comments
  shouldExcludeLine(line, previousLine = '') {
    const exclusionMarkers = [
      '@i18n-ignore',
      '@i18n-skip',
      'i18n-disable',
      'no-i18n',
    ];

    const combinedText = `${previousLine} ${line}`.toLowerCase();
    return exclusionMarkers.some((marker) => combinedText.includes(marker));
  }

  // Check if we're inside a debug or internal context
  isDebugContext(text) {
    const debugPatterns = [
      /^DEBUG:/i,
      /^\[debug\]/i,
      /^\[internal\]/i,
      /^\[system\]/i,
      /^Error:/,
      /^Warning:/,
      /Stack trace:/i,
    ];

    return debugPatterns.some((pattern) => pattern.test(text));
  }
}
