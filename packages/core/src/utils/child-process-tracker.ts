/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA: Global child process tracker for CLI subprocess cleanup on exit.
// Ensures all spawned provider CLI processes (claude, codex, auditaria) are
// killed when the main process exits, regardless of exit path (graceful quit,
// Ctrl+C, terminal close, uncaught exception).

import { spawnSync } from 'child_process';
import os from 'os';

const activePids = new Set<number>();
let exitHandlerRegistered = false;
const isWindows = os.platform() === 'win32';

/**
 * Register a child process PID for tracking. On process exit, all tracked
 * PIDs will be synchronously killed.
 *
 * On Windows, uses `taskkill /f /t` (synchronous via spawnSync) to kill the
 * entire process tree — necessary because `shell: true` spawns cmd.exe as
 * intermediary, and `process.kill()` would only kill cmd.exe, not the actual
 * CLI subprocess underneath.
 *
 * On Unix, uses `process.kill(pid, 'SIGKILL')` for immediate termination.
 */
export function trackChildProcess(pid: number): void {
  activePids.add(pid);
  if (!exitHandlerRegistered) {
    exitHandlerRegistered = true;
    process.on('exit', killAllTrackedProcesses);
  }
}

/**
 * Unregister a child process PID (e.g., when the subprocess exits naturally
 * after completing a message turn).
 */
export function untrackChildProcess(pid: number): void {
  activePids.delete(pid);
}

function killAllTrackedProcesses(): void {
  for (const pid of activePids) {
    try {
      if (isWindows) {
        // spawnSync is synchronous — safe inside process.on('exit').
        // /f = force, /t = kill entire process tree (cmd.exe + children).
        spawnSync('taskkill', ['/f', '/t', '/pid', String(pid)]);
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch {
      // Process already dead — ignore
    }
  }
  activePids.clear();
}
