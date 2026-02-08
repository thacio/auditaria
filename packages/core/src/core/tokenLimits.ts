/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_GEMINI_FLASH_LITE_MODEL,
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_MODEL,
  PREVIEW_GEMINI_FLASH_MODEL,
  PREVIEW_GEMINI_MODEL,
} from '../config/models.js';

type Model = string;
type TokenCount = number;

export const DEFAULT_TOKEN_LIMIT = 1_048_576;

export const CLAUDE_TOKEN_LIMIT = 200_000; // AUDITARIA_CLAUDE_PROVIDER

// AUDITARIA_FIX: Include system prompt + tools in token estimation heuristic.
// When true, initial token count includes systemInstruction and tool definitions (Gemini)
// or base overhead like CLAUDE.md + system prompt (Claude), matching API-reported counts.
// Set to false to revert to upstream behavior (history-only estimation).
// Remove this flag entirely if upstream adds proper initial token estimation.
export const SYSTEM_PROMPT_ESTIMATION_FIX = true;

export function tokenLimit(model: Model): TokenCount {
  // AUDITARIA_CLAUDE_PROVIDER: Claude models
  if (model.startsWith('claude-code:')) {
    return CLAUDE_TOKEN_LIMIT;
  }

  // Add other models as they become relevant or if specified by config
  // Pulled from https://ai.google.dev/gemini-api/docs/models
  switch (model) {
    case PREVIEW_GEMINI_MODEL:
    case PREVIEW_GEMINI_FLASH_MODEL:
    case DEFAULT_GEMINI_MODEL:
    case DEFAULT_GEMINI_FLASH_MODEL:
    case DEFAULT_GEMINI_FLASH_LITE_MODEL:
      return 1_048_576;
    default:
      return DEFAULT_TOKEN_LIMIT;
  }
}
