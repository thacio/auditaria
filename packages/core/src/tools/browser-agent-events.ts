/**
 * AUDITARIA_BROWSER_AGENT_FEATURE: Browser Agent Event Bridge
 *
 * A simple event emitter that allows the browser_agent tool to broadcast
 * its progress to any listeners (like the web interface).
 *
 * This enables "Peek Mode" - when the AI uses the browser_agent tool,
 * the web interface can show progress notifications.
 */

import { EventEmitter } from 'events';

export interface BrowserAgentStepEvent {
  step: number;
  timestamp: string;
  url: string | null;
  title: string | null;
  goal: string | null;
  action: string | null;
  evaluation: string | null;
  screenshot?: string;
  thumbnail?: string;
}

export interface BrowserAgentStateEvent {
  state: 'idle' | 'starting' | 'running' | 'paused' | 'stopped' | 'completed' | 'error';
  task?: string;
  currentStep?: number;
  sessionPath?: string;
  error?: string;
}

export interface BrowserAgentDoneEvent {
  success: boolean;
  result: string | null;
  sessionPath: string | null;
  totalSteps: number;
  durationMs: number;
  stopped: boolean;
  stopReason: string | null;
}

export interface BrowserAgentErrorEvent {
  message: string;
  code?: string;
}

export interface BrowserAgentEventMap {
  'state': BrowserAgentStateEvent;
  'step': BrowserAgentStepEvent;
  'done': BrowserAgentDoneEvent;
  'error': BrowserAgentErrorEvent;
}

/**
 * Global event bridge for browser agent progress.
 * Tools emit events here, and the web interface subscribes.
 */
class BrowserAgentEventBridge extends EventEmitter {
  private static instance: BrowserAgentEventBridge;

  private constructor() {
    super();
    // Increase max listeners since multiple components may subscribe
    this.setMaxListeners(20);
  }

  static getInstance(): BrowserAgentEventBridge {
    if (!BrowserAgentEventBridge.instance) {
      BrowserAgentEventBridge.instance = new BrowserAgentEventBridge();
    }
    return BrowserAgentEventBridge.instance;
  }

  emitState(state: BrowserAgentStateEvent): void {
    this.emit('state', state);
  }

  emitStep(step: BrowserAgentStepEvent): void {
    this.emit('step', step);
  }

  emitDone(result: BrowserAgentDoneEvent): void {
    this.emit('done', result);
  }

  emitError(error: BrowserAgentErrorEvent): void {
    this.emit('error', error);
  }
}

// Export singleton instance
export const browserAgentEventBridge = BrowserAgentEventBridge.getInstance();
