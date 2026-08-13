/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  clampCodexReasoningEffortForModel,
  getSupportedCodexReasoningEfforts,
  clampReasoningEffortForProvider,
  getSupportedReasoningEfforts,
  providerSupportsReasoningEffort,
  isProviderReasoningEffort,
} from './types.js';

describe('Codex reasoning effort model constraints', () => {
  it('returns restricted supported efforts for gpt-5.5 (no max/ultra)', () => {
    expect(getSupportedCodexReasoningEfforts('gpt-5.5')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  });

  it('clamps unsupported ultra to xhigh for gpt-5.4-mini', () => {
    expect(clampCodexReasoningEffortForModel('gpt-5.4-mini', 'ultra')).toBe(
      'xhigh',
    );
  });

  it('clamps ultra to max for gpt-5.6-luna', () => {
    expect(clampCodexReasoningEffortForModel('gpt-5.6-luna', 'ultra')).toBe(
      'max',
    );
  });

  it('keeps ultra for gpt-5.6-sol', () => {
    expect(clampCodexReasoningEffortForModel('gpt-5.6-sol', 'ultra')).toBe(
      'ultra',
    );
  });

  it('keeps xhigh for gpt-5.5', () => {
    expect(clampCodexReasoningEffortForModel('gpt-5.5', 'xhigh')).toBe('xhigh');
  });

  it('uses default full range for unknown models', () => {
    expect(clampCodexReasoningEffortForModel('unknown-model', 'xhigh')).toBe(
      'xhigh',
    );
  });
});

// AUDITARIA_PROVIDER_EFFORT
describe('provider-agnostic reasoning effort', () => {
  it('recognises only providers whose CLI accepts --effort', () => {
    expect(providerSupportsReasoningEffort('claude-cli')).toBe(true);
    expect(providerSupportsReasoningEffort('codex-cli')).toBe(true);
    expect(providerSupportsReasoningEffort('copilot-cli')).toBe(true);
    // agy rejects --effort for every model in its catalog (the tier is baked
    // into the model name, e.g. "Gemini 3.7 Flash (High)").
    expect(providerSupportsReasoningEffort('agy-cli')).toBe(false);
    expect(providerSupportsReasoningEffort('gemini')).toBe(false);
    expect(providerSupportsReasoningEffort(undefined)).toBe(false);
  });

  it('exposes each CLI documented range', () => {
    expect(getSupportedReasoningEfforts('claude-cli')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(getSupportedReasoningEfforts('copilot-cli')).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(getSupportedReasoningEfforts('agy-cli')).toEqual([]);
  });

  it('delegates to the per-model Codex table', () => {
    expect(getSupportedReasoningEfforts('codex-cli', 'gpt-5.5')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  });

  it('clamps into the provider range', () => {
    // Claude has no `ultra`.
    expect(
      clampReasoningEffortForProvider('claude-cli', undefined, 'ultra'),
    ).toBe('max');
    // Copilot's `none`/`minimal` are below every other provider's floor.
    expect(
      clampReasoningEffortForProvider('claude-cli', undefined, 'none'),
    ).toBe('low');
    expect(
      clampReasoningEffortForProvider('copilot-cli', undefined, 'none'),
    ).toBe('none');
    expect(
      clampReasoningEffortForProvider('copilot-cli', undefined, 'ultra'),
    ).toBe('max');
  });

  it('leaves the effort untouched for providers without a control', () => {
    expect(clampReasoningEffortForProvider('agy-cli', undefined, 'high')).toBe(
      'high',
    );
  });

  it('validates effort strings', () => {
    expect(isProviderReasoningEffort('minimal')).toBe(true);
    expect(isProviderReasoningEffort('ultra')).toBe(true);
    expect(isProviderReasoningEffort('turbo')).toBe(false);
    expect(isProviderReasoningEffort(undefined)).toBe(false);
  });
});
