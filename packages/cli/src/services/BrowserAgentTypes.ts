/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_BROWSER_AGENT_FEATURE: Browser Agent Web Interface Types

/**
 * Browser agent execution states
 */
export type BrowserAgentState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'completed'
  | 'error';

/**
 * Options for starting a browser agent task
 */
export interface BrowserAgentStartOptions {
  task: string;
  headless?: boolean;
  model?: string;
  screenshotMode?: 'none' | 'all' | 'final';
  maxSteps?: number;
}

/**
 * A single step in the browser agent execution
 */
export interface BrowserAgentStepData {
  step: number;
  timestamp: string;
  url: string | null;
  title: string | null;
  goal: string | null;
  action: string | null;
  evaluation: string | null;
  screenshotPath: string | null;
  /** Base64 encoded screenshot for streaming (optional) */
  screenshot?: string;
  /** Base64 encoded thumbnail for preview (optional) */
  thumbnail?: string;
}

/**
 * Result when browser agent completes
 */
export interface BrowserAgentResult {
  success: boolean;
  result: string | null;
  sessionPath: string | null;
  steps: BrowserAgentStepData[];
  totalSteps: number;
  durationMs: number;
  stopped: boolean;
  stopReason: string | null;
}

/**
 * Status update sent to clients
 */
export interface BrowserAgentStatusUpdate {
  state: BrowserAgentState;
  task?: string;
  currentStep?: number;
  totalSteps?: number;
  sessionPath?: string;
  error?: string;
}

// WebSocket Message Types - Server to Client

export interface BrowserAgentStateMessage {
  type: 'browser_agent_state';
  data: BrowserAgentStatusUpdate;
}

export interface BrowserAgentStepMessage {
  type: 'browser_agent_step';
  data: BrowserAgentStepData;
}

export interface BrowserAgentDoneMessage {
  type: 'browser_agent_done';
  data: BrowserAgentResult;
}

export interface BrowserAgentErrorMessage {
  type: 'browser_agent_error';
  data: {
    message: string;
    code?: string;
  };
}

export type BrowserAgentServerMessage =
  | BrowserAgentStateMessage
  | BrowserAgentStepMessage
  | BrowserAgentDoneMessage
  | BrowserAgentErrorMessage;

// WebSocket Message Types - Client to Server

export interface BrowserAgentStartMessage {
  type: 'browser_agent_start';
  task: string;
  options?: Omit<BrowserAgentStartOptions, 'task'>;
}

export interface BrowserAgentStopMessage {
  type: 'browser_agent_stop';
}

export interface BrowserAgentPauseMessage {
  type: 'browser_agent_pause';
}

export interface BrowserAgentResumeMessage {
  type: 'browser_agent_resume';
}

export type BrowserAgentClientMessage =
  | BrowserAgentStartMessage
  | BrowserAgentStopMessage
  | BrowserAgentPauseMessage
  | BrowserAgentResumeMessage;

/**
 * Events emitted by BrowserAgentService
 */
export interface BrowserAgentEvents {
  'state-change': BrowserAgentStatusUpdate;
  'step': BrowserAgentStepData;
  'done': BrowserAgentResult;
  'error': { message: string; code?: string };
}
