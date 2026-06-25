/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_PROVIDER_ONLY: tests for the pre-send provider guard.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const checkProviderAvailability = vi.fn();

vi.mock('../utils/providerAvailability.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/providerAvailability.js')>();
  return {
    ...actual,
    checkProviderAvailability: (...args: unknown[]) =>
      checkProviderAvailability(...args),
  };
});

const {
  preflightActiveProvider,
  providerTypeToAvailabilityKey,
  PROVIDER_ONLY_AUTH,
} = await import('./providerPreflight.js');

type Availability = {
  claude: boolean;
  codex: boolean;
  copilot: boolean;
  agy: boolean;
  auditaria: boolean;
};

const allOff = (): Availability => ({
  claude: false,
  codex: false,
  copilot: false,
  agy: false,
  auditaria: true,
});

describe('providerTypeToAvailabilityKey', () => {
  it('maps provider CLI types to availability keys', () => {
    expect(providerTypeToAvailabilityKey('claude-cli')).toBe('claude');
    expect(providerTypeToAvailabilityKey('codex-cli')).toBe('codex');
    expect(providerTypeToAvailabilityKey('copilot-cli')).toBe('copilot');
    expect(providerTypeToAvailabilityKey('agy-cli')).toBe('agy');
  });

  it('returns null for gemini / unknown / openai-compat', () => {
    expect(providerTypeToAvailabilityKey('gemini')).toBeNull();
    expect(providerTypeToAvailabilityKey('openai-compat:foo')).toBeNull();
    expect(providerTypeToAvailabilityKey(undefined)).toBeNull();
  });
});

describe('preflightActiveProvider', () => {
  beforeEach(() => {
    checkProviderAvailability.mockReset();
  });

  it('allows the send when the active provider CLI is installed', async () => {
    const availability = { ...allOff(), claude: true };
    const result = await preflightActiveProvider({
      isExternalActive: true,
      activeProviderType: 'claude-cli',
      authType: PROVIDER_ONLY_AUTH,
      getAvailability: () => availability,
      setAvailability: vi.fn(),
    });
    expect(result).toBeNull();
    expect(checkProviderAvailability).not.toHaveBeenCalled();
  });

  it('blocks with install guidance when the CLI is missing (and recheck still missing)', async () => {
    checkProviderAvailability.mockResolvedValue(allOff());
    const setAvailability = vi.fn();
    const result = await preflightActiveProvider({
      isExternalActive: true,
      activeProviderType: 'claude-cli',
      authType: PROVIDER_ONLY_AUTH,
      getAvailability: () => allOff(),
      setAvailability,
    });
    expect(checkProviderAvailability).toHaveBeenCalledTimes(1);
    expect(setAvailability).toHaveBeenCalledTimes(1);
    expect(result).toContain('Claude Code');
    expect(result).toContain('claude'); // install hint mentions the CLI
  });

  it('recovers when the CLI was installed after launch (recheck flips to available)', async () => {
    checkProviderAvailability.mockResolvedValue({ ...allOff(), codex: true });
    const setAvailability = vi.fn();
    const result = await preflightActiveProvider({
      isExternalActive: true,
      activeProviderType: 'codex-cli',
      authType: PROVIDER_ONLY_AUTH,
      getAvailability: () => allOff(),
      setAvailability,
    });
    expect(checkProviderAvailability).toHaveBeenCalledTimes(1);
    expect(setAvailability).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it('guides the user when in provider-only mode with no provider active', async () => {
    const result = await preflightActiveProvider({
      isExternalActive: false,
      activeProviderType: 'gemini',
      authType: PROVIDER_ONLY_AUTH,
      getAvailability: () => allOff(),
      setAvailability: vi.fn(),
    });
    expect(result).toContain('/model');
    expect(result).toContain('without a Google account');
  });

  it('allows normal Gemini sends (not external, not provider-only)', async () => {
    const result = await preflightActiveProvider({
      isExternalActive: false,
      activeProviderType: 'gemini',
      authType: 'oauth-personal',
      getAvailability: () => allOff(),
      setAvailability: vi.fn(),
    });
    expect(result).toBeNull();
  });

  it('does not preflight openai-compat providers (no CLI)', async () => {
    const result = await preflightActiveProvider({
      isExternalActive: true,
      activeProviderType: 'openai-compat:custom',
      authType: 'gemini-api-key',
      getAvailability: () => allOff(),
      setAvailability: vi.fn(),
    });
    expect(result).toBeNull();
    expect(checkProviderAvailability).not.toHaveBeenCalled();
  });
});
