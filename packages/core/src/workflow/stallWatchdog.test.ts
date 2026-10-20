/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowStallWatchdog } from './stallWatchdog.js';

afterEach(() => vi.useRealTimers());

describe('WorkflowStallWatchdog', () => {
  it('restarts the silence interval on activity and suspends it for overlapping tools', () => {
    vi.useFakeTimers();
    const stalled = vi.fn();
    const watchdog = new WorkflowStallWatchdog(100, stalled);
    watchdog.activity('progress');
    vi.advanceTimersByTime(90);
    watchdog.activity('progress');
    vi.advanceTimersByTime(90);
    expect(stalled).not.toHaveBeenCalled();
    watchdog.activity('tool-start', 'a');
    watchdog.activity('tool-start', 'b');
    vi.advanceTimersByTime(1000);
    watchdog.activity('tool-end', 'a');
    vi.advanceTimersByTime(1000);
    expect(stalled).not.toHaveBeenCalled();
    watchdog.activity('tool-end', 'b');
    vi.advanceTimersByTime(100);
    expect(stalled).toHaveBeenCalledOnce();
    watchdog.dispose();
  });

  it('supports disabling the watchdog and cancels pending timers on disposal', () => {
    vi.useFakeTimers();
    const stalled = vi.fn();
    const disabled = new WorkflowStallWatchdog(0, stalled);
    disabled.activity('progress');
    const watchdog = new WorkflowStallWatchdog(100, stalled);
    watchdog.activity('progress');
    watchdog.dispose();
    vi.advanceTimersByTime(1000);
    expect(stalled).not.toHaveBeenCalled();
  });
});
