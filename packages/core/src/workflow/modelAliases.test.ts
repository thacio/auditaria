/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clampEffort, resolveLeafModel, tierOfAlias } from './modelAliases.js';
import { getProviderModelIds } from '../providers/providerModelIds.js';

vi.mock('../providers/providerModelIds.js', () => ({
  getProviderModelIds: vi.fn(),
}));

describe('modelAliases', () => {
  beforeEach(() => {
    vi.mocked(getProviderModelIds).mockImplementation((family) =>
      family === 'agy'
        ? [
            'gemini-3.7-flash-low',
            'gemini-3.8-flash-medium',
            'gemini-3.8-flash-high',
            'gemini-3.1-pro-low',
            'gemini-3.1-pro-high',
            'gemini-3.8-flash-low',
            'claude-sonnet-4.6',
          ]
        : ['claude-sonnet-4.6', 'gpt-5.4'],
    );
  });

  it('passes native ids through and leaves auto/undefined alone', () => {
    expect(resolveLeafModel('claude', 'haiku')).toEqual({ model: 'haiku' });
    expect(resolveLeafModel('claude', 'claude-opus-4-1')).toEqual({
      model: 'claude-opus-4-1',
    });
    expect(resolveLeafModel('gemini', 'gemini-2.5-pro')).toEqual({
      model: 'gemini-2.5-pro',
    });
    expect(resolveLeafModel('codex', 'auto')).toEqual({ model: undefined });
    expect(resolveLeafModel('agy', undefined)).toEqual({ model: undefined });
    expect(resolveLeafModel('agy', 'gemini-3.8-flash-low')).toEqual({
      model: 'gemini-3.8-flash-low',
    });
    expect(resolveLeafModel('copilot', 'claude-sonnet-4.6')).toEqual({
      model: 'claude-sonnet-4.6',
    });
  });

  it("maps Claude aliases to the pinned provider's tier and records the mapping", () => {
    expect(resolveLeafModel('gemini', 'haiku')).toEqual({
      model: 'flash',
      mappedFrom: 'haiku',
    });
    expect(resolveLeafModel('gemini', 'opus')).toEqual({
      model: 'pro',
      mappedFrom: 'opus',
    });
    expect(resolveLeafModel('agy', 'sonnet')).toEqual({
      model: 'gemini-3.8-flash-high',
      mappedFrom: 'sonnet',
    });
    expect(resolveLeafModel('copilot', 'haiku')).toEqual({
      model: 'auto',
      mappedFrom: 'haiku',
    });
    expect(resolveLeafModel('claude', 'flash')).toEqual({
      model: 'haiku',
      mappedFrom: 'flash',
    });
    expect(resolveLeafModel('claude', 'gemini-2.5-pro')).toEqual({
      model: 'opus',
      mappedFrom: 'gemini-2.5-pro',
    });
  });

  it('maps aliases to available model tiers as provider versions change', () => {
    expect(resolveLeafModel('agy', 'haiku')).toEqual({
      model: 'gemini-3.8-flash-low',
      mappedFrom: 'haiku',
    });
    expect(resolveLeafModel('agy', 'opus')).toEqual({
      model: 'gemini-3.1-pro-high',
      mappedFrom: 'opus',
    });
    vi.mocked(getProviderModelIds).mockReturnValue([
      'gemini-3.9-flash-high',
      'gemini-3.10-flash-high',
    ]);
    expect(resolveLeafModel('agy', 'sonnet')).toEqual({
      model: 'gemini-3.10-flash-high',
      mappedFrom: 'sonnet',
    });
  });

  it('hands unknown ids to the provider unchanged', () => {
    expect(resolveLeafModel('gemini', 'not-a-real-model-xyz')).toEqual({
      model: 'not-a-real-model-xyz',
    });
    expect(tierOfAlias('whatever')).toBeUndefined();
    expect(resolveLeafModel('agy', 'Gemini 3.8 Flash (Low)')).toEqual({
      model: 'Gemini 3.8 Flash (Low)',
    });
    expect(resolveLeafModel('agy', 'Gemini 4 Argon (High)')).toEqual({
      model: 'Gemini 4 Argon (High)',
    });
    expect(tierOfAlias('gpt-5.4-mini')).toBe('small');
    expect(tierOfAlias('Gemini 4 Argon (High)')).toBeUndefined();
  });

  it('clamps effort per family', () => {
    expect(clampEffort('claude', 'ultra')).toBe('max');
    expect(clampEffort('claude', 'gigantic')).toBeUndefined();
    expect(clampEffort('codex', 'ultra')).toBe('ultra');
    expect(clampEffort('copilot', 'none')).toBe('none');
    expect(clampEffort('agy', 'high')).toBeUndefined();
    expect(clampEffort('gemini', undefined)).toBeUndefined();
  });
});
