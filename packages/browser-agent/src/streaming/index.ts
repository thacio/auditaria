/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// Re-export types
export type {
  StreamQuality,
  StreamFrame,
  StreamProviderType,
  StreamState,
  StreamStatus,
  StreamControlMessage,
  StreamServerMessage,
  StagehandPage,
} from './types.js';

export { StreamQualityPresets } from './types.js';

// Re-export stream provider
export { StreamProvider, type FrameCallback, type StateChangeCallback } from './stream-provider.js';

// Re-export CDP stream provider
export { CDPStreamProvider } from './cdp-stream-provider.js';

// Re-export stream manager
export { StreamManager, type StreamClientCallback } from './stream-manager.js';
