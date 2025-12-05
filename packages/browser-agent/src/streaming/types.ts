/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stagehand Page interface - subset of methods needed for streaming
 * Stagehand's Page objects (from stagehand.context.pages()) have
 * built-in CDP support that we use for screencast.
 */
export interface StagehandPage {
  /** Get the main frame ID */
  mainFrameId(): string;

  /** Get CDP session for a frame */
  getSessionForFrame(frameId: string): {
    send<R = unknown>(method: string, params?: object): Promise<R>;
    on<P = unknown>(event: string, handler: (params: P) => void): void;
    off<P = unknown>(event: string, handler: (params: P) => void): void;
  };

  /** Send CDP command directly */
  sendCDP<T = unknown>(method: string, params?: object): Promise<T>;

  /** Get current URL */
  url(): string;
}

/**
 * Quality presets for streaming
 */
export interface StreamQuality {
  /** Target frames per second (1-30) */
  fps: number;
  /** JPEG quality (0-100) */
  quality: number;
  /** Max width in pixels */
  maxWidth: number;
  /** Max height in pixels */
  maxHeight: number;
}

/**
 * Predefined quality presets
 */
export const StreamQualityPresets: Record<string, StreamQuality> = {
  low: { fps: 5, quality: 50, maxWidth: 640, maxHeight: 360 },
  medium: { fps: 15, quality: 70, maxWidth: 4096, maxHeight: 2160 },  // AUDITARIA: Increased to not constrain viewport
  high: { fps: 30, quality: 85, maxWidth: 4096, maxHeight: 2160 },    // AUDITARIA: Increased to not constrain viewport
};

/**
 * A single frame from the stream
 */
export interface StreamFrame {
  /** Base64 encoded JPEG data (without data URL prefix) */
  data: string;
  /** Frame timestamp */
  timestamp: number;
  /** Frame dimensions */
  width: number;
  height: number;
  /** Session ID this frame belongs to */
  sessionId: string;
}

/**
 * Stream provider types
 */
export type StreamProviderType = 'cdp' | 'webrtc';

/**
 * Stream state
 */
export type StreamState = 'idle' | 'starting' | 'streaming' | 'stopping' | 'error';

/**
 * Stream status info
 */
export interface StreamStatus {
  sessionId: string;
  providerType: StreamProviderType;
  state: StreamState;
  fps: number;
  quality: StreamQuality;
  clientCount: number;
  startedAt?: Date;
  framesEmitted: number;
  lastFrameAt?: Date;
}

/**
 * Control messages from client to server
 */
export type StreamControlMessage =
  | { type: 'start'; quality?: keyof typeof StreamQualityPresets }
  | { type: 'stop' }
  | { type: 'set_quality'; quality: keyof typeof StreamQualityPresets }
  | { type: 'get_status' }
  | { type: 'ping' };

/**
 * Messages from server to client
 */
export type StreamServerMessage =
  | { type: 'frame'; data: string; timestamp: number; width: number; height: number }
  | { type: 'status'; status: StreamStatus }
  | { type: 'error'; message: string }
  | { type: 'started'; sessionId: string }
  | { type: 'stopped'; sessionId: string }
  | { type: 'connected'; clientId: string; sessionId: string; availableQualities: string[] }
  | { type: 'quality_changed'; quality: string }
  | { type: 'pong' };
