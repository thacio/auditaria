/**
 * @license
 * Copyright 2026 Thacio
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
  getSupportedReasoningEfforts, // AUDITARIA_PROVIDER_EFFORT
  getReasoningEffortDisplay, // AUDITARIA_PROVIDER_EFFORT
  getCodexCatalogModels, // AUDITARIA_CODEX_PROVIDER
  type ProviderReasoningEffort, // AUDITARIA_PROVIDER_EFFORT
} from '@google/gemini-cli-core';

export const CLAUDE_PREFIX = 'claude:';
export const CODEX_PREFIX = 'codex:';
export const COPILOT_PREFIX = 'copilot:'; // AUDITARIA_COPILOT_PROVIDER
export const AGY_PREFIX = 'agy:'; // AUDITARIA_AGY_PROVIDER

export interface ProviderSubmenuOption {
  key: string;
  value: string;
  title: string;
  description: string;
  model?: string;
}

// Descriptions mirror Claude Code's own `/model` picker, kept short. 1M
// context is the default for every current model except Haiku (200K), so
// there is no per-entry context callout and no `[1m]` variants — previously
// persisted `claude-code:*[1m]` selections still parse and run fine (Claude
// accepts or strips the suffix).
export const CLAUDE_SUBMENU_OPTIONS: readonly ProviderSubmenuOption[] = [
  {
    value: `${CLAUDE_PREFIX}auto`,
    title: 'Auto',
    description: "Claude Code's default (your last-selected model)",
    key: 'claude-auto',
  },
  {
    value: `${CLAUDE_PREFIX}opus`,
    title: 'Opus',
    description: 'Best for everyday, complex tasks',
    key: 'claude-opus',
  },
  {
    value: `${CLAUDE_PREFIX}opusplan`,
    title: 'Opus Plan',
    description: 'Opus for planning, Sonnet for execution',
    key: 'claude-opusplan',
  },
  {
    value: `${CLAUDE_PREFIX}sonnet`,
    title: 'Sonnet',
    description: 'Efficient for routine tasks',
    key: 'claude-sonnet',
  },
  {
    value: `${CLAUDE_PREFIX}haiku`,
    title: 'Haiku',
    description: 'Fastest for quick answers',
    key: 'claude-haiku',
  },
  {
    value: `${CLAUDE_PREFIX}fable`,
    title: 'Fable',
    description: 'Most capable for the hardest tasks · needs usage credits',
    key: 'claude-fable',
  },
];

/**
 * Offline fallback for the Codex submenu — a snapshot of the `visibility:
 * "list"` models in Codex's own `models_cache.json`. `getCodexModelOptions()`
 * prefers that file when the user has a Codex install; this is what we show
 * when they don't (or when it can't be read).
 */
export const CODEX_FALLBACK_OPTIONS: readonly ProviderSubmenuOption[] = [
  {
    value: `${CODEX_PREFIX}auto`,
    title: 'Auto',
    description: "Uses Codex's default model",
    key: 'codex-auto',
    model: undefined,
  },
  {
    value: `${CODEX_PREFIX}gpt-5.6-sol`,
    title: 'GPT-5.6 Sol',
    description: 'Reliable agentic workhorse for everyday tasks',
    key: 'codex-gpt56sol',
    model: 'gpt-5.6-sol',
  },
  {
    value: `${CODEX_PREFIX}gpt-5.6-terra`,
    title: 'GPT-5.6 Terra',
    description: 'Balanced agentic coding model for everyday work',
    key: 'codex-gpt56terra',
    model: 'gpt-5.6-terra',
  },
  {
    value: `${CODEX_PREFIX}gpt-5.6-luna`,
    title: 'GPT-5.6 Luna',
    description: 'Fast and affordable agentic coding model',
    key: 'codex-gpt56luna',
    model: 'gpt-5.6-luna',
  },
  {
    value: `${CODEX_PREFIX}gpt-5.5`,
    title: 'GPT-5.5',
    description: 'Proven previous-generation model for coding and general work',
    key: 'codex-gpt55',
    model: 'gpt-5.5',
  },
  {
    value: `${CODEX_PREFIX}gpt-5.4`,
    title: 'GPT-5.4',
    description: 'Strong model for everyday coding',
    key: 'codex-gpt54',
    model: 'gpt-5.4',
  },
  {
    value: `${CODEX_PREFIX}gpt-5.4-mini`,
    title: 'GPT-5.4 Mini',
    description:
      'Small, fast, and cost-efficient model for simpler coding tasks',
    key: 'codex-gpt54mini',
    model: 'gpt-5.4-mini',
  },
];

/**
 * Codex submenu options, read from the Codex CLI's own model catalog so new
 * models appear the moment Codex knows about them (mirrors what
 * `getCopilotModelOptions()` does for Copilot). Falls back to the snapshot
 * above when Codex isn't installed or its cache can't be read.
 */
