/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { tokenLimit, DEFAULT_TOKEN_LIMIT } from './tokenLimits.js';
import {
  DEFAULT_GEMINI_FLASH_LITE_MODEL,
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_MODEL,
  PREVIEW_GEMINI_FLASH_MODEL,
  PREVIEW_GEMINI_MODEL,
} from '../config/models.js';

describe('tokenLimit', () => {
  it('should return the correct token limit for default models', () => {
    expect(tokenLimit(DEFAULT_GEMINI_MODEL)).toBe(1_048_576);
    expect(tokenLimit(DEFAULT_GEMINI_FLASH_MODEL)).toBe(1_048_576);
    expect(tokenLimit(DEFAULT_GEMINI_FLASH_LITE_MODEL)).toBe(1_048_576);
  });

  it('should return the correct token limit for preview models', () => {
    expect(tokenLimit(PREVIEW_GEMINI_MODEL)).toBe(1_048_576);
    expect(tokenLimit(PREVIEW_GEMINI_FLASH_MODEL)).toBe(1_048_576);
  });

  it('should return the default token limit for an unknown model', () => {
    expect(tokenLimit('unknown-model')).toBe(DEFAULT_TOKEN_LIMIT);
  });

  it('should return the default token limit if no model is provided', () => {
    // @ts-expect-error testing invalid input
    expect(tokenLimit(undefined)).toBe(DEFAULT_TOKEN_LIMIT);
  });

  it('should have the correct default token limit value', () => {
    expect(DEFAULT_TOKEN_LIMIT).toBe(1_048_576);
  });

  // AUDITARIA_CLAUDE_PROVIDER: 1M is Claude Code's default context window
  // (2.1.x); only Haiku stays at 200K. The [1m] variants force what is
  // already the default elsewhere, so they resolve to the same limit.
  it('gives Claude Code models the 1M default, Haiku 200K', () => {
    expect(tokenLimit('claude-code:opus')).toBe(1_000_000);
    expect(tokenLimit('claude-code:sonnet')).toBe(1_000_000);
    expect(tokenLimit('claude-code:fable')).toBe(1_000_000);
    expect(tokenLimit('claude-code:auto')).toBe(1_000_000);
    expect(tokenLimit('claude-code:opus[1m]')).toBe(1_000_000);
    expect(tokenLimit('claude-code:opusplan[1m]')).toBe(1_000_000);
    expect(tokenLimit('claude-code:haiku')).toBe(200_000);
  });

  // AUDITARIA_AGY_PROVIDER: Antigravity's Claude models are not Claude Code —
  // they keep the 200K window.
  it('keeps agy Claude models at 200K', () => {
    expect(tokenLimit('agy-code:claude-sonnet-4.6')).toBe(200_000);
    expect(tokenLimit('agy-code:claude-opus-4.6')).toBe(200_000);
  });
});
