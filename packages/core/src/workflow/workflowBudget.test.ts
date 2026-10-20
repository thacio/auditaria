/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  parseBudgetDirective,
  recordWorkflowBudget,
} from './workflowBudget.js';

function fakeConfig(enabled = true) {
  const setTurnBudget = vi.fn();
  return {
    setTurnBudget,
    config: {
      getWorkflowSettings: () => ({ enabled }),
      getWorkflowService: () => ({ setTurnBudget }),
    } as unknown as Config,
  };
}

afterEach(() => vi.unstubAllEnvs());

describe('workflow output-token targets', () => {
  it.each([
    ['review this +500k', 500_000],
    ['+1.5m thorough audit', 1_500_000],
    ['use a workflow +2M', 2_000_000],
    ['no target', undefined],
    ['x+5k', undefined],
    ['+0k', undefined],
    ['+-5k', undefined],
  ])('parses %s', (text, expected) => {
    expect(parseBudgetDirective(text)).toBe(expected);
  });

  it('records a target without modifying text or attachment parts', () => {
    const { config, setTurnBudget } = fakeConfig();
    const request = [
      { text: 'use a workflow +500k' },
      { inlineData: { mimeType: 'image/png', data: 'fixture' } },
    ];
    const original = structuredClone(request);
    recordWorkflowBudget(config, request);
    expect(setTurnBudget).toHaveBeenCalledWith(500_000);
    expect(request).toEqual(original);
  });

  it('ignores ordinary messages and background notifications', () => {
    const { config, setTurnBudget } = fakeConfig();
    recordWorkflowBudget(config, 'review the code');
    recordWorkflowBudget(
      config,
      '[Auditaria background task event]\n<task-notification>+500k</task-notification>',
    );
    expect(setTurnBudget).not.toHaveBeenCalled();
  });

  it('respects the workflow setting and environment switch', () => {
    const disabled = fakeConfig(false);
    recordWorkflowBudget(disabled.config, '+500k');
    expect(disabled.setTurnBudget).not.toHaveBeenCalled();

    vi.stubEnv('AUDITARIA_DISABLE_WORKFLOW', '1');
    const enabled = fakeConfig();
    recordWorkflowBudget(enabled.config, '+500k');
    expect(enabled.setTurnBudget).not.toHaveBeenCalled();
  });
});