export function getCodexModelOptions(): ProviderSubmenuOption[] {
  const catalog = getCodexCatalogModels();
  if (!catalog || catalog.length === 0) return [...CODEX_FALLBACK_OPTIONS];

  return [
    {
      value: `${CODEX_PREFIX}auto`,
      title: 'Auto',
      description: "Uses Codex's default model",
      key: 'codex-auto',
      model: undefined,
    },
    ...catalog.map((model) => ({
      value: `${CODEX_PREFIX}${model.slug}`,
      title: model.displayName,
      description: model.description,
      key: `codex-${model.slug.replace(/[^a-z0-9-]/gi, '_')}`,
      model: model.slug,
    })),
  ];
}

// AUDITARIA_AGY_PROVIDER: Google Antigravity (`agy`) model submenu. Each
// variant maps to an agy `--model` display name; Gemini / Claude / GPT-OSS
// families bill against separate Antigravity quota pools.
export const AGY_SUBMENU_OPTIONS: readonly ProviderSubmenuOption[] = [
  {
    value: `${AGY_PREFIX}auto`,
    title: 'Auto',
    description: "Uses Antigravity's selected model (from agy settings)",
    key: 'agy-auto',
    model: undefined,
  },
  {
    value: `${AGY_PREFIX}gemini-3.7-flash-low`,
    title: 'Gemini 3.7 Flash (Low)',
    description: 'Newest Flash · cheapest compute tier · Gemini quota pool',
    key: 'agy-gemini37-flash-low',
    model: 'gemini-3.7-flash-low',
  },
  {
    value: `${AGY_PREFIX}gemini-3.7-flash-medium`,
    title: 'Gemini 3.7 Flash (Medium)',
    description: 'Newest Flash · higher effort · Gemini quota pool',
    key: 'agy-gemini37-flash-medium',
    model: 'gemini-3.7-flash-medium',
  },
  {
    value: `${AGY_PREFIX}gemini-3.7-flash-high`,
    title: 'Gemini 3.7 Flash (High)',
    description: 'Newest Flash · highest effort · Gemini quota pool',
    key: 'agy-gemini37-flash-high',
    model: 'gemini-3.7-flash-high',
  },
  {
    value: `${AGY_PREFIX}gemini-3.6-flash-low`,
    title: 'Gemini 3.6 Flash (Low)',
    description: 'Fast, cheapest compute tier · Gemini quota pool · 1M context',
    key: 'agy-gemini36-flash-low',
    model: 'gemini-3.6-flash-low',
  },
  {
    value: `${AGY_PREFIX}gemini-3.6-flash-medium`,
    title: 'Gemini 3.6 Flash (Medium)',
    description: 'Higher effort · Gemini quota pool · 1M context',
    key: 'agy-gemini36-flash-medium',
    model: 'gemini-3.6-flash-medium',
  },
  {
    value: `${AGY_PREFIX}gemini-3.6-flash-high`,
    title: 'Gemini 3.6 Flash (High)',
    description: 'Highest effort · Gemini quota pool · 1M context',
    key: 'agy-gemini36-flash-high',
    model: 'gemini-3.6-flash-high',
  },
  {
    value: `${AGY_PREFIX}gemini-3.5-flash-low`,
    title: 'Gemini 3.5 Flash (Low)',
    description: 'Fast, cheapest compute tier · Gemini quota pool · 1M context',
    key: 'agy-gemini35-flash-low',
    model: 'gemini-3.5-flash-low',
  },
  {
    value: `${AGY_PREFIX}gemini-3.5-flash-medium`,
    title: 'Gemini 3.5 Flash (Medium)',
    description: 'Higher effort · Gemini quota pool · 1M context',
    key: 'agy-gemini35-flash-medium',
    model: 'gemini-3.5-flash-medium',
  },
  {
    value: `${AGY_PREFIX}gemini-3.5-flash-high`,
    title: 'Gemini 3.5 Flash (High)',
    description: 'Highest effort · Gemini quota pool · 1M context',
    key: 'agy-gemini35-flash-high',
    model: 'gemini-3.5-flash-high',
  },
  {
    value: `${AGY_PREFIX}gemini-3.1-pro-low`,
    title: 'Gemini 3.1 Pro (Low)',
    description: 'Stronger reasoning · Gemini quota pool · 1M context',
    key: 'agy-gemini31-pro-low',
    model: 'gemini-3.1-pro-low',
  },
  {
    value: `${AGY_PREFIX}gemini-3.1-pro-high`,
    title: 'Gemini 3.1 Pro (High)',
    description: 'Strongest Gemini · highest effort · 1M context',
    key: 'agy-gemini31-pro-high',
    model: 'gemini-3.1-pro-high',
  },
  {
    value: `${AGY_PREFIX}claude-sonnet-4.6`,
    title: 'Claude Sonnet 4.6',
    description: 'Anthropic Sonnet (thinking) · separate Claude quota pool',
    key: 'agy-claude-sonnet46',
    model: 'claude-sonnet-4.6',
  },
  {
    value: `${AGY_PREFIX}claude-opus-4.6`,
    title: 'Claude Opus 4.6',
    description: 'Anthropic Opus (thinking) · most capable · Claude quota pool',
    key: 'agy-claude-opus46',
    model: 'claude-opus-4.6',
  },
  {
    value: `${AGY_PREFIX}gpt-oss-120b`,
    title: 'GPT-OSS 120B',
    description: 'Open-weights · separate quota pool · no vision',
    key: 'agy-gpt-oss-120b',
    model: 'gpt-oss-120b',
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

// AUDITARIA_PROVIDER_EFFORT_START: effort vocabulary for the CLI dialog and
// the web model menu. Labels and descriptions come from
// getReasoningEffortDisplay, which carries each provider CLI's OWN wording
// (Claude: bare tokens + ultracode; Codex: tokens + models_cache
// descriptions; Copilot: its TUI labels None…Extra High/Max) so what users
// pick here matches what that CLI shows them.
export function getReasoningEffortLabel(
  effort: ProviderReasoningEffort,
  providerType?: string,
): string {
  return getReasoningEffortDisplay(providerType, effort).label;
}

/** Selectable effort options for a provider (and, for Codex, a model). */
export function getReasoningEffortOptions(
  providerType: string | undefined,
  model?: string,
): Array<{
  value: ProviderReasoningEffort;
  label: string;
  description?: string;
}> {
  return getSupportedReasoningEfforts(providerType, model).map((value) => {
    const display = getReasoningEffortDisplay(providerType, value);
    return {
      value,
      label: display.label,
      description: display.description,
    };
  });
}
// AUDITARIA_PROVIDER_EFFORT_END

// AUDITARIA_COPILOT_PROVIDER_START: Copilot model catalog with dynamic discovery support

import {
  getCachedCopilotModels,
  formatCopilotModelCost,
  refreshCopilotModelsCache,
} from '@google/gemini-cli-core'; // AUDITARIA_COPILOT_PROVIDER

/** Fallback options when copilot is not installed. */
export const COPILOT_FALLBACK_OPTIONS: readonly ProviderSubmenuOption[] = [
  {
    value: `${COPILOT_PREFIX}auto`,
    title: 'Auto',
    description: "Uses Copilot's default model",
    key: 'copilot-auto',
    model: undefined,
  },
];

/**
 * Get Copilot model options for the submenu.
 *
 * Source of truth is `~/.auditaria/copilot-models.json`, written from
 * Copilot's ACP `session/new` model list. On a cold cache we show Auto alone
 * and let the background refresh repopulate the open menu (it emits a
 * model-changed event). There is deliberately no `copilot --help` fallback:
 * as of CLI 1.0.81 that help text no longer lists model ids at all, so the
 * old parse returned nothing while still paying a blocking `execSync` on
 * every menu build.
 */
export function getCopilotModelOptions(): ProviderSubmenuOption[] {
  // Copilot's model line-up moves and the interactive PTY driver only ever
  // reads this cache, so kick a throttled background refresh whenever the
  // menu is built. It emits a model-changed event when the list actually
  // shifted, which repopulates the open menu.
  void refreshCopilotModelsCache();

  const cached = getCachedCopilotModels();
  if (cached.length === 0) return [...COPILOT_FALLBACK_OPTIONS];

  return cached.map((m) => {
    const cost = formatCopilotModelCost(m);
    const desc = cost
      ? `${m.description || m.name} (${cost})`
      : m.description || m.name;
    return {
      value: `${COPILOT_PREFIX}${m.value}`,
      title: m.name,
      description: desc,
      key: `copilot-${m.value.replace(/[^a-z0-9-]/gi, '_')}`,
      model: m.value === 'auto' ? undefined : m.value,
    };
  });
}

/**
 * Build Copilot submenu options from ACP session/new model list.
 * Called after the driver's session/new returns models.availableModels.
 * Includes the relative AI-credits cost in descriptions when available.
 */
export function buildCopilotOptionsFromModels(
  models: ReadonlyArray<{
    value: string;
    name: string;
    description?: string | null;
    copilotUsage?: string | null;
    copilotPriceCategory?: string | null;
  }>,
): ProviderSubmenuOption[] {
  return models.map((m) => {
    const baseDesc = m.description || m.name;
    const cost = formatCopilotModelCost(m);
    const desc = cost ? `${baseDesc} (${cost})` : baseDesc;
    return {
      value: `${COPILOT_PREFIX}${m.value}`,
      title: m.name,
      description: desc,
      key: `copilot-${m.value.replace(/[^a-z0-9-]/gi, '_')}`,
      model: m.value === 'auto' ? undefined : m.value,
    };
  });
}
// AUDITARIA_COPILOT_PROVIDER_END
