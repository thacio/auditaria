/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import {
  ULTRACODE_KEYWORD_REMINDER,
  ULTRACODE_OFF_REMINDER,
  ULTRACODE_ON_REMINDER,
  ULTRACODE_STILL_ON_REMINDER,
  applyUltracodeReminders,
  parseBudgetDirective,
} from './ultracode.js';

function fakeConfig(opts: {
  settings?: Record<string, unknown>;
  effort?: string;
  override?: boolean;
}) {
  const service = {
    ultracodeOverride: opts.override,
    ultracodeAnnounced: false,
    turnBudget: undefined as number | undefined,
    setTurnBudget(n: number | undefined) {
      this.turnBudget = n;
    },
  };
  const config = {
    getWorkflowService: () => service,
    getWorkflowSettings: () => opts.settings ?? {},
    getProviderConfig: () =>
      opts.effort
        ? { type: 'claude-cli', options: { reasoningEffort: opts.effort } }
        : undefined,
  } as unknown as Config;
  return { config, service };
}

function textOf(request: unknown): string {
  if (typeof request === 'string') return request;
  return (request as Array<{ text?: string } | string>)
    .map((p) => (typeof p === 'string' ? p : (p.text ?? '')))
    .join('\n');
}

describe('applyUltracodeReminders', () => {
  it('leaves an ordinary turn untouched', () => {
    const { config } = fakeConfig({});
    expect(applyUltracodeReminders(config, 'hello')).toBe('hello');
    expect(applyUltracodeReminders(config, [{ text: 'hello' }])).toEqual([
      { text: 'hello' },
    ]);
  });

  it('adds the keyword reminder for this turn only (word boundary, case-insensitive)', () => {
    const { config } = fakeConfig({});
    const out = textOf(
      applyUltracodeReminders(config, 'ULTRACODE: audit this'),
    );
    expect(out).toContain(
      `<system-reminder>\n${ULTRACODE_KEYWORD_REMINDER}\n</system-reminder>`,
    );
    expect(
      textOf(applyUltracodeReminders(config, 'ultracoder tools')),
    ).not.toContain('system-reminder');
    const { config: off } = fakeConfig({
      settings: { keywordTriggerEnabled: false },
    });
    expect(
      textOf(applyUltracodeReminders(off, 'ultracode please')),
    ).not.toContain('system-reminder');
  });

  it('runs the session state machine: full reminder once, short after, off once', () => {
    const { config, service } = fakeConfig({ override: true });
    expect(textOf(applyUltracodeReminders(config, 'a'))).toContain(
      ULTRACODE_ON_REMINDER,
    );
    expect(textOf(applyUltracodeReminders(config, 'b'))).toContain(
      ULTRACODE_STILL_ON_REMINDER,
    );
    service.ultracodeOverride = false;
    expect(textOf(applyUltracodeReminders(config, 'c'))).toContain(
      ULTRACODE_OFF_REMINDER,
    );
    expect(textOf(applyUltracodeReminders(config, 'd'))).toBe('d');
  });

  it('treats a provider effort of ultra and the settings flag as session mode', () => {
    expect(
      textOf(
        applyUltracodeReminders(fakeConfig({ effort: 'ultra' }).config, 'x'),
      ),
    ).toContain(ULTRACODE_ON_REMINDER);
    expect(
      textOf(
        applyUltracodeReminders(
          fakeConfig({ settings: { ultracode: true } }).config,
          'x',
        ),
      ),
    ).toContain(ULTRACODE_ON_REMINDER);
    expect(
      textOf(
        applyUltracodeReminders(fakeConfig({ effort: 'high' }).config, 'x'),
      ),
    ).toBe('x');
  });

  it('never scans our own notification turns and respects the disabled setting', () => {
    const { config } = fakeConfig({ override: true });
    const notification =
      '[Auditaria background task event — not typed by the user]\n<task-notification>ultracode</task-notification>';
    expect(applyUltracodeReminders(config, notification)).toBe(notification);
    const { config: disabled } = fakeConfig({
      settings: { enabled: false },
      override: true,
    });
    expect(applyUltracodeReminders(disabled, 'ultracode')).toBe('ultracode');
  });

  it('records a +Nk / +Nm budget directive for the next launch', () => {
    const { config, service } = fakeConfig({});
    applyUltracodeReminders(config, 'review this +500k');
    expect(service.turnBudget).toBe(500_000);
    applyUltracodeReminders(config, '+1.5m thorough audit');
    expect(service.turnBudget).toBe(1_500_000);
    expect(parseBudgetDirective('no budget here')).toBeUndefined();
    expect(parseBudgetDirective('x+5k')).toBeUndefined(); // needs a word boundary before +
  });
});
