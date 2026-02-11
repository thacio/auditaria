/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  clampCodexReasoningEffortForModel,
  getSupportedCodexReasoningEfforts,
} from './types.js';

describe('Codex reasoning effort model constraints', () => {
  it('returns restricted supported efforts for gpt-5.1-codex-mini', () => {
    expect(getSupportedCodexReasoningEfforts('gpt-5.1-codex-mini')).toEqual([
      'low',
      'medium',
      'high',
    ]);
  });

  it('clamps unsupported xhigh to high for gpt-5.1-codex-mini', () => {
    expect(
      clampCodexReasoningEffortForModel('gpt-5.1-codex-mini', 'xhigh'),
    ).toBe('high');
  });

  it('keeps xhigh for gpt-5.2-codex', () => {
    expect(clampCodexReasoningEffortForModel('gpt-5.2-codex', 'xhigh')).toBe(
      'xhigh',
    );
  });

  it('uses default full range for unknown models', () => {
    expect(clampCodexReasoningEffortForModel('unknown-model', 'xhigh')).toBe(
      'xhigh',
    );
  });
});
