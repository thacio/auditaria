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
  it('returns restricted supported efforts for gpt-5.4-mini', () => {
    expect(getSupportedCodexReasoningEfforts('gpt-5.4-mini')).toEqual([
      'low',
      'medium',
      'high',
    ]);
  });

  it('clamps unsupported xhigh to high for gpt-5.4-mini', () => {
    expect(
      clampCodexReasoningEffortForModel('gpt-5.4-mini', 'xhigh'),
    ).toBe('high');
  });

  it('keeps xhigh for gpt-5.5', () => {
    expect(clampCodexReasoningEffortForModel('gpt-5.5', 'xhigh')).toBe(
      'xhigh',
    );
  });

  it('uses default full range for unknown models', () => {
    expect(clampCodexReasoningEffortForModel('unknown-model', 'xhigh')).toBe(
      'xhigh',
    );
  });
});
