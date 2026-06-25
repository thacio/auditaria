/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_PROVIDER_ONLY: Pre-send guard that produces an actionable error when
// the active external provider's CLI is missing, or when the user is in
// provider-only mode (no Google account) without any provider active. This runs
// before a message is sent, so every entry point (CLI, web, Telegram, Discord,
// Teams) inherits the same clear guidance instead of a raw ENOENT crash.
//
// It deliberately takes primitives + callbacks (NOT a `Config` instance) to keep
// the providers/ package free of a circular dependency on config.ts.

import {
  checkProviderAvailability,
  getProviderUnavailableMessage,
  getNoProviderActiveMessage,
  type ProviderAvailability,
  type ExternalProviderKey,
} from '../utils/providerAvailability.js';

/** authType string for provider-only mode (mirrors AuthType.PROVIDER_ONLY). */
export const PROVIDER_ONLY_AUTH = 'provider-only';

/**
 * Map a ProviderConfig.type to the availability key used by
 * checkProviderAvailability(). Returns null for Gemini / openai-compat / unknown
 * types, which have no CLI to preflight.
 */
export function providerTypeToAvailabilityKey(
  type: string | undefined,
): ExternalProviderKey | null {
  switch (type) {
    case 'claude-cli':
      return 'claude';
    case 'codex-cli':
      return 'codex';
    case 'copilot-cli':
      return 'copilot';
    case 'agy-cli':
      return 'agy';
    default:
      return null;
  }
}

export interface ProviderPreflightArgs {
  /** providerManager.isExternalProviderActive() */
  isExternalActive: boolean;
  /** config.getProviderConfig()?.type */
  activeProviderType: string | undefined;
  /** config.getContentGeneratorConfig()?.authType */
  authType: string | undefined;
  /** config.getProviderAvailability() */
  getAvailability: () => ProviderAvailability;
  /** config.setProviderAvailability(...) — used to cache a fresh re-check */
  setAvailability: (availability: ProviderAvailability) => void;
}

/**
 * Returns an actionable error message if the send should be blocked, or null if
 * it may proceed.
 *
 * - External provider active but its CLI is not installed → re-check once (the
 *   user may have installed it after launch), then block with install/login
 *   guidance if still missing.
 * - Provider-only mode (no Google account) with no provider active → guide the
 *   user to pick a provider or add a Gemini key.
 * - Everything else (Gemini auth, installed providers, openai-compat) → proceed.
 */
export async function preflightActiveProvider(
  args: ProviderPreflightArgs,
): Promise<string | null> {
  const {
    isExternalActive,
    activeProviderType,
    authType,
    getAvailability,
    setAvailability,
  } = args;

  if (isExternalActive) {
    const key = providerTypeToAvailabilityKey(activeProviderType);
    // Unknown / openai-compat providers have no CLI to preflight — let them run.
    if (!key) return null;

    if (getAvailability()[key]) return null;

    // Availability is a startup-only PATH snapshot. The user may have installed
    // the CLI after launch — re-check once and cache the result before erroring.
    try {
      const fresh = await checkProviderAvailability();
      setAvailability(fresh);
      if (fresh[key]) return null;
    } catch {
      // Ignore re-check failures and fall through to the actionable message.
    }

    return getProviderUnavailableMessage(key);
  }

  // No external provider active. If we are in provider-only mode, the Gemini
  // path has no content generator and would throw a cryptic error — guide the
  // user to choose a provider instead.
  if (authType === PROVIDER_ONLY_AUTH) {
    return getNoProviderActiveMessage();
  }

  return null;
}
