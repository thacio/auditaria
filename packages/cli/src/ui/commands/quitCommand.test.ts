/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { quitCommand } from './quitCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { formatDuration } from '../utils/formatters.js';

vi.mock('../utils/formatters.js');

describe('quitCommand', () => {
  it.each(['claude', 'codex'] as const)(
    'prints the correct native resume command for %s',
    (provider) => {
      const context = createMockCommandContext({
        services: {
          agentContext: {
            config: {
              isExternalProviderActive: vi.fn(() => true),
              getProviderConfig: vi.fn(() => ({
                type: `${provider}-cli` as const,
              })),
              getProviderManager: vi.fn(() => ({
                getDriverSessionId: () => 'native-id',
              })),
            },
          },
        },
      });
      const result = quitCommand.action!(context, '');
      expect(result).toMatchObject({
        messages: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining(
              `auditaria --resume-${provider} native-id`,
            ),
          }),
        ]),
      });
    },
  );
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T01:00:00Z'));
    vi.mocked(formatDuration).mockReturnValue('1h 0m 0s');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('returns a QuitActionReturn object with the correct messages', () => {
    const mockContext = createMockCommandContext({
      session: {
        stats: {
          sessionStartTime: new Date('2025-01-01T00:00:00Z'),
        },
      },
    });

    if (!quitCommand.action) throw new Error('Action is not defined');
    const result = quitCommand.action(mockContext, '');

    expect(formatDuration).toHaveBeenCalledWith(3600000); // 1 hour in ms
    expect(result).toEqual({
      type: 'quit',
      deleteSession: false,
      messages: [
        {
          type: 'user',
          text: '/quit',
          id: expect.any(Number),
        },
        {
          type: 'quit',
          duration: '1h 0m 0s',
          id: expect.any(Number),
        },
      ],
    });
  });

  it('sets deleteSession to true when --delete flag is provided', () => {
    const mockContext = createMockCommandContext({
      session: {
        stats: {
          sessionStartTime: new Date('2025-01-01T00:00:00Z'),
        },
      },
    });

    if (!quitCommand.action) throw new Error('Action is not defined');
    const result = quitCommand.action(mockContext, '--delete');

    expect(result).toEqual({
      type: 'quit',
      deleteSession: true,
      messages: [
        {
          type: 'user',
          text: '/quit',
          id: expect.any(Number),
        },
        {
          type: 'quit',
          duration: '1h 0m 0s',
          id: expect.any(Number),
        },
      ],
    });
  });

  it('does not set deleteSession for unrecognized args', () => {
    const mockContext = createMockCommandContext({
      session: {
        stats: {
          sessionStartTime: new Date('2025-01-01T00:00:00Z'),
        },
      },
    });

    if (!quitCommand.action) throw new Error('Action is not defined');
    const result = quitCommand.action(mockContext, 'some-random-arg');

    expect(result).toEqual(
      expect.objectContaining({
        type: 'quit',
        deleteSession: false,
      }),
    );
  });
});
