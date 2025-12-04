/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// Re-export types
export type {
  BrowserAgentAction,
  BrowserAgentParams,
  BrowserAgentResult,
  BrowserAgentModel,
  AgentStep,
  AgentTaskResult,
  StagehandConfig,
  ScreenshotOptions,
  ScreenshotResult,
  ExtractResult,
  NavigateResult,
  ActResult,
  ObserveResult,
  ObservableAction,
} from './types.js';

// Re-export errors
export { BrowserAgentError, BrowserAgentErrorType } from './errors.js';

// Re-export adapter
export { StagehandAdapter } from './stagehand-adapter.js';

// Re-export credential bridge
export {
  CredentialBridge,
  CredentialBridgeError,
  type CredentialMode,
  type StagehandCredentials,
} from './credential-bridge.js';

// Re-export session manager
export {
  SessionManager,
  SessionState,
  type SessionConfig,
  type SessionInfo,
} from './session-manager.js';

// Re-export tool
export { BrowserAgentTool } from './browser-agent-tool.js';

// Re-export streaming
export {
  StreamManager,
  StreamProvider,
  CDPStreamProvider,
  StreamQualityPresets,
  type StreamQuality,
  type StreamFrame,
  type StreamProviderType,
  type StreamState,
  type StreamStatus,
  type StreamControlMessage,
  type StreamServerMessage,
  type FrameCallback,
  type StateChangeCallback,
  type StreamClientCallback,
  type StagehandPage,
} from './streaming/index.js';
