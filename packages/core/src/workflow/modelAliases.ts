/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: Cross-provider model aliases. A script written for
// Claude Code says `model: 'haiku'` for its cheap bulk workers and
// `model: 'opus'` for its verifier; run under a Gemini, Codex, Copilot or
// agy orchestrator that string must still mean something. Each provider's
// own ids pass through verbatim; a KNOWN alias of another family maps to the
// nearest tier (small / medium / large) of the pinned provider; unknown ids
// are handed to the provider unchanged (a bad id then fails that one agent).

import type { WorkflowProviderFamily } from './types.js';
import { getCodexModelIds } from '../providers/types.js';

export type ModelTier = 'small' | 'medium' | 'large';

const CLAUDE_TIERS: Record<string, ModelTier> = {
  haiku: 'small',
  sonnet: 'medium',
  opus: 'large',
  opusplan: 'large',
  fable: 'large',
};

const GEMINI_TIERS: Record<string, ModelTier> = {
  flash: 'small',
  'flash-lite': 'small',
  pro: 'large',
};

const AGY_TIERS: Record<string, ModelTier> = {
  'gemini-3.5-flash-low': 'small',
  'gemini-3.5-flash-medium': 'small',
  'gemini-3.5-flash-high': 'medium',
  'gemini-3.1-pro-low': 'medium',
  'gemini-3.1-pro-high': 'large',
  'claude-sonnet-4.6': 'medium',
  'claude-opus-4.6': 'large',
};

/** The tier a foreign alias means, or undefined when it is not a known alias. */
export function tierOfAlias(model: string): ModelTier | undefined {
  const key = model.toLowerCase();
  if (CLAUDE_TIERS[key]) return CLAUDE_TIERS[key];
  if (GEMINI_TIERS[key]) return GEMINI_TIERS[key];
  if (AGY_TIERS[key]) return AGY_TIERS[key];
  if (/gemini-.*flash/.test(key)) return 'small';
  if (/gemini-.*pro/.test(key)) return 'large';
  if (/mini|nano/.test(key)) return 'small';
  return undefined;
}

/** Whether `model` is native to `family` (passes through verbatim). */
export function isNativeModel(
  family: WorkflowProviderFamily,
  model: string,
): boolean {
  const key = model.toLowerCase();
  switch (family) {
    case 'claude':
      return key in CLAUDE_TIERS || key.startsWith('claude-');
    case 'gemini':
      return key in GEMINI_TIERS || key.startsWith('gemini-') || key === 'auto';
    case 'codex':
      return (
        key.startsWith('gpt-') ||
        key.startsWith('o') ||
        key === 'auto' ||
        getCodexModelIds().includes(key)
      );
    case 'copilot':
      return key === 'auto';
    case 'agy':
      return key in AGY_TIERS || key === 'auto';
    default:
      return false;
  }
}

/** The pinned provider's representative model for a tier. */
export function modelForTier(
  family: WorkflowProviderFamily,
  tier: ModelTier,
): string | undefined {
  switch (family) {
    case 'claude':
      return tier === 'small' ? 'haiku' : tier === 'medium' ? 'sonnet' : 'opus';
    case 'gemini':
      return tier === 'large' ? 'pro' : 'flash';
    case 'codex': {
      const ids = getCodexModelIds().filter((id) => id !== 'auto');
      if (ids.length === 0) return undefined;
      // The live catalog is newest/strongest first.
      if (tier === 'large') return ids[0];
      const mini = ids.find((id) => /mini|nano/.test(id));
      if (tier === 'small') return mini ?? ids[ids.length - 1];
      return ids[Math.min(1, ids.length - 1)];
    }
    case 'copilot':
      return 'auto';
    case 'agy':
      return tier === 'small'
        ? 'gemini-3.5-flash-low'
        : tier === 'medium'
          ? 'gemini-3.5-flash-high'
          : 'gemini-3.1-pro-high';
    default:
      return undefined;
  }
}

export interface ResolvedModel {
  model: string | undefined;
  /** Present when a foreign alias was mapped (for the `[label] model 'x' mapped to y` log line). */
  mappedFrom?: string;
}

export function resolveLeafModel(
  family: WorkflowProviderFamily,
  requested: string | undefined,
): ResolvedModel {
  if (!requested || requested === 'auto') return { model: undefined };
  if (isNativeModel(family, requested)) return { model: requested };
  const tier = tierOfAlias(requested);
  if (!tier) return { model: requested };
  const mapped = modelForTier(family, tier);
  if (!mapped || mapped === requested) return { model: requested };
  return { model: mapped, mappedFrom: requested };
}

/** Clamp a provider-agnostic effort word to what a family's CLI accepts. */
export function clampEffort(
  family: WorkflowProviderFamily,
  effort: string | undefined,
): string | undefined {
  if (!effort) return undefined;
  const e = effort.toLowerCase();
  switch (family) {
    case 'claude':
      return ['low', 'medium', 'high', 'xhigh', 'max'].includes(e)
        ? e
        : e === 'ultra'
          ? 'max'
          : undefined;
    case 'codex':
      return ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(e)
        ? e
        : undefined;
    case 'copilot':
      return ['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(e)
        ? e
        : e === 'ultra'
          ? 'max'
          : undefined;
    case 'agy':
      return undefined; // agy bakes the tier into its model ids
    case 'gemini':
      return ['low', 'medium', 'high', 'xhigh', 'max'].includes(e)
        ? e
        : undefined;
    default:
      return undefined;
  }
}
