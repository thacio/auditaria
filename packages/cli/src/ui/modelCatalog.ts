/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: Shared model catalog for ModelDialog and web footer model selector.

import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_FLASH_LITE_MODEL,
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_MODEL_AUTO,
  PREVIEW_GEMINI_FLASH_MODEL,
  PREVIEW_GEMINI_MODEL,
  PREVIEW_GEMINI_MODEL_AUTO,
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
  requiresPreview?: boolean;
}

const ALL_GEMINI_WEB_OPTIONS: readonly GeminiWebOption[] = [
  {
    selection: `gemini:${PREVIEW_GEMINI_MODEL_AUTO}`,
    label: 'Gemini (Auto 3)',
    description: 'Automatically routes between Gemini 3 Pro and Gemini 3 Flash',
    requiresPreview: true,
  },
  {
    selection: `gemini:${DEFAULT_GEMINI_MODEL_AUTO}`,
    label: 'Gemini (Auto 2.5)',
    description: 'Automatically routes between Gemini 2.5 Pro and Gemini 2.5 Flash',
  },
  {
    selection: `gemini:${PREVIEW_GEMINI_MODEL}`,
    label: `Gemini (${PREVIEW_GEMINI_MODEL})`,
    description: 'Highest quality Gemini 3 preview model',
    requiresPreview: true,
  },
  {
    selection: `gemini:${PREVIEW_GEMINI_FLASH_MODEL}`,
    label: `Gemini (${PREVIEW_GEMINI_FLASH_MODEL})`,
    description: 'Fast Gemini 3 preview model',
    requiresPreview: true,
  },
  {
    selection: `gemini:${DEFAULT_GEMINI_MODEL}`,
    label: `Gemini (${DEFAULT_GEMINI_MODEL})`,
    description: 'Most capable stable Gemini model',
  },
  {
    selection: `gemini:${DEFAULT_GEMINI_FLASH_MODEL}`,
    label: `Gemini (${DEFAULT_GEMINI_FLASH_MODEL})`,
    description: 'Balanced speed and quality',
  },
  {
    selection: `gemini:${DEFAULT_GEMINI_FLASH_LITE_MODEL}`,
    label: `Gemini (${DEFAULT_GEMINI_FLASH_LITE_MODEL})`,
    description: 'Lowest latency for quick iterations',
  },
];

export function getGeminiWebOptions(
  hasPreviewModels: boolean,
): GeminiWebOption[] {
  return ALL_GEMINI_WEB_OPTIONS.filter(
    (option) => !option.requiresPreview || hasPreviewModels,
  );
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
