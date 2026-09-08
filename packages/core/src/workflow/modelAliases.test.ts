/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { clampEffort, resolveLeafModel, tierOfAlias } from './modelAliases.js';

describe('modelAliases', () => {
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
      model: 'gemini-3.5-flash-high',
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

  it('hands unknown ids to the provider unchanged', () => {
    expect(resolveLeafModel('gemini', 'not-a-real-model-xyz')).toEqual({
      model: 'not-a-real-model-xyz',
    });
    expect(tierOfAlias('whatever')).toBeUndefined();
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
