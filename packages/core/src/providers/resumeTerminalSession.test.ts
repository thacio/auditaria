/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderManager } from './providerManager.js';
import { ClaudeCLIDriver } from './claude/claudeCLIDriver.js';
import { CodexPtyDriver } from './codex/codexPtyDriver.js';
import type { ProviderDriver } from './types.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.each([
  ['claude-cli', ClaudeCLIDriver],
  ['codex-cli', CodexPtyDriver],
] as const)('%s eager resume', (type, Driver) => {
  it('creates the terminal driver with the resumed ID and context, without sending a prompt', async () => {
    vi.stubEnv('AUDITARIA_CODEX_EXEC', '');
    const start = vi
      .spyOn(Driver.prototype, 'startSession')
      .mockResolvedValue();
    const send = vi.spyOn(Driver.prototype, 'sendMessage');
    const manager = new ProviderManager({ type }, '/project');
    const internals = manager as unknown as {
      appConfig: {
        buildExternalProviderContext(): string;
        getAppendSystemPrompt(): string;
        hasGlobalToolDeny(): boolean;
      };
    };
    internals.appConfig = {
      buildExternalProviderContext: () => 'Audit context',
      getAppendSystemPrompt: () => 'User instructions',
      hasGlobalToolDeny: () => false,
    };
    try {
      manager.onHistoryModified();
      manager.setPendingResumeSessionId('native-session');
      await manager.startPendingResumeSession();
      expect(manager.getDriverSessionId()).toBe('native-session');
      expect(start).toHaveBeenCalledWith(
        expect.any(AbortSignal),
        'Audit context\n\nUser instructions',
      );
      expect(send).not.toHaveBeenCalled();
      expect(manager.isTurnActive()).toBe(false);
    } finally {
      manager.dispose();
    }
  });

  it('surfaces startup errors and releases the activity guard for retry', async () => {
    const manager = new ProviderManager({ type }, '/project');
    let finish!: () => void;
    const driver = new Driver({
      cwd: '/project',
      mirrorPty: false,
    });
    const start = vi
      .spyOn(driver, 'startSession')
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        throw new Error('Startup failed');
      })
      .mockResolvedValue(undefined);
    (manager as unknown as { driver: ProviderDriver }).driver = driver;
    try {
      manager.setPendingResumeSessionId('native-session');
      const pending = manager.startPendingResumeSession();
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      expect(manager.isTurnActive()).toBe(true);
      await expect(manager.startPendingResumeSession()).rejects.toThrow(
        'current turn',
      );
      finish();
      await expect(pending).rejects.toThrow('Startup failed');
      expect(manager.isTurnActive()).toBe(false);
      await manager.startPendingResumeSession();
      expect(start).toHaveBeenCalledTimes(2);
    } finally {
      manager.dispose();
    }
  });

  it('starts the existing readiness/observer path and forwards its errors', async () => {
    const driver = new Driver({ cwd: '/project', mirrorPty: false });
    const internals = driver as unknown as {
      ensurePtySpawned(signal: AbortSignal): Promise<string | null>;
      ensureSpawned(signal: AbortSignal): Promise<string | null>;
      lastSystemContext?: string;
    };
    const ready = vi
      .spyOn(
        internals,
        type === 'claude-cli' ? 'ensurePtySpawned' : 'ensureSpawned',
      )
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('Not ready');
    try {
      const signal = new AbortController().signal;
      await driver.startSession(signal, 'Audit context');
      expect(ready).toHaveBeenCalledWith(signal);
      expect(internals.lastSystemContext).toBe('Audit context');
      await expect(driver.startSession(signal)).rejects.toThrow('Not ready');
      await expect(driver.startSession(AbortSignal.abort())).rejects.toThrow();
      expect(ready).toHaveBeenCalledTimes(2);
    } finally {
      driver.dispose();
    }
  });
});

it('keeps headless Codex resume lazy', async () => {
  vi.stubEnv('AUDITARIA_CODEX_EXEC', '1');
  const manager = new ProviderManager({ type: 'codex-cli' }, '/project');
  try {
    manager.setPendingResumeSessionId('native-session');
    await manager.startPendingResumeSession();
    expect(manager.getDriverSessionId()).toBe('native-session');
    expect(manager.supportsRecovery()).toBe(false);
  } finally {
    manager.dispose();
  }
});

it('detaches the old Claude PTY immediately when switching sessions', () => {
  const driver = new ClaudeCLIDriver({ cwd: '/project', mirrorPty: false });
  const kill = vi.fn();
  const internals = driver as unknown as {
    activePty: unknown;
    ptyExited: boolean;
    sessionStarted: boolean;
  };
  driver.setSessionId('old');
  internals.activePty = { kill, pid: 0 };
  internals.ptyExited = false;
  internals.sessionStarted = true;
  try {
    driver.setSessionId('new');
    expect(kill).toHaveBeenCalledOnce();
    expect(internals.activePty).toBeNull();
    expect(driver.getStatus().ptyAlive).toBe(false);
    expect(driver.getSessionId()).toBe('new');
  } finally {
    driver.dispose();
  }
});
