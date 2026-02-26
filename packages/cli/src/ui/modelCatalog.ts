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
  getCopilotModelUsage, // AUDITARIA_COPILOT_PROVIDER
} from '@google/gemini-cli-core';

export const CLAUDE_PREFIX = 'claude:';
export const CODEX_PREFIX = 'codex:';
export const COPILOT_PREFIX = 'copilot:'; // AUDITARIA_COPILOT_PROVIDER
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

// AUDITARIA_COPILOT_PROVIDER_START: Copilot model catalog with dynamic discovery support

import { execSync } from 'child_process';

/** Fallback options when `copilot --help` parsing fails. */
export const COPILOT_FALLBACK_OPTIONS: readonly ProviderSubmenuOption[] = [
  {
    value: `${COPILOT_PREFIX}auto`,
    title: 'Auto',
    description: "Uses Copilot's default model",
    key: 'copilot-auto',
    model: undefined,
  },
];

/** Cached model IDs from `copilot --help` (not full options — usage enrichment is dynamic). */
let cachedCopilotModelIds: string[] | null = null;

/**
 * Parse available Copilot models from `copilot --help` output.
 * Extracts model IDs from the `--model <model>` choices list.
 * Model ID list is cached; descriptions are enriched dynamically
 * with usage multipliers from the ACP cache (populated after driver init).
 */
export function getCopilotModelOptions(): ProviderSubmenuOption[] {
  // Get model IDs (cached after first parse)
  if (cachedCopilotModelIds === null) {
    try {
      const helpText = execSync('copilot --help', {
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      cachedCopilotModelIds = parseCopilotModelsFromHelp(helpText);
    } catch {
      cachedCopilotModelIds = []; // copilot not installed or --help failed
    }
  }

  if (cachedCopilotModelIds.length === 0) {
    return [...COPILOT_FALLBACK_OPTIONS];
  }

  // Build options with dynamic usage enrichment
  return [
    {
      value: `${COPILOT_PREFIX}auto`,
      title: 'Auto',
      description: "Uses Copilot's default model",
      key: 'copilot-auto',
      model: undefined,
    },
    ...cachedCopilotModelIds.map((modelId) => {
      const usage = getCopilotModelUsage(modelId);
      return {
        value: `${COPILOT_PREFIX}${modelId}`,
        title: formatCopilotModelName(modelId),
        description: usage ? `${modelId} (${usage})` : modelId,
        key: `copilot-${modelId.replace(/[^a-z0-9-]/gi, '_')}`,
        model: modelId,
      };
    }),
  ];
}

/**
 * Extract model IDs from copilot --help output.
 * Looks for `--model <model>` then extracts all quoted strings until the next `--` option.
 */
export function parseCopilotModelsFromHelp(helpText: string): string[] {
  // Find the --model section and grab everything until the next -- option
  const modelSectionMatch = helpText.match(/--model\s+<[^>]+>\s+([\s\S]*?)(?=\n\s+--[a-z])/);
  if (!modelSectionMatch) return [];

  const section = modelSectionMatch[1];
  // Extract all quoted model IDs
  const models: string[] = [];
  const quoteRegex = /"([^"]+)"/g;
  let match;
  while ((match = quoteRegex.exec(section)) !== null) {
    models.push(match[1]);
  }
  return models;
}

/** Convert model ID to a display-friendly name (e.g., 'gpt-5.3-codex' → 'GPT-5.3 Codex'). */
const UPPERCASE_WORDS = new Set(['gpt', 'ai']);
function formatCopilotModelName(modelId: string): string {
  return modelId
    .split('-')
    .map((part) => {
      if (/^\d/.test(part)) return part; // keep version numbers as-is
      if (UPPERCASE_WORDS.has(part.toLowerCase())) return part.toUpperCase();
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ')
    .replace(/\.\s/g, '.'); // fix "4.1" becoming "4. 1"
}

/**
 * Build Copilot submenu options from ACP session/new model list.
 * Called after the driver's session/new returns models.availableModels.
 * Includes copilotUsage multiplier in descriptions when available.
 */
export function buildCopilotOptionsFromModels(
  models: ReadonlyArray<{ value: string; name: string; description?: string | null; copilotUsage?: string | null }>,
): ProviderSubmenuOption[] {
  return models.map((m) => {
    const baseDesc = m.description || m.name;
    const desc = m.copilotUsage ? `${baseDesc} (${m.copilotUsage})` : baseDesc;
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
