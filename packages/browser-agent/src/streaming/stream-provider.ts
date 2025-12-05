/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StreamFrame, StreamQuality, StreamProviderType, StreamState, StagehandPage } from './types.js';

/**
 * Callback for frame events
 */
export type FrameCallback = (frame: StreamFrame) => void;

/**
 * Callback for state changes
 */
export type StateChangeCallback = (state: StreamState) => void;

/**
 * Abstract base class for stream providers
 *
 * Implementations:
 * - CDPStreamProvider: Uses Chrome DevTools Protocol screencast
 * - WebRTCStreamProvider: (future) Uses WebRTC for audio+video
 */
export abstract class StreamProvider {
  protected sessionId: string;
  protected page: StagehandPage | null = null;
  protected state: StreamState = 'idle';
  protected quality: StreamQuality;
  protected frameCallback: FrameCallback | null = null;
  protected stateCallback: StateChangeCallback | null = null;
  protected framesEmitted = 0;
  protected startedAt?: Date;
  protected lastFrameAt?: Date;

  constructor(sessionId: string, quality: StreamQuality) {
    this.sessionId = sessionId;
    this.quality = quality;
  }

  /**
   * Get the provider type
   */
  abstract getType(): StreamProviderType;

  /**
   * Start streaming from the given page
   */
  abstract start(page: StagehandPage): Promise<void>;

  /**
   * Stop streaming and cleanup
   */
  abstract stop(): Promise<void>;

  /**
   * Register callback for frame events
   */
  onFrame(callback: FrameCallback): void {
    this.frameCallback = callback;
  }

  /**
   * Register callback for state changes
   */
  onStateChange(callback: StateChangeCallback): void {
    this.stateCallback = callback;
  }

  /**
   * Update streaming quality
   */
  abstract setQuality(quality: StreamQuality): Promise<void>;

  /**
   * Get current state
   */
  getState(): StreamState {
    return this.state;
  }

  /**
   * Get session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Get stream statistics
   */
  getStats(): {
    framesEmitted: number;
    startedAt?: Date;
    lastFrameAt?: Date;
    quality: StreamQuality;
  } {
    return {
      framesEmitted: this.framesEmitted,
      startedAt: this.startedAt,
      lastFrameAt: this.lastFrameAt,
      quality: this.quality,
    };
  }

  /**
   * Emit a frame to registered callback
   */
  protected emitFrame(frame: StreamFrame): void {
    this.framesEmitted++;
    this.lastFrameAt = new Date();
    this.frameCallback?.(frame);
  }

  /**
   * Update state and notify callback
   */
  protected setState(state: StreamState): void {
    this.state = state;
    this.stateCallback?.(state);
  }
}
