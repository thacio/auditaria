/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clampCodexReasoningEffortForModel,
  getSupportedCodexReasoningEfforts,
  clampReasoningEffortForProvider,
  getSupportedReasoningEfforts,
  providerSupportsReasoningEffort,
  isProviderReasoningEffort,
  getReasoningEffortDisplay,
} from './types.js';
import { resetCodexCatalogCache } from './codex/codexModelCatalog.js';

// AUDITARIA_CODEX_PROVIDER: the Codex effort tables are now a FALLBACK behind
// the user's own `$CODEX_HOME/models_cache.json`. Point CODEX_HOME at an empty
// directory so these tests exercise the fallback deterministically, on a dev
// machine with a real Codex install as much as on CI without one.
let emptyCodexHome: string;
const originalCodexHome = process.env['CODEX_HOME'];

beforeEach(() => {
  emptyCodexHome = mkdtempSync(join(tmpdir(), 'codex-no-cache-'));
  process.env['CODEX_HOME'] = emptyCodexHome;
  resetCodexCatalogCache();
});

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env['CODEX_HOME'];
  else process.env['CODEX_HOME'] = originalCodexHome;
  resetCodexCatalogCache();
  rmSync(emptyCodexHome, { recursive: true, force: true });
});

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
    // `ultra` is Claude's ultracode (session-scoped, delivered via
    // --settings; the --effort flag itself only accepts low..max).
    expect(getSupportedReasoningEfforts('claude-cli')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    // No 'minimal': the flag's --help advertises it, but Copilot's app
    // bundle has no such level, label, or description.
    expect(getSupportedReasoningEfforts('copilot-cli')).toEqual([
      'none',
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
    // Copilot's `none` is below every other provider's floor.
    expect(
      clampReasoningEffortForProvider('claude-cli', undefined, 'none'),
    ).toBe('low');
    expect(
      clampReasoningEffortForProvider('copilot-cli', undefined, 'none'),
    ).toBe('none');
    // Copilot tops out at max; Claude's ultra (ultracode) is in range.
    expect(
      clampReasoningEffortForProvider('copilot-cli', undefined, 'ultra'),
    ).toBe('max');
    expect(
      clampReasoningEffortForProvider('claude-cli', undefined, 'ultra'),
    ).toBe('ultra');
    // Codex per-model: Luna has no ultra tier.
    expect(
      clampReasoningEffortForProvider('codex-cli', 'gpt-5.6-luna', 'ultra'),
    ).toBe('max');
  });

  it('leaves the effort untouched for providers without a control', () => {
    expect(clampReasoningEffortForProvider('agy-cli', undefined, 'high')).toBe(
      'high',
    );
  });

  it('validates effort strings', () => {
    expect(isProviderReasoningEffort('ultra')).toBe(true);
    expect(isProviderReasoningEffort('minimal')).toBe(false);
    expect(isProviderReasoningEffort('turbo')).toBe(false);
    expect(isProviderReasoningEffort(undefined)).toBe(false);
  });

  it("uses each CLI's own vocabulary for display", () => {
    // Claude: bare tokens; ultra surfaces as Claude's own "ultracode".
    expect(getReasoningEffortDisplay('claude-cli', 'xhigh').label).toBe(
      'xhigh',
    );
    expect(getReasoningEffortDisplay('claude-cli', 'ultra').label).toBe(
      'ultracode',
    );
    // Copilot: its TUI labels.
    expect(getReasoningEffortDisplay('copilot-cli', 'xhigh').label).toBe(
      'Extra High',
    );
    expect(getReasoningEffortDisplay('copilot-cli', 'none')).toEqual({
      label: 'None',
      description: 'No model thinking',
    });
    // Codex: tokens + the models_cache.json descriptions.
    expect(getReasoningEffortDisplay('codex-cli', 'ultra')).toEqual({
      label: 'ultra',
      description: 'Maximum reasoning with automatic task delegation',
    });
    // Unknown provider falls back to the bare token.
    expect(getReasoningEffortDisplay('agy-cli', 'high')).toEqual({
      label: 'high',
    });
  });
});
