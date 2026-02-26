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

// AUDITARIA_CODEX_PROVIDER: Codex model token limits.
// All GPT-5.x Codex models use 272K context window (400K total minus 128K output reservation).
// Effective usable = 272K * 95% = 258,400 (matches model_context_window from Codex CLI).
// Source: codex-rs/core/src/models_manager/model_info.rs — CONTEXT_WINDOW_272K = 272_000, effective_context_window_percent = 95
export const CODEX_TOKEN_LIMIT = 258_400;

// AUDITARIA_COPILOT_PROVIDER: Conservative default for Copilot models.
// Actual limit varies by underlying model (Claude=200K, GPT-5=200K+, Gemini=1M),
// but we use 200K as a safe floor for token estimation display.
export const COPILOT_TOKEN_LIMIT = 200_000;

// AUDITARIA_FIX: Include system prompt + tools in token estimation heuristic.
// When true, initial token count includes systemInstruction and tool definitions (Gemini)
// or base overhead like CLAUDE.md + system prompt (Claude), matching API-reported counts.
// Set to false to revert to upstream behavior (history-only estimation).
// Remove this flag entirely if upstream adds proper initial token estimation.
export const SYSTEM_PROMPT_ESTIMATION_FIX = true;

export function tokenLimit(model: Model): TokenCount {
  // AUDITARIA_CLAUDE_PROVIDER: Claude models
  if (model?.startsWith('claude-code:')) {
    return CLAUDE_TOKEN_LIMIT;
  }

  // AUDITARIA_CODEX_PROVIDER: Codex models (all use same 258.4K effective context)
  if (model?.startsWith('codex-code:')) {
    return CODEX_TOKEN_LIMIT;
  }

  // AUDITARIA_COPILOT_PROVIDER: Copilot models (conservative default)
  if (model?.startsWith('copilot-code:')) {
    return COPILOT_TOKEN_LIMIT;
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
