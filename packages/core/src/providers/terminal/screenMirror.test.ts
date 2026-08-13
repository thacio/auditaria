/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_PROVIDER_TERMINAL: Tests for the "Live screen" oracle. The
 * critical property: duplicated frames emitted by a leaky TUI (Claude Code's
 * inline-mode redraw bug) must NOT survive into snapshots — only the current
 * viewport does.
 */

import { describe, it, expect, afterEach } from 'vitest';
import stripAnsi from 'strip-ansi';
import { ProviderScreenMirror } from './screenMirror.js';

describe('ProviderScreenMirror', () => {
  let mirror: ProviderScreenMirror;

  afterEach(() => {
    mirror?.dispose();
  });

  it('snapshot reproduces plain screen content', async () => {
    mirror = new ProviderScreenMirror(80, 24);
    mirror.write('hello world\r\nsecond line');
    const snap = await mirror.snapshot();
    const text = stripAnsi(snap);
    expect(text).toContain('hello world');
    expect(text).toContain('second line');
  });

  it('drops duplicated frames that scrolled off — the Claude redraw-leak case', async () => {
    mirror = new ProviderScreenMirror(80, 10);
    // Simulate the inline-mode leak: the TUI re-emits its banner + frame
    // 50 times instead of repainting in place. In a raw-stream viewer all
    // 50 copies pile up in scrollback; the screen oracle keeps no
    // scrollback, so only the last screenful survives.
    for (let i = 0; i < 50; i++) {
      mirror.write(`BANNER duplicate frame ${i}\r\n`);
    }
    mirror.write('FINAL PROMPT ❯');
    const snap = await mirror.snapshot();
    const text = stripAnsi(snap);
    expect(text).toContain('FINAL PROMPT ❯');
    // Only the frames still on the 10-row screen may appear; early
    // duplicates must be gone.
    expect(text).not.toContain('duplicate frame 0');
    expect(text).not.toContain('duplicate frame 30');
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBeLessThanOrEqual(10);
  });

  it('cursor-positioned in-place repaints converge to a single copy', async () => {
    mirror = new ProviderScreenMirror(80, 24);
    // A well-behaved TUI frame: home cursor, clear, redraw. 20 repaints
    // must yield exactly one copy on screen.
    for (let i = 0; i < 20; i++) {
      mirror.write('\x1b[H\x1b[2JSTATUS: working\r\nspinner |\r\n');
    }
    const snap = await mirror.snapshot();
    const text = stripAnsi(snap);
    expect(text.match(/STATUS: working/g)?.length).toBe(1);
  });

  it('resize changes the grid and is idempotent', async () => {
    mirror = new ProviderScreenMirror(80, 24);
    expect(mirror.cols).toBe(80);
    mirror.resize(120, 30);
    expect(mirror.cols).toBe(120);
    expect(mirror.rows).toBe(30);
    mirror.resize(120, 30); // no-op path
    mirror.resize(Number.NaN, 30); // rejected
    expect(mirror.cols).toBe(120);
    mirror.write('after resize');
    const text = stripAnsi(await mirror.snapshot());
    expect(text).toContain('after resize');
  });

  it('reset clears the screen', async () => {
    mirror = new ProviderScreenMirror(80, 24);
    mirror.write('old provider output');
    mirror.reset();
    const text = stripAnsi(await mirror.snapshot());
    expect(text).not.toContain('old provider output');
  });

  it('snapshot preserves colors as ANSI (client repaint fidelity)', async () => {
    mirror = new ProviderScreenMirror(80, 24);
    mirror.write('\x1b[31mred text\x1b[0m plain');
    const snap = await mirror.snapshot();
    expect(stripAnsi(snap)).toContain('red text');
    // Some SGR color sequence must survive serialization.
    // eslint-disable-next-line no-control-regex
    expect(snap).toMatch(/\x1b\[[0-9;]*3[18]?[0-9;]*m/);
  });

  it('is inert after dispose', async () => {
    mirror = new ProviderScreenMirror(80, 24);
    mirror.dispose();
    mirror.write('ignored');
    mirror.reset();
    mirror.resize(100, 40);
    expect(await mirror.snapshot()).toBe('');
  });

  it('alt-buffer content (fullscreen TUIs) is snapshotted', async () => {
    mirror = new ProviderScreenMirror(80, 24);
    mirror.write('inline before\r\n');
    mirror.write('\x1b[?1049h\x1b[H\x1b[2JALT SCREEN CONTENT');
    const text = stripAnsi(await mirror.snapshot());
    expect(text).toContain('ALT SCREEN CONTENT');
  });
});
