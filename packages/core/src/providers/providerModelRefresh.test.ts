/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_PROVIDER_AVAILABILITY: Exercise the real executable lookup and
// metadata handshakes with local fixture CLIs, never a user's account.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});
vi.mock('../utils/child-process-tracker.js', () => ({
  trackChildProcess: vi.fn(),
  untrackChildProcess: vi.fn(),
}));

const FIXTURE_CLI = `
const { createInterface } = require('node:readline');
const codex = process.argv[2] === 'app-server';
if (!codex && process.argv[2] !== '--acp') process.exit(1);
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (!request.id) return;
  if (request.id === 2 && process.env.AUDITARIA_TEST_REFRESH_FAILURE) process.exit(1);
  let result = {};
  if (request.id === 2) {
    if (codex) {
      if (request.method !== 'model/list') process.exit(2);
      result = { data: [{ id: 'fixture-codex-model' }] };
    } else {
      if (request.method !== 'session/new') process.exit(2);
      result = { models: {
        currentModelId: 'fixture-copilot-model',
        availableModels: [{ modelId: 'fixture-copilot-model', name: 'Fixture Model',
          _meta: { copilotPriceCategory: 'low' } }]
      } };
    }
  }
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
});
`;

describe.runIf(process.platform === 'win32')(
  'model refresh without Windows shells',
  () => {
    let dir: string;

    beforeEach(() => {
      vi.resetModules();
      dir = mkdtempSync(join(tmpdir(), 'provider metadata '));
      vi.mocked(homedir).mockReturnValue(dir);
      vi.stubEnv('PATH', dir);
      vi.stubEnv('CODEX_EXE', '');
      vi.stubEnv('COMSPEC', join(dir, 'blocked-cmd.exe'));
      vi.stubEnv('AUDITARIA_TEST_REFRESH_FAILURE', '');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    });

    function installFixture(name: string, extension: string) {
      const script = join(dir, `${name}.cjs`);
      writeFileSync(script, FIXTURE_CLI);
      const shim =
        extension === 'cmd'
          ? `@echo off\n"%_prog%" "%dp0%\\${name}.cjs" %*`
          : `& node "$basedir/${name}.cjs" $args`;
      writeFileSync(join(dir, `${name}.${extension}`), shim);
    }

    it.each(['cmd', 'ps1'])(
      'refreshes both model lists through .%s launchers and retains the Copilot cache on failure',
      async (extension) => {
        installFixture('codex', extension);
        installFixture('copilot', extension);
        // Keep persistence isolated from the real user's model cache.
        mkdirSync(join(dir, '.auditaria'));
        const { checkProviderAvailability } = await import(
          '../utils/providerAvailability.js'
        );
        const { refreshCodexModelsCache } = await import(
          './codex/codexModelRefresh.js'
        );
        const { refreshCopilotModelsCache, getCachedCopilotModels } =
          await import('./copilot/copilotCLIDriver.js');

        const availability = await checkProviderAvailability();
        expect(availability.codex).toBe(true);
        expect(availability.copilot).toBe(true);
        expect(await refreshCodexModelsCache(true)).toEqual([
          'fixture-codex-model',
        ]);
        await refreshCopilotModelsCache(true);
        expect(getCachedCopilotModels()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              value: 'fixture-copilot-model',
              copilotPriceCategory: 'low',
            }),
          ]),
        );
        const cachePath = join(dir, '.auditaria', 'copilot-models.json');
        const cache = readFileSync(cachePath, 'utf8');
        expect(cache).toContain('fixture-copilot-model');

        vi.stubEnv('AUDITARIA_TEST_REFRESH_FAILURE', '1');
        await refreshCopilotModelsCache(true);
        expect(readFileSync(cachePath, 'utf8')).toBe(cache);
        expect(await refreshCodexModelsCache(true)).toBeNull();
      },
    );
  },
);
