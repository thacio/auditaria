/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { resumeCommand } from './resumeCommand.js';
import type { CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('resumeCommand', () => {
  it.each(['copilot-cli', 'agy-cli'] as const)(
    'offers native controls for %s without loading a local recording',
    async (type) => {
      const context = createMockCommandContext({
        services: {
          agentContext: { config: { getProviderConfig: () => ({ type }) } },
        },
      });
      expect(await resumeCommand.action!(context, '')).toMatchObject({
        type: 'message',
        content: expect.stringContaining('native session controls'),
      });
      expect(context.ui.loadHistory).not.toHaveBeenCalled();
    },
  );
  it('should open the session browser for bare /resume', async () => {
    const result = await resumeCommand.action?.({} as CommandContext, '');
    expect(result).toEqual({
      type: 'dialog',
      dialog: 'sessionBrowser',
    });
  });

  it('should expose unified chat subcommands directly under /resume', () => {
    const visibleSubCommandNames = (resumeCommand.subCommands ?? [])
      .filter((subCommand) => !subCommand.hidden)
      .map((subCommand) => subCommand.name);

    expect(visibleSubCommandNames).toEqual(
      expect.arrayContaining(['list', 'save', 'resume', 'delete', 'share']),
    );
  });

  it('should keep a hidden /resume checkpoints compatibility alias', () => {
    const checkpoints = resumeCommand.subCommands?.find(
      (subCommand) => subCommand.name === 'checkpoints',
    );
    expect(checkpoints?.hidden).toBe(true);
    expect(
      checkpoints?.subCommands?.map((subCommand) => subCommand.name),
    ).toEqual(
      expect.arrayContaining(['list', 'save', 'resume', 'delete', 'share']),
    );
  });
});
