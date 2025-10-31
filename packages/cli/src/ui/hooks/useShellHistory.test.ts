/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { renderHook } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { useShellHistory } from './useShellHistory.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { GEMINI_DIR } from '@thacio/auditaria-cli-core';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));
const mockHomedir = vi.hoisted(() => vi.fn(() => '/tmp/mock-home'));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: mockHomedir,
  };
});
vi.mock('node:crypto');
vi.mock('node:fs', async (importOriginal) => {
  const actualFs = await importOriginal<typeof import('node:fs')>();
  return {
    ...actualFs,
    mkdirSync: vi.fn(),
  };
});
vi.mock('@thacio/auditaria-cli-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@thacio/auditaria-cli-core')>();
  const path = await import('node:path');
  class Storage {
    static getGlobalSettingsPath(): string {
      return '/test/home/.gemini/settings.json';
    }
    getProjectTempDir(): string {
      return path.join('/test/home/', actual.GEMINI_DIR, 'tmp', 'mocked_hash');
    }
    getHistoryFilePath(): string {
      return path.join(
        '/test/home/',
        actual.GEMINI_DIR,
        'tmp',
        'mocked_hash',
        'shell_history',
      );
    }
  }
  return {
    ...actual,
    isNodeError: (err: unknown): err is NodeJS.ErrnoException =>
      typeof err === 'object' && err !== null && 'code' in err,
    Storage,
  };
});

const MOCKED_PROJECT_ROOT = '/test/project';
const MOCKED_HOME_DIR = '/test/home';
const MOCKED_PROJECT_HASH = 'mocked_hash';

const MOCKED_HISTORY_DIR = path.join(
  MOCKED_HOME_DIR,
  GEMINI_DIR,
  'tmp',
  MOCKED_PROJECT_HASH,
);
const MOCKED_HISTORY_FILE = path.join(MOCKED_HISTORY_DIR, 'shell_history');

