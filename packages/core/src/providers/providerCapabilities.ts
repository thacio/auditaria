/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA: Conversation ownership is independent of the model vendor.
export interface ProviderCapabilities {
  name: string;
  contextOwner: 'auditaria' | 'provider';
  nativeCompact: boolean;
  nativeSessionBrowser?: 'claude' | 'codex';
}

const externalProviders: Record<string, ProviderCapabilities> = {
  'claude-cli': {
    name: 'Claude Code',
    contextOwner: 'provider',
    nativeCompact: true,
    nativeSessionBrowser: 'claude',
  },
  'codex-cli': {
    name: 'Codex',
    contextOwner: 'provider',
    nativeCompact: true,
    nativeSessionBrowser: 'codex',
  },
  'copilot-cli': {
    name: 'GitHub Copilot',
    contextOwner: 'provider',
    nativeCompact: true,
  },
  'agy-cli': {
    name: 'Antigravity',
    contextOwner: 'provider',
    nativeCompact: false,
  },
};

const localCapabilities: ProviderCapabilities = {
  name: 'Auditaria',
  contextOwner: 'auditaria',
  nativeCompact: false,
};

export function getProviderCapabilities(type?: string): ProviderCapabilities {
  if (!type || type === 'gemini' || type.startsWith('openai-compat:')) {
    return localCapabilities;
  }
  return (
    externalProviders[type] ?? {
      name: type,
      contextOwner: 'provider',
      nativeCompact: false,
    }
  );
}
