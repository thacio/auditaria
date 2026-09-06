/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_COPILOT_PROVIDER: pure parts of the interactive Copilot driver.
 * The turn logic itself is covered by copilotTurnObserver.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  buildCopilotPtyArgs,
  buildCopilotHooksFile,
  classifyCopilotScreen,
  COPILOT_HOOK_EVENTS,
} from './copilotPtyDriver.js';

describe('buildCopilotPtyArgs', () => {
  it('fresh session pre-assigns the id via --session-id', () => {
    const args = buildCopilotPtyArgs({ sessionId: 'abc', resume: false });
    expect(args.slice(0, 2)).toEqual(['--session-id', 'abc']);
    expect(args).toContain('--allow-all');
    expect(args).toContain('--no-auto-update');
  });
  it('respawn resumes via --resume', () => {
    const args = buildCopilotPtyArgs({ sessionId: 'abc', resume: true });
    expect(args.slice(0, 2)).toEqual(['--resume', 'abc']);
  });
  it('passes model, effort, and MCP config; omits model for auto', () => {
    const args = buildCopilotPtyArgs({
      sessionId: 'abc',
      resume: false,
      model: 'gpt-5-mini',
      reasoningEffort: 'low',
      mcpConfigArg: '@C:/x.json',
    });
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5-mini');
    expect(args).toContain('--effort');
    expect(args).toContain('--additional-mcp-config');
    expect(
      buildCopilotPtyArgs({ sessionId: 'a', resume: false, model: 'auto' }),
    ).not.toContain('--model');
  });
});

describe('buildCopilotHooksFile', () => {
  it('relays every observed event through the PowerShell call operator and never installs preToolUse', () => {
    const json = JSON.parse(buildCopilotHooksFile('C:\\tmp\\relay.cjs')) as {
      version: number;
      hooks: Record<
        string,
        Array<{
          type: string;
          bash: string;
          powershell: string;
          timeoutSec: number;
        }>
      >;
    };
    expect(json.version).toBe(1);
    expect(Object.keys(json.hooks).sort()).toEqual(
      [...COPILOT_HOOK_EVENTS].sort(),
    );
    expect(json.hooks['preToolUse']).toBeUndefined();
    const stop = json.hooks['agentStop'][0];
    expect(stop.type).toBe('command');
    expect(stop.powershell.startsWith('& "')).toBe(true);
    expect(stop.powershell).toContain('relay.cjs" agentStop');
    expect(stop.bash).toContain('agentStop');
  });
});

describe('classifyCopilotScreen', () => {
  const FOOTER =
    '← open sidebar · / commands · ? help · tab next tab GPT-5 mini';
  it('recognises the idle input footer, a running turn, and startup loading', () => {
    expect(classifyCopilotScreen(`Tip: /skills\n${FOOTER}`)).toBe('input');
    expect(classifyCopilotScreen(`● Working esc interrupt\n${FOOTER}`)).toBe(
      'working',
    );
    expect(
      classifyCopilotScreen(`● Loading: 12 hooks, 2 skills\n${FOOTER}`),
    ).toBe('starting');
  });
  it('recognises trust and login prompts', () => {
    expect(
      classifyCopilotScreen('Do you trust the files in this folder? (y/n)'),
    ).toBe('trust');
    expect(
      classifyCopilotScreen('You are not logged in. Run /login to sign in'),
    ).toBe('login');
  });
});
