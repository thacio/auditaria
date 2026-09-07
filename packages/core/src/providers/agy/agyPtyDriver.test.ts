/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_AGY_PROVIDER: pure parts of the interactive agy driver and the
 * live model catalog. Turn logic is covered by agyTurnObserver.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  AGY_HOOK_EVENTS,
  buildAgyHooksFile,
  buildAgyPtyArgs,
  classifyAgyScreen,
  quoteFreePath,
} from './agyPtyDriver.js';
import { parseAgyModelsOutput } from './agyModelCatalog.js';

describe('buildAgyPtyArgs', () => {
  it('passes the model, skips permissions, and resumes a known conversation', () => {
    expect(buildAgyPtyArgs({ model: 'gemini-3.6-flash-low' })).toEqual([
      '--model',
      'gemini-3.6-flash-low',
      '--dangerously-skip-permissions',
    ]);
    expect(buildAgyPtyArgs({ model: 'auto', conversationId: 'abc' })).toEqual([
      '--conversation',
      'abc',
      '--dangerously-skip-permissions',
    ]);
  });
});

describe('buildAgyHooksFile', () => {
  it('writes one named hook set with quote-free commands for every observed event', () => {
    const json = JSON.parse(
      buildAgyHooksFile('node', 'C:/x/relay.cjs'),
    ) as Record<string, Record<string, unknown>>;
    const set = json['auditaria-observer'];
    expect(set['enabled']).toBe(true);
    for (const event of AGY_HOOK_EVENTS) {
      const entries = set[event] as Array<{
        type: string;
        command: string;
        timeout: number;
      }>;
      expect(entries[0].type).toBe('command');
      expect(entries[0].command).toBe(`node C:/x/relay.cjs ${event}`);
      expect(entries[0].command.includes('"')).toBe(false);
    }
    expect(set['PreToolUse']).toBeUndefined();
  });
});

describe('quoteFreePath', () => {
  it('returns space-free paths unchanged', () => {
    expect(quoteFreePath('C:/Users/x/.auditaria/agy-hook-relay.cjs')).toBe(
      'C:/Users/x/.auditaria/agy-hook-relay.cjs',
    );
  });
});

describe('classifyAgyScreen', () => {
  const HEADER =
    'Antigravity CLI 1.1.27 user@example.com Gemini 3.6 Flash (Low) ~/wd';
  it('recognises the idle prompt, a running turn, startup and sign-in', () => {
    expect(
      classifyAgyScreen(`${HEADER}\n> ? for shortcuts Gemini 3.6 Flash · low`),
    ).toBe('input');
    expect(
      classifyAgyScreen(
        `${HEADER}\n⣷ Generating... > esc to cancel Gemini 3.6 Flash · low`,
      ),
    ).toBe('working');
    expect(
      classifyAgyScreen(
        `${HEADER}\n○ Bash(node -e "x") (ctrl+o to expand) ⣾ Running command...`,
      ),
    ).toBe('working');
    expect(
      classifyAgyScreen(
        'Welcome to the Antigravity CLI. You are currently not signed in. ⣷ Signing in...',
      ),
    ).toBe('login');
    expect(classifyAgyScreen('Accessing workspace: C:/wd')).toBe('starting');
  });
  it('recognises pickers such as /model', () => {
    expect(
      classifyAgyScreen(
        'Switch Model > Gemini 3.8 Flash Gemini 3.6 Flash(current) ↑/↓ Navigate ←/→ Effort enter Select esc Go Back ? for shortcuts',
      ),
    ).toBe('picker');
  });
});

describe('parseAgyModelsOutput', () => {
  it('parses id and display name per line and skips the banner', () => {
    const out = parseAgyModelsOutput(
      'Fetching available models...\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n',
    );
    expect(out).toEqual([
      { id: 'gemini-3.8-flash-low', displayName: 'Gemini 3.8 Flash (Low)' },
      { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6 (Thinking)' },
    ]);
  });
});
