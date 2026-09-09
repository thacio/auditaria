/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_PROVIDER_AVAILABILITY: Utility to check if external LLM providers are installed

import { findOnPath } from './resolveExecutable.js';
import { resolveCodexExecutable } from '../providers/codex/codexExecutable.js';

export interface ProviderAvailability {
  claude: boolean;
  codex: boolean;
  copilot: boolean; // AUDITARIA_COPILOT_PROVIDER
  agy: boolean; // AUDITARIA_AGY_PROVIDER
  auditaria: boolean;
}

/**
 * Discover installed provider commands using the same lookup as the drivers.
 * This is installation detection, not a health/authentication check: a blocked
 * shell, slow cold start, or failed --version must not hide installed providers.
 * No processes are started. Actual launch errors are reported by the drivers.
 * @returns Promise that resolves to an object with availability status for each provider
 */
export async function checkProviderAvailability(): Promise<ProviderAvailability> {
  return {
    claude: findOnPath('claude') !== undefined,
    codex: resolveCodexExecutable() !== undefined,
    copilot: findOnPath('copilot') !== undefined,
    agy: findOnPath('agy') !== undefined,
    auditaria: true,
  };
}

export type ExternalProviderKey = 'claude' | 'codex' | 'copilot' | 'agy';

/**
 * Get user-friendly install message for a provider
 * @param provider Provider name ('claude' or 'codex')
 * @returns Install instruction message
 */
export function getProviderInstallMessage(
  provider: ExternalProviderKey,
): string {
  if (provider === 'claude') {
    return 'To use Claude Code, install it from https://docs.anthropic.com/en/docs/claude-code, then run `claude` to authenticate.';
  }
  if (provider === 'codex') {
    return 'To use OpenAI Codex, install it from https://www.npmjs.com/package/@openai/codex, then run `codex` to authenticate.';
  }
  // AUDITARIA_COPILOT_PROVIDER
  if (provider === 'copilot') {
    return 'To use GitHub Copilot, install it from https://www.npmjs.com/package/@github/copilot, then run `copilot` to authenticate.';
  }
  // AUDITARIA_AGY_PROVIDER
  if (provider === 'agy') {
    return 'To use Google Antigravity, install the Antigravity CLI so `agy` is on your PATH, then run `agy` once to authenticate.';
  }
  return 'Provider not available. Please install and authenticate.';
}

// AUDITARIA_PROVIDER_ONLY_START: Shared, DRY user-facing copy for provider-only
// mode and the Google-OAuth discontinuation. Reused by the auth dialog, the
// send-time preflight error, and the dead-OAuth migration nudge so the wording
// stays consistent everywhere.

/** Human-readable display name for an external provider. */
export function getProviderDisplayName(provider: ExternalProviderKey): string {
  switch (provider) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'OpenAI Codex';
    case 'copilot':
      return 'GitHub Copilot';
    case 'agy':
      return 'Google Antigravity';
    default:
      return 'Provider';
  }
}

/** Short one-line description of each provider (for menus / discovery). */
export function getProviderTagline(provider: ExternalProviderKey): string {
  switch (provider) {
    case 'claude':
      return 'Anthropic — Opus / Sonnet / Haiku (claude CLI)';
    case 'codex':
      return 'OpenAI — GPT-5.x Codex (codex CLI)';
    case 'copilot':
      return 'GitHub Copilot (copilot CLI)';
    case 'agy':
      return 'Google Antigravity — Gemini 3, Claude, GPT-OSS (agy CLI)';
    default:
      return '';
  }
}

/**
 * Message shown when the active external provider's CLI is not installed /
 * not on PATH at send time.
 */
export function getProviderUnavailableMessage(
  provider: ExternalProviderKey,
): string {
  return (
    `${getProviderDisplayName(provider)} is the active provider, but its command-line tool ` +
    `was not found on your PATH.\n\n` +
    `${getProviderInstallMessage(provider)}\n\n` +
    `Already installed? Make sure you have run it once to sign in. ` +
    `Or switch provider / add a Gemini API key or Vertex AI with /model and /auth.`
  );
}

/**
 * Message shown when the user is in provider-only mode (no Google account) but
 * no AI provider is active yet.
 */
export function getNoProviderActiveMessage(): string {
  return (
    `You are running Auditaria without a Google account, but no AI provider is active yet.\n\n` +
    `Run /model to choose Claude Code, OpenAI Codex, GitHub Copilot, or Google Antigravity — ` +
    `or /auth to add a Gemini API key or Vertex AI.`
  );
}

/**
 * Description for the "Skip Google sign-in" auth option — points the user to the
 * external providers they can use instead, with live install status when known.
 */
export function getSkipLoginDescription(availability?: {
  claude: boolean;
  codex: boolean;
  copilot: boolean;
  agy: boolean;
}): string {
  const keys: ExternalProviderKey[] = ['claude', 'codex', 'copilot', 'agy'];
  const lines = keys.map((k) => {
    const status = availability
      ? availability[k]
        ? ' [installed]'
        : ' [not installed]'
      : '';
    return `  • ${getProviderTagline(k)}${status}`;
  });
  return (
    'Use Auditaria without a Google account. After continuing, pick your AI ' +
    'provider with /model:\n' +
    lines.join('\n') +
    '\n\nInstall the one you want and run it once to sign in, then choose it ' +
    'with /model. You can also add a Gemini API key or Vertex AI with /auth.'
  );
}

/**
 * Note explaining that "Sign in with Google" no longer serves consumer Gemini
 * subscriptions, and what the alternatives are. Shown in the auth dialog and
 * appended to dead-OAuth send errors.
 */
export function getGoogleOAuthDiscontinuedNote(): string {
  return (
    `Heads up: "Sign in with Google" no longer serves model output for consumer Gemini ` +
    `subscriptions (Google AI Pro, AI Ultra, and free "Gemini Code Assist for individuals") ` +
    `since 2026-06-18. It still works for Gemini Code Assist Standard/Enterprise licenses.\n\n` +
    `If your Google sign-in stopped working, use a Gemini API key or Vertex AI instead, or ` +
    `switch to an external provider (Claude Code, OpenAI Codex, GitHub Copilot, or Google Antigravity).`
  );
}
// AUDITARIA_PROVIDER_ONLY_END
