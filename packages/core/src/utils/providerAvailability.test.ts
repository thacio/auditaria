/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { findOnPath } from './resolveExecutable.js';
import { resolveCodexExecutable } from '../providers/codex/codexExecutable.js';
import { checkProviderAvailability } from './providerAvailability.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('./resolveExecutable.js', () => ({ findOnPath: vi.fn() }));
vi.mock('../providers/codex/codexExecutable.js', () => ({
  resolveCodexExecutable: vi.fn(),
}));

describe('checkProviderAvailability', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error('Process execution is blocked');
    });
  });

  it('detects installed providers without starting shells or version probes', async () => {
    vi.mocked(findOnPath).mockImplementation(
      (name) => `/installed/${name}.cmd`,
    );
    vi.mocked(resolveCodexExecutable).mockReturnValue({
      file: '/installed/codex.exe',
      argsPrefix: [],
    });
    expect(await checkProviderAvailability()).toEqual({
      claude: true,
      codex: true,
      copilot: true,
      agy: true,
      auditaria: true,
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports missing commands independently of installed providers', async () => {
    vi.mocked(findOnPath).mockImplementation((name) =>
      name === 'copilot' ? '/installed/copilot.exe' : undefined,
    );
    expect(await checkProviderAvailability()).toEqual({
      claude: false,
      codex: false,
      copilot: true,
      agy: false,
      auditaria: true,
    });
  });

  it('uses the Codex driver resolver even when Codex is absent from PATH', async () => {
    vi.mocked(resolveCodexExecutable).mockReturnValue({
      file: '/custom/codex.exe',
      argsPrefix: [],
    });
    expect((await checkProviderAvailability()).codex).toBe(true);
  });

  it('detects a provider installed after the first check', async () => {
    expect((await checkProviderAvailability()).copilot).toBe(false);
    vi.mocked(findOnPath).mockImplementation((name) =>
      name === 'copilot' ? '/installed/copilot.exe' : undefined,
    );
    expect((await checkProviderAvailability()).copilot).toBe(true);
  });
});
