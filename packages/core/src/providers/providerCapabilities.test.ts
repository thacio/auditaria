/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { getProviderCapabilities } from './providerCapabilities.js';

describe('conversation ownership', () => {
  it.each([undefined, 'gemini', 'openai-compat:local', 'openai-compat:claude'])(
    'keeps Auditaria context management for API transport %s',
    (type) => {
      expect(getProviderCapabilities(type).contextOwner).toBe('auditaria');
    },
  );
  it.each(['claude-cli', 'codex-cli', 'copilot-cli', 'agy-cli', 'future-cli'])(
    'defers session ownership to external program %s',
    (type) => {
      expect(getProviderCapabilities(type).contextOwner).toBe('provider');
    },
  );
});
