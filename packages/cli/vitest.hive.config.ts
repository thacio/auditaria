/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_HIVE_FEATURE: Lean vitest config to run the hive suites in
// isolation:  npx vitest run --config vitest.hive.config.ts
//
// The default packages/cli config loads test-setup.ts, which imports
// @google/gemini-cli-core — currently broken under plain ESM by a
// pre-existing core→browser-agent→core circular import ("class extends
// value undefined"). The hive modules under test import no core code, so
// they run fine without that setup.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/services/hive/**/*.test.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
