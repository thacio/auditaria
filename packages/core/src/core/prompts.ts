/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { PromptProvider } from '../prompts/promptProvider.js';
import { resolvePathFromEnv as resolvePathFromEnvImpl } from '../prompts/utils.js';
// AUDITARIA: Import SupportedLanguage type for i18n support
import type { SupportedLanguage } from '../i18n/index.js';

/**
 * Resolves a path or switch value from an environment variable.
 * @deprecated Use resolvePathFromEnv from @google/gemini-cli-core/prompts/utils instead.
 */
export function resolvePathFromEnv(envVar?: string) {
  return resolvePathFromEnvImpl(envVar);
}

/**
 * Returns the core system prompt for the agent.
 * AUDITARIA: Added language parameter for i18n support
 */
export function getCoreSystemPrompt(
  config: Config,
  userMemory?: string,
  language?: SupportedLanguage,
  interactiveOverride?: boolean,
): string {
  return new PromptProvider().getCoreSystemPrompt(
    config,
    userMemory,
    language,
    interactiveOverride,
  );
}

/**
 * Provides the system prompt for the history compression process.
 */
export function getCompressionPrompt(): string {
  return new PromptProvider().getCompressionPrompt();
}
