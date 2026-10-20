/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    reporters: ['default', 'junit'],
    testTimeout: 30000,
    hookTimeout: 30000,
    silent: true,
    outputFile: {
      junit: 'junit.xml',
    },
    coverage: {
      enabled: true,
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*'],
      reporter: [
        ['text', { file: 'full-text-summary.txt' }],
        'html',
        'json',
        'lcov',
        'cobertura',
        ['json-summary', { outputFile: 'coverage-summary.json' }],
      ],
    },
    poolOptions: {
      threads: {
        minThreads: 4,
        maxThreads: 8,
      },
    },
  },
});