describe('useShellHistory', () => {
  const mockedFs = vi.mocked(fs);
  const mockedCrypto = vi.mocked(crypto);

  beforeEach(() => {
    vi.resetAllMocks();

    mockedFs.readFile.mockResolvedValue('');
    mockedFs.writeFile.mockResolvedValue(undefined);
    mockedFs.mkdir.mockResolvedValue(undefined);
    mockHomedir.mockReturnValue(MOCKED_HOME_DIR);

    const hashMock = {
      update: vi.fn().mockReturnThis(),
      digest: vi.fn().mockReturnValue(MOCKED_PROJECT_HASH),
    };
    mockedCrypto.createHash.mockReturnValue(hashMock as never);
  });

  it('should initialize and read the history file from the correct path', async () => {
    mockedFs.readFile.mockResolvedValue('cmd1\ncmd2');
    const { result, unmount } = renderHook(() =>
      useShellHistory(MOCKED_PROJECT_ROOT),
    );

    await waitFor(() => {
      expect(mockedFs.readFile).toHaveBeenCalledWith(
        MOCKED_HISTORY_FILE,
        'utf-8',
      );
    });

    let command: string | null = null;
    act(() => {
      command = result.current.getPreviousCommand();
    });

    // History is loaded newest-first: ['cmd2', 'cmd1']
    expect(command).toBe('cmd2');

    unmount();
  });

  it('should handle a nonexistent history file gracefully', async () => {
    const error = new Error('File not found') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    mockedFs.readFile.mockRejectedValue(error);

    const { result, unmount } = renderHook(() =>
      useShellHistory(MOCKED_PROJECT_ROOT),
    );

    await waitFor(() => {
      expect(mockedFs.readFile).toHaveBeenCalled();
    });

    let command: string | null = null;
    act(() => {
      command = result.current.getPreviousCommand();
    });

    expect(command).toBe(null);

    unmount();
  });

  it('should add a command and write to the history file', async () => {
    const { result, unmount } = renderHook(() =>
      useShellHistory(MOCKED_PROJECT_ROOT),
    );

    await waitFor(() => {
      expect(mockedFs.readFile).toHaveBeenCalled();
    });

    act(() => {
      result.current.addCommandToHistory('new_command');
    });

    await waitFor(() => {
      expect(mockedFs.mkdir).toHaveBeenCalledWith(MOCKED_HISTORY_DIR, {
        recursive: true,
      });
      expect(mockedFs.writeFile).toHaveBeenCalledWith(
        MOCKED_HISTORY_FILE,
        'new_command', // Written to file oldest-first.
      );
    });

    let command: string | null = null;
    act(() => {
      command = result.current.getPreviousCommand();
    });
    expect(command).toBe('new_command');

    unmount();
  });

  it('should navigate history correctly with previous/next commands', async () => {
    mockedFs.readFile.mockResolvedValue('cmd1\ncmd2\ncmd3');
    const { result, unmount } = renderHook(() =>
      useShellHistory(MOCKED_PROJECT_ROOT),
    );

    // Wait for history to be loaded: ['cmd3', 'cmd2', 'cmd1']
    await waitFor(() => {
      expect(mockedFs.readFile).toHaveBeenCalled();
    });

    let command: string | null = null;

    act(() => {
      command = result.current.getPreviousCommand();
    });
    expect(command).toBe('cmd3');

    act(() => {
      command = result.current.getPreviousCommand();
    });
    expect(command).toBe('cmd2');

    act(() => {
      command = result.current.getPreviousCommand();
    });
    expect(command).toBe('cmd1');

    // Should stay at the oldest command
    act(() => {
      command = result.current.getPreviousCommand();
    });
    expect(command).toBe('cmd1');

    act(() => {
      command = result.current.getNextCommand();
    });
    expect(command).toBe('cmd2');

    act(() => {
      command = result.current.getNextCommand();
    });
    expect(command).toBe('cmd3');

    // Should return to the "new command" line (represented as empty string)
    act(() => {
      command = result.current.getNextCommand();
    });
    expect(command).toBe('');

    unmount();
  });

  it('should not add empty or whitespace-only commands to history', async () => {
    const { result, unmount } = renderHook(() =>
      useShellHistory(MOCKED_PROJECT_ROOT),
    );

    await waitFor(() => {
      expect(mockedFs.readFile).toHaveBeenCalled();
    });

    act(() => {
      result.current.addCommandToHistory('   ');
    });

    expect(mockedFs.writeFile).not.toHaveBeenCalled();

    unmount();
  });

  it('should truncate history to MAX_HISTORY_LENGTH (100)', async () => {
    const oldCommands = Array.from({ length: 120 }, (_, i) => `old_cmd_${i}`);
    mockedFs.readFile.mockResolvedValue(oldCommands.join('\n'));

    const { result, unmount } = renderHook(() =>
      useShellHistory(MOCKED_PROJECT_ROOT),
    );
    await waitFor(() => {
      expect(mockedFs.readFile).toHaveBeenCalled();
    });

    act(() => {
      result.current.addCommandToHistory('new_cmd');
    });

    // Wait for the async write to happen and then inspect the arguments.
    await waitFor(() => {
      expect(mockedFs.writeFile).toHaveBeenCalled();
    });

    // The hook stores history newest-first.
    // Initial state: ['old_cmd_119', ..., 'old_cmd_0']
    // After adding 'new_cmd': ['new_cmd', 'old_cmd_119', ..., 'old_cmd_21'] (100 items)
    // Written to file (reversed): ['old_cmd_21', ..., 'old_cmd_119', 'new_cmd']
    const writtenContent = mockedFs.writeFile.mock.calls[0][1] as string;
    const writtenLines = writtenContent.split('\n');

    expect(writtenLines.length).toBe(100);
    expect(writtenLines[0]).toBe('old_cmd_21'); // New oldest command
    expect(writtenLines[99]).toBe('new_cmd'); // Newest command

    unmount();
  });

  it('should move an existing command to the top when re-added', async () => {
    mockedFs.readFile.mockResolvedValue('cmd1\ncmd2\ncmd3');
    const { result, unmount } = renderHook(() =>
      useShellHistory(MOCKED_PROJECT_ROOT),
    );

    // Initial state: ['cmd3', 'cmd2', 'cmd1']
    await waitFor(() => {
      expect(mockedFs.readFile).toHaveBeenCalled();
    });

    act(() => {
      result.current.addCommandToHistory('cmd1');
    });

    // After re-adding 'cmd1': ['cmd1', 'cmd3', 'cmd2']
    expect(mockedFs.readFile).toHaveBeenCalled();

    await waitFor(() => {
      expect(mockedFs.writeFile).toHaveBeenCalled();
    });

    const writtenContent = mockedFs.writeFile.mock.calls[0][1] as string;
    const writtenLines = writtenContent.split('\n');

    expect(writtenLines).toEqual(['cmd2', 'cmd3', 'cmd1']);

    unmount();
  });
});
