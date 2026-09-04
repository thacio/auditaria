/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: Lean vitest config to run the web-server suites in
// isolation:  npx vitest run --config vitest.web.config.ts
//
// Same rationale as vitest.hive.config.ts: the default packages/cli config
// loads test-setup.ts, which imports @google/gemini-cli-core — currently
// broken under plain ESM by a pre-existing core→browser-agent→core circular
// import. The transport core under src/services/web imports no core code
// (the logger is injected), so it runs cleanly without that setup.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/services/web/**/*.test.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
