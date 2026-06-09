/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_CLAUDE_PROVIDER: Phase-1 interactive-prompt support.
 *
 * Three small primitives in one file:
 *
 *   1. PendingPromptStore — Map<promptId, pending> with default-deny
 *      timeouts. Survives turn boundaries so a prompt fired late doesn't
 *      get lost when Stop fires (race documented in critique).
 *
 *   2. PtyWriteQueue — serialises all writes to the PTY behind a single
 *      mutex, with priorities (system > cli-typist > web-typist) and a
 *      `writingPrompt` gate to keep the prompt body + CR atomic.
 *
 *   3. HOOK_HTTP_RELAY_SCRIPT — the new hook relay (replaces the JSONL
 *      append-only one). POSTs the hook payload to /hook on
 *      ToolExecutorServer and BLOCKS waiting for a decision, then emits
 *      Claude's documented hook contract (JSON stdout with
 *      permissionDecision OR exit-code-only for events that don't
 *      support decisions).
 */

import type { InteractivePromptResponse } from '../types.js';

// ─── PendingPromptStore ─────────────────────────────────────────────────────

export interface PendingPrompt {
  promptId: string;
  driverUuid: string;
  /** Resolved when the user answers (or when timeout fires). */
  resolve: (response: InteractivePromptResponse) => void;
  /** Cleanup timer; cleared on resolve. */
  timer: NodeJS.Timeout;
  /** When the prompt started (for diagnostic logs). */
  startedAt: number;
}

export class PendingPromptStore {
  private readonly pending = new Map<string, PendingPrompt>();

  /**
   * Register a new pending prompt. Returns a promise that resolves with the
   * user's response when it arrives, OR with `{kind:'cancelled', reason}` on
   * timeout / explicit cancel.
   */
  register(
    promptId: string,
    driverUuid: string,
    timeoutMs: number,
  ): Promise<InteractivePromptResponse> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(promptId)) {
          resolve({ kind: 'cancelled', reason: 'timeout' });
        }
      }, timeoutMs);
      this.pending.set(promptId, {
        promptId,
        driverUuid,
        resolve,
        timer,
        startedAt: Date.now(),
      });
    });
  }

  /** Resolve a pending prompt with the user's answer. */
  resolve(promptId: string, response: InteractivePromptResponse): boolean {
    const entry = this.pending.get(promptId);
    if (!entry) return false;
    this.pending.delete(promptId);
    clearTimeout(entry.timer);
    entry.resolve(response);
    return true;
  }

  /** Cancel a pending prompt (e.g. driver disposed). */
  cancel(promptId: string, reason: 'disconnect' | 'user-cancel'): boolean {
    const entry = this.pending.get(promptId);
    if (!entry) return false;
    this.pending.delete(promptId);
    clearTimeout(entry.timer);
    entry.resolve({ kind: 'cancelled', reason });
    return true;
  }

  /** Cancel all pending prompts for a given driver. */
  cancelAllForDriver(driverUuid: string, reason: 'disconnect'): number {
    let n = 0;
    for (const [id, entry] of this.pending) {
      if (entry.driverUuid === driverUuid) {
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.resolve({ kind: 'cancelled', reason });
        n++;
      }
    }
    return n;
  }

  size(): number {
    return this.pending.size;
  }

  has(promptId: string): boolean {
    return this.pending.has(promptId);
  }
}

// ─── PtyWriteQueue ──────────────────────────────────────────────────────────

export type WritePriority = 'system' | 'cli-typist' | 'web-typist';

interface QueuedWrite {
  priority: WritePriority;
  bytes: string;
  resolve: () => void;
}

/**
 * Serialises writes to a PTY through a single mutex queue. Two roles:
 *
 *   - `writeAtomic(bytes, priority)`: enqueues bytes; resolves when written.
 *   - `withAtomicBlock(fn)`: runs `fn` while holding the lock, so a sequence
 *     of `write()` calls inside is uninterrupted by web-typist input.
 *     Used by `typePromptIntoPty` to keep prompt+CR together.
 *
 * Lower-priority writes wait for higher-priority ones to drain. The actual
 * write is just `pty.write(bytes)`; the queue is about ordering, not
 * backpressure.
 */
export class PtyWriteQueue {
  private writeFn: (bytes: string) => void;
  private queue: QueuedWrite[] = [];
  private running = false;
  /** When true, only `system`-priority writes are accepted. */
  private gated = false;

  constructor(writeFn: (bytes: string) => void) {
    this.writeFn = writeFn;
  }

  /** Replace the underlying write function (e.g. PTY changed across turns). */
  setWriteFn(writeFn: (bytes: string) => void): void {
    this.writeFn = writeFn;
  }

