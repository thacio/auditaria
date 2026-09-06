/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_AGENT_SESSION: ONE source for "which model ids does provider X
 * offer right now". The `/model` menu (`cli/src/ui/modelCatalog.ts`) and the
 * `external_agent_session` tool must agree, and both must follow the live
 * sources — Codex's own `models_cache.json`, Copilot's cached ACP model list —
 * instead of hand-maintained tables that drift.
 */

import { AGY_MODEL_IDS, CLAUDE_MODEL_IDS, getCodexModelIds } from './types.js';
import { AUDITARIA_MODEL_IDS } from '../config/models.js';
import { getCachedCopilotModels } from './copilot/copilotCLIDriver.js';

export type ProviderModelKey =
  | 'claude'
  | 'codex'
  | 'copilot'
  | 'agy'
  | 'auditaria';

export const PROVIDER_MODEL_KEYS: readonly ProviderModelKey[] = [
  'claude',
  'codex',
  'copilot',
  'agy',
  'auditaria',
];

/** Model ids the provider offers today, without the shared 'auto' entry. */
export function getProviderModelIds(provider: ProviderModelKey): string[] {
  const notAuto = (ids: readonly string[]) => ids.filter((id) => id !== 'auto');
  switch (provider) {
    case 'claude':
      return notAuto(CLAUDE_MODEL_IDS);
    case 'codex':
      return notAuto(getCodexModelIds());
    case 'copilot':
      return notAuto(getCachedCopilotModels().map((m) => m.value));
    case 'agy':
      return notAuto(AGY_MODEL_IDS);
    case 'auditaria':
      return notAuto(AUDITARIA_MODEL_IDS);
    default:
      return [];
  }
}

/** Every selectable model id across providers, 'auto' first, deduplicated. */
export function getAllProviderModelIds(): string[] {
  const seen = new Set<string>(['auto']);
  const out = ['auto'];
  for (const key of PROVIDER_MODEL_KEYS) {
    for (const id of getProviderModelIds(key)) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

/** Which provider offers `modelId` (first match), for validation messages. */
export function providerOfModelId(
  modelId: string,
): ProviderModelKey | undefined {
  return PROVIDER_MODEL_KEYS.find((key) =>
    getProviderModelIds(key).includes(modelId),
  );
}
