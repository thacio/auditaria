/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_OPENAI_COMPAT: Loader for ~/.auditaria/providers.json

import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import type {
  CustomProviderConfig,
  ProvidersFile,
  OpenAICompatDriverConfig,
} from './types.js';
import {
  DEFAULT_COMPLETIONS_PATH,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_READ_TIMEOUT_MS,
} from './types.js';

const PROVIDERS_FILE = 'providers.json';

/**
 * Expands ${ENV_VAR} patterns in a string with process.env values.
 */
function expandEnvVars(value: string): string {
  return value.replace(
    /\$\{(\w+)\}/g,
    (_, name: string) => process.env[name] || '',
  );
}

/**
 * Recursively expands env vars in auth config values.
 */
function expandAuthEnvVars(
  auth: CustomProviderConfig['auth'],
): CustomProviderConfig['auth'] {
  switch (auth.type) {
    case 'bearer':
      return { ...auth, token: expandEnvVars(auth.token) };
    case 'header':
      return { ...auth, value: expandEnvVars(auth.value) };
    case 'none':
      return auth;
  }
}

/**
 * Expands env vars in header values.
 */
function expandHeaderEnvVars(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) return {};
  const expanded: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    expanded[key] = expandEnvVars(value);
  }
  return expanded;
}

/**
 * Loads custom provider configurations from ~/.auditaria/providers.json.
 * Returns empty array if file doesn't exist or is invalid.
 */
export async function loadCustomProviders(): Promise<CustomProviderConfig[]> {
  const filePath = join(homedir(), '.auditaria', PROVIDERS_FILE);

  let data: string;
  try {
    data = await readFile(filePath, 'utf-8');
  } catch {
    return []; // File doesn't exist — no custom providers
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- User config file
    const parsed = JSON.parse(data) as ProvidersFile;
    if (!parsed.providers || !Array.isArray(parsed.providers)) {
      return [];
    }

    // Validate and expand env vars
    return parsed.providers
      .filter(
        (p) =>
          p.id &&
          p.name &&
          p.type === 'openai-compatible' &&
          p.baseUrl &&
          p.auth &&
          Array.isArray(p.models) &&
          p.models.length > 0,
      )
      .map((p) => ({
        ...p,
        auth: expandAuthEnvVars(p.auth),
        headers: expandHeaderEnvVars(p.headers),
      }));
  } catch {
    return []; // Invalid JSON
  }
}

/**
 * Builds a driver config for a specific provider and model selection.
 */
export function buildDriverConfig(
  provider: CustomProviderConfig,
  selectedModel?: string,
): OpenAICompatDriverConfig {
  const model =
    selectedModel ||
    provider.defaultModel ||
    provider.models[0]?.id ||
    'default';
  const modelConfig = provider.models.find((m) => m.id === model);

  return {
    providerId: provider.id,
    providerName: provider.name,
    baseUrl: provider.baseUrl.replace(/\/+$/, ''), // Strip trailing slashes
    completionsPath: provider.completionsPath || DEFAULT_COMPLETIONS_PATH,
    model,
    auth: provider.auth,
    headers: provider.headers || {},
    contextWindow: modelConfig?.contextWindow || DEFAULT_CONTEXT_WINDOW,
    tls: provider.tls,
    timeout: {
      connectMs: provider.timeout?.connectMs || DEFAULT_CONNECT_TIMEOUT_MS,
      readMs: provider.timeout?.readMs || DEFAULT_READ_TIMEOUT_MS,
    },
  };
}

/**
 * Gets the context window for a custom provider model.
 */
export function getCustomProviderContextWindow(
  providers: CustomProviderConfig[],
  providerId: string,
  modelId?: string,
): number {
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) return DEFAULT_CONTEXT_WINDOW;

  const model = modelId
    ? provider.models.find((m) => m.id === modelId)
    : provider.models[0];

  return model?.contextWindow || DEFAULT_CONTEXT_WINDOW;
}