  writeAtomic(bytes: string, priority: WritePriority): Promise<void> {
    if (this.gated && priority !== 'system') {
      // Silently drop typist writes while the gate is up (prompt being typed).
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push({ priority, bytes, resolve });
      this.queue.sort(priorityCompare);
      void this.drain();
    });
  }

  /**
   * Run `fn` with the gate up: queued non-system writes are dropped while
   * inside. `fn` may itself call writeAtomic('...', 'system').
   */
  async withAtomicBlock<T>(fn: () => Promise<T>): Promise<T> {
    this.gated = true;
    try {
      return await fn();
    } finally {
      this.gated = false;
    }
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        try {
          this.writeFn(next.bytes);
        } catch {
          /* PTY died — drop silently, caller will see via exit handler */
        }
        next.resolve();
      }
    } finally {
      this.running = false;
    }
  }
}

function priorityCompare(a: QueuedWrite, b: QueuedWrite): number {
  const rank = (p: WritePriority): number =>
    p === 'system' ? 0 : p === 'cli-typist' ? 1 : 2;
  return rank(a.priority) - rank(b.priority);
}

// ─── HOOK_HTTP_RELAY_SCRIPT ─────────────────────────────────────────────────

/**
 * New hook relay. Replaces the JSONL append-only relay in claudeCLIDriver.ts.
 *
 * Behaviour: read the hook payload JSON from stdin, POST to
 * http://127.0.0.1:<AUDITARIA_HOOK_PORT>/hook with envelope:
 *
 *   { driverUuid, eventName, payload }
 *
 * Block up to AUDITARIA_HOOK_TIMEOUT_MS (default 90s) waiting for a JSON
 * response of shape:
 *
 *   { decision: 'allow' | 'deny' | 'defer', reason?, additionalContext?,
 *     stdout?: string }   ← if stdout present, write to stdout (advanced)
 *
 * Then emit Claude's documented PreToolUse contract:
 *   - 'allow'  → exit 0 (no stdout) OR JSON output if reason/additionalContext given
 *   - 'deny'   → exit 2 with reason on stderr
 *   - 'defer'  → exit 0 with nothing (lets Claude's default behaviour run)
 *
 * For non-decision events (SessionStart, Stop, Notification, etc.) the
 * route returns `{decision:'defer'}` and we just exit 0 silently — but
 * we still POST so the parent can observe the event.
 *
 * On any error reaching the server: exit 0 (defer) so we don't block Claude.
 * Logged to stderr (visible in --verbose).
 */
export const HOOK_HTTP_RELAY_SCRIPT = `'use strict';
const http = require('node:http');

const port = parseInt(process.env.AUDITARIA_HOOK_PORT || '0', 10);
const driverUuid = process.env.AUDITARIA_HOOK_DRIVER_UUID || '';
const eventName = process.argv[2] || 'Unknown';
const timeoutMs = parseInt(process.env.AUDITARIA_HOOK_TIMEOUT_MS || '90000', 10);

if (!port || !driverUuid) {
  // Misconfigured — defer so Claude proceeds normally.
  process.stderr.write('[auditaria-hook] missing AUDITARIA_HOOK_PORT or AUDITARIA_HOOK_DRIVER_UUID; deferring\\n');
  process.exit(0);
}

let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdinBuf += d; });
process.stdin.on('end', () => {
  let payload;
  try {
    payload = stdinBuf.trim() ? JSON.parse(stdinBuf) : {};
  } catch (e) {
    process.stderr.write('[auditaria-hook] payload parse error: ' + String(e) + '\\n');
    process.exit(0);
  }

  const body = JSON.stringify({ driverUuid, eventName, payload });

  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      path: '/hook',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    },
    (res) => {
      let chunks = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        let resp;
        try { resp = JSON.parse(chunks); } catch { resp = { decision: 'defer' }; }
        const decision = resp && resp.decision;
        if (decision === 'deny') {
          if (resp.reason) process.stderr.write(String(resp.reason));
          process.exit(2);
        }
        if (decision === 'allow' && (resp.reason || resp.additionalContext)) {
          const out = {
            hookSpecificOutput: {
              hookEventName: eventName,
              permissionDecision: 'allow',
            },
          };
          if (resp.reason) out.hookSpecificOutput.permissionDecisionReason = resp.reason;
          if (resp.additionalContext) out.hookSpecificOutput.additionalContext = resp.additionalContext;
          process.stdout.write(JSON.stringify(out));
        } else if (resp.stdout) {
          process.stdout.write(String(resp.stdout));
        }
        process.exit(0);
      });
    },
  );
  req.on('timeout', () => {
    req.destroy(new Error('hook bridge timeout'));
  });
  req.on('error', (err) => {
    process.stderr.write('[auditaria-hook] bridge error: ' + String(err.message || err) + '\\n');
    process.exit(0);
  });
  req.write(body);
  req.end();
});
`;
