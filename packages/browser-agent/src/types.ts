/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */


/**
 * Actions available in the browser agent tool
 */
export type BrowserAgentAction =
  | 'start' // Initialize browser session
  | 'navigate' // Go to URL
  | 'act' // Single atomic action
  | 'extract' // Get structured data
  | 'screenshot' // Capture current page
  | 'observe' // Get possible actions
  | 'agent_task' // Run autonomous task
  | 'stop'; // End session

/**
 * Parameters for the browser agent tool
 */
/**
 * JSON Schema type for extract action (sent by AI)
 */
export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  description?: string;
  enum?: (string | number | boolean)[];
}

export interface BrowserAgentParams {
  action: BrowserAgentAction;

  // Session management
  /** Optional session identifier for managing multiple browsers.
   * Examples: "admin", "site-a", "compare-1".
   * If omitted: auto-selects the only active session, or creates "default".
   * Required when multiple sessions are active. */
  sessionId?: string;

  /** For stop action: close all active sessions instead of just one. Default: false */
  stopAll?: boolean;

  // For navigate
  url?: string;

  // For act/extract/observe/agent_task
  instruction?: string;

  // For extract - accepts JSON Schema from AI, converted to Zod internally
  schema?: JsonSchema;

  // For screenshot - matches Stagehand nomenclature
  /** Capture entire scrollable page. Default: false (viewport only) */
  fullPage?: boolean;
  /** Limit capture to specific region {x, y, width, height}. Cannot be used with fullPage */
  clip?: ScreenshotClip;
  /** CSS/XPath selector to screenshot a specific element */
  selector?: string;
  /** Image format: 'png' or 'jpeg'. Default: 'png' */
  type?: 'png' | 'jpeg';
  /** JPEG quality 0-100. Only for type='jpeg' */
  quality?: number;
  /** CSS selectors of elements to mask (for sensitive data) */
  mask?: string[];
  /** CSS color for masked overlays. Default: '#FF00FF' */
  maskColor?: string;
  /** Control animations: 'allow' or 'disabled'. Default: 'allow' */
  animations?: 'allow' | 'disabled';
  /** Make background transparent (PNG only). Default: false */
  omitBackground?: boolean;
  /** File path to save screenshot. If not provided, auto-generates in temp dir */
  path?: string;
  /** Return base64 instead of saving to file. Useful for web interface. Default: false */
  returnBase64?: boolean;

  // For agent_task
  maxSteps?: number;
  /** Close browser session after agent_task completes. Default: true */
  closeAfter?: boolean;

  // Model selection
  model?: BrowserAgentModel;

  // For start action - whether to run browser in headless mode (default: false = headed/visible with takeover support)
  headless?: boolean;
}

/**
 * Supported models for browser agent
 * Note: Short model names (without 'google/' prefix) are used for OAuth mode
 * to bypass AI SDK and use our patched GoogleClient which supports OAuth
 */
export type BrowserAgentModel =
  | 'google/gemini-2.0-flash'
  | 'google/gemini-2.5-flash'
  | 'google/gemini-2.5-pro'
  | 'gemini-2.0-flash'
  | 'gemini-2.5-flash-preview-04-17'
  | 'gemini-2.5-pro-preview-03-25';

/**
 * Result of a browser agent action
 */
export interface BrowserAgentResult {
  success: boolean;
  action: BrowserAgentAction;

  // Session info
  /** Which session was used for this action */
  sessionId?: string;
  /** List of all active session IDs */
  activeSessions?: string[];

  // Current state
  url?: string;

  /** Optional message to return to LLM (e.g., when user stops execution) */
  message?: string;

  // For extract/observe
  data?: unknown;

  // For screenshot
  screenshotPath?: string;
  /** Base64 encoded image if no path was provided */
  base64?: string;
  /** Image format used for screenshot */
  screenshotType?: 'png' | 'jpeg';

  // For agent_task
  steps?: AgentStep[];

  // Error info
  error?: string;
}

/**
 * A single step in an agent task
 */
export interface AgentStep {
  stepNumber: number;
  action: string;
  reasoning?: string;
  result?: string;
  screenshot?: string;
}

/**
 * Result of an autonomous agent task execution
 * Returned by executeAgentTask() in StagehandAdapter
 */
export interface AgentTaskResult {
  success: boolean;
  message?: string;
  steps: AgentStep[];
  completed: boolean;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    inference_time_ms: number;
  };
}

/**
 * Configuration for the Stagehand adapter
 * Supports three auth modes:
 * 1. Gemini API key mode: apiKey only
 * 2. Vertex AI mode: apiKey + project + location
 * 3. OAuth mode: authClient + project + location
 */
