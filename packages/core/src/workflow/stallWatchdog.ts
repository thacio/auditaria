/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: Only silence while waiting for the model is a stall.
// Tool execution can legitimately take longer than the model's idle timeout.
export class WorkflowStallWatchdog {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly tools = new Set<string>();
  private disposed = false;

  constructor(
    private readonly timeoutMs: number,
    private readonly onStall: () => void,
  ) {}

  activity(kind: 'progress' | 'tool-start' | 'tool-end', id?: string): void {
    if (this.disposed) return;
    if (kind === 'tool-start' && id) this.tools.add(id);
    if (kind === 'tool-end' && id) this.tools.delete(id);
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.timeoutMs > 0 && this.tools.size === 0) {
      this.timer = setTimeout(this.onStall, this.timeoutMs);
      this.timer.unref();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.tools.clear();
  }
}
