/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ClaudeCLIDriver } from './claudeCLIDriver.js';
import { ProviderScreenMirror } from '../terminal/screenMirror.js';

describe('Claude startup trust dialog', () => {
  it('follows a cursor-only redraw before confirming the selected option', async () => {
    const driver = new ClaudeCLIDriver({ cwd: '/trusted-project' });
    const mirror = new ProviderScreenMirror(80, 12);
    const startup = driver as unknown as {
      screenMirror: ProviderScreenMirror;
      drainHooks: () => Promise<Array<{ event: string }>>;
      waitForSessionStart: (
        pty: { write: (bytes: string) => void },
        getRecent: () => string,
        isExited: () => boolean,
        signal: AbortSignal,
      ) => Promise<{ event: string } | null>;
    };
    startup.screenMirror = mirror;
    let accepted = false;
    let raw =
      'Do you trust this folder?\r\n❯ No, exit\r\n  Yes, I trust this folder';
    mirror.write(raw);
    const write = vi.fn((bytes: string) => {
      if (bytes === '\x1b[B') {
        // Ink moves just the selection glyph; it does not repeat "Yes".
        const redraw = '\x1b[2;1H \x1b[3;1H❯';
        raw += redraw;
        mirror.write(redraw);
      } else if (bytes === '\r') {
        accepted = true;
      }
    });
    startup.drainHooks = async () =>
      accepted ? [{ event: 'SessionStart' }] : [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const result = await startup.waitForSessionStart(
        { write },
        () => raw,
        () => false,
        controller.signal,
      );
      expect(result?.event).toBe('SessionStart');
      expect(write.mock.calls.map(([bytes]) => bytes)).toEqual([
        '\x1b[B',
        '\r',
      ]);
    } finally {
      clearTimeout(timeout);
      controller.abort();
      driver.dispose();
    }
  });
});