export interface StagehandConfig {
  // Auth - one of these credential sets is required
  apiKey?: string;
  authClient?: import('google-auth-library').AuthClient;
  project?: string;
  location?: string;

  // Stagehand settings
  model: BrowserAgentModel;
  headless?: boolean;
  verbose?: boolean;
}

/**
 * Clip region for screenshots (CSS pixels)
 * Matches Stagehand/Playwright ScreenshotClip
 */
export interface ScreenshotClip {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Options for screenshots
 * Matches Stagehand/Playwright ScreenshotOptions nomenclature
 * @see https://docs.stagehand.dev/v3/references/page
 */
export interface ScreenshotOptions {
  /** Capture entire scrollable page instead of just viewport. Default: false */
  fullPage?: boolean;

  /** Limit capture to a specific region. Cannot be used with fullPage */
  clip?: ScreenshotClip;

  /** CSS/XPath selector to screenshot a specific element */
  selector?: string;

  /** Image format. Default: 'png' */
  type?: 'png' | 'jpeg';

  /** JPEG quality 0-100. Only used when type is 'jpeg' */
  quality?: number;

  /** Rendering scale. 'css' = 1 pixel per CSS pixel, 'device' = device pixel ratio. Default: 'device' */
  scale?: 'css' | 'device';

  /** Control CSS/Web animations. 'disabled' freezes animations before capture. Default: 'allow' */
  animations?: 'allow' | 'disabled';

  /** Hide text caret during capture. Default: 'hide' */
  caret?: 'hide' | 'initial';

  /** CSS selectors of elements to mask with colored overlay (for sensitive data) */
  mask?: string[];

  /** CSS color for masked overlays. Default: '#FF00FF' */
  maskColor?: string;

  /** Additional CSS to inject before capture */
  style?: string;

  /** Make page background transparent (PNG only). Default: false */
  omitBackground?: boolean;

  /** Maximum time in milliseconds to wait for capture */
  timeout?: number;

  /** File path to save screenshot. If not provided, auto-generates in temp dir */
  path?: string;

  /** Return base64 instead of saving to file. Useful for web interface. Default: false */
  returnBase64?: boolean;
}

/**
 * Result of a screenshot action
 */
export interface ScreenshotResult {
  success: boolean;
  url: string;

  /** File path if path option was provided */
  screenshotPath?: string;

  /** Base64 encoded image if no path was provided */
  base64?: string;

  /** Image format used */
  type: 'png' | 'jpeg';
}

/**
 * Result of an extract action
 */
export interface ExtractResult<T = unknown> {
  success: boolean;
  data: T;
  url: string;
}

/**
 * Result of a navigate action
 */
export interface NavigateResult {
  success: boolean;
  url: string;
  title?: string;
}

/**
 * Result of an act action
 */
export interface ActResult {
  success: boolean;
  url: string;
  action: string;
}

/**
 * A single observable action on the page
 * Matches Stagehand's Action type
 */
export interface ObservableAction {
  /** Human-readable description of the action */
  description: string;
  /** Method to call (click, type, etc.) */
  method?: string;
  /** Arguments for the method */
  arguments?: string[];
}

/**
 * Result of an observe action
 */
export interface ObserveResult {
  success: boolean;
  url: string;
  /** List of actions that can be performed on the current page */
  possibleActions: ObservableAction[];
}

// ============================================================================
// Live Step Display Types
// These types are used for inline progress updates during agent_task execution
// ============================================================================

/**
 * Live display update for browser agent steps
 * Used by updateOutput callback to show progress inline in CLI/web
 */
export interface BrowserStepDisplay {
  /** List of steps executed so far */
  browserSteps: BrowserStepInfo[];
  /** Current page URL */
  currentUrl?: string;
  /** Overall execution status */
  status: 'running' | 'completed' | 'error' | 'cancelled';
  /** Session ID for multi-session support */
  sessionId?: string;
  /** Action type for determining if controls should appear */
  action?: string;
  /** Optional thumbnail screenshot (base64, small ~100x60) */
  screenshotThumbnail?: string;
}

/**
 * Information about a single browser step for display
 */
export interface BrowserStepInfo {
  /** Step number (1-indexed) */
  stepNumber: number;
  /** Type of action performed */
  action: string;
  /** AI reasoning for this action */
  reasoning?: string;
  /** Result or description of what happened */
  result?: string;
  /** Step execution status */
  status: 'pending' | 'executing' | 'completed' | 'error';
}

/**
 * Callback type for step updates from Stagehand
 * Matches AgentStepUpdate from Stagehand fork
 */
export interface AgentStepCallback {
  stepNumber: number;
  actions: Array<{
    type: string;
    reasoning?: string;
    [key: string]: unknown;
  }>;
  message: string;
  completed: boolean;
  currentUrl?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    inference_time_ms: number;
  };
}
