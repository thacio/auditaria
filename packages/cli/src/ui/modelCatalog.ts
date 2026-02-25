/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: Shared model catalog for ModelDialog and web footer model selector.

import {
  VALID_GEMINI_MODELS,
  PREVIEW_GEMINI_MODEL_AUTO,
  DEFAULT_GEMINI_MODEL_AUTO,
  isActiveModel,
  isPreviewModel,
  getDisplayString,
  CODEX_REASONING_EFFORTS,
  type CodexReasoningEffort,
} from '@google/gemini-cli-core';

export const CLAUDE_PREFIX = 'claude:';
export const CODEX_PREFIX = 'codex:';
export const DEFAULT_CODEX_REASONING_EFFORT: CodexReasoningEffort = 'xhigh';

export interface ProviderSubmenuOption {
  key: string;
  value: string;
  title: string;
  description: string;
  model?: string;
}

export const CLAUDE_SUBMENU_OPTIONS: readonly ProviderSubmenuOption[] = [
  {
    value: `${CLAUDE_PREFIX}auto`,
    title: 'Auto',
    description: "Uses Claude Code's default model",
    key: 'claude-auto',
  },
  {
    value: `${CLAUDE_PREFIX}opus`,
    title: 'Opus',
    description: 'Most capable model',
    key: 'claude-opus',
  },
  {
    value: `${CLAUDE_PREFIX}sonnet`,
    title: 'Sonnet',
    description: 'Best balance of speed and capability',
    key: 'claude-sonnet',
  },
  {
    value: `${CLAUDE_PREFIX}haiku`,
    title: 'Haiku',
    description: 'Fastest and most compact',
    key: 'claude-haiku',
  },
];

export const CODEX_SUBMENU_OPTIONS: readonly ProviderSubmenuOption[] = [
  {
    value: `${CODEX_PREFIX}auto`,
    title: 'Auto',
    description: "Uses Codex's default model",
    key: 'codex-auto',
    model: undefined,
  },
  {
    value: `${CODEX_PREFIX}gpt-5.3-codex`,
    title: 'GPT-5.3 Codex',
    description: 'Most capable, 258K context',
    key: 'codex-gpt53',
    model: 'gpt-5.3-codex',
  },
  {
    value: `${CODEX_PREFIX}gpt-5.2-codex`,
    title: 'GPT-5.2 Codex',
    description: 'Advanced, 258K context',
    key: 'codex-gpt52',
    model: 'gpt-5.2-codex',
  },
  {
    value: `${CODEX_PREFIX}gpt-5.1-codex-mini`,
    title: 'GPT-5.1 Codex Mini',
    description: 'Fast and compact, 258K context',
    key: 'codex-gpt51mini',
    model: 'gpt-5.1-codex-mini',
  },
];

export interface GeminiWebOption {
  selection: string;
  label: string;
  description: string;
}

/**
 * Derives the Gemini model options for the web menu from the upstream source of truth
 * (VALID_GEMINI_MODELS, isActiveModel, isPreviewModel, getDisplayString).
 *
 * This auto-discovers models — when upstream adds new models to VALID_GEMINI_MODELS
 * and updates isActiveModel(), the web menu picks them up with zero changes here.
 */
export function getGeminiWebOptions(
  hasPreviewModels: boolean,
  useGemini31 = false,
  useCustomToolModel = false,
): GeminiWebOption[] {
  const options: GeminiWebOption[] = [];

  // Auto models first (not in VALID_GEMINI_MODELS, handled separately)
  if (hasPreviewModels) {
    options.push({
      selection: `gemini:${PREVIEW_GEMINI_MODEL_AUTO}`,
      label: `Gemini (${getDisplayString(PREVIEW_GEMINI_MODEL_AUTO)})`,
      description: 'Auto-routes between preview Pro and Flash models',
    });
  }
  options.push({
    selection: `gemini:${DEFAULT_GEMINI_MODEL_AUTO}`,
    label: `Gemini (${getDisplayString(DEFAULT_GEMINI_MODEL_AUTO)})`,
    description: 'Auto-routes between stable Pro and Flash models',
  });

  // Manual models — iterate VALID_GEMINI_MODELS (insertion order: preview first, then stable)
  for (const model of VALID_GEMINI_MODELS) {
    if (!isActiveModel(model, useGemini31, useCustomToolModel)) continue;
    if (isPreviewModel(model) && !hasPreviewModels) continue;

    options.push({
      selection: `gemini:${model}`,
      label: `Gemini (${getDisplayString(model)})`,
      description: deriveModelDescription(model),
    });
  }

  return options;
}

/** Pattern-based description — covers current and future models automatically. */
function deriveModelDescription(model: string): string {
  const preview = isPreviewModel(model);
  const tier = preview ? 'preview' : 'stable';
  if (model.includes('flash-lite')) return `Lowest latency ${tier} model`;
  if (model.includes('flash')) return `Fast ${tier} model`;
  if (model.includes('pro')) return `Highest quality ${tier} model`;
  return model;
}

export const CODEX_REASONING_LABELS: Readonly<
  Record<CodexReasoningEffort, string>
> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
};

export const CODEX_REASONING_OPTIONS = CODEX_REASONING_EFFORTS.map((value) => ({
  value,
  label: CODEX_REASONING_LABELS[value],
}));

export function isCodexReasoningEffort(
  value: unknown,
): value is CodexReasoningEffort {
  return CODEX_REASONING_EFFORTS.includes(value as CodexReasoningEffort);
}

export function getCodexReasoningLabel(effort: CodexReasoningEffort): string {
  return CODEX_REASONING_LABELS[effort] ?? CODEX_REASONING_LABELS.medium;
}
