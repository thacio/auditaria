/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { CDPStreamProvider } from './cdp-stream-provider.js';
import type { StreamProvider } from './stream-provider.js';
import type {
  StreamFrame,
  StreamQuality,
  StreamQualityPresets,
  StreamStatus,
  StreamProviderType,
  StagehandPage,
} from './types.js';
import { StreamQualityPresets as Presets } from './types.js';
import { logger } from '../logger.js';

/**
 * Callback for receiving frames
 */
export type StreamClientCallback = (frame: StreamFrame) => void;

/**
 * Client registration info
 */
interface StreamClient {
  id: string;
  callback: StreamClientCallback;
  registeredAt: Date;
}

/**
 * Stream session tracking
 */
interface StreamSession {
  sessionId: string;
  provider: StreamProvider;
  clients: Map<string, StreamClient>;
  quality: StreamQuality;
}

/**
 * StreamManager - Manages streaming providers and client subscriptions
 *
 * Features:
 * - One provider per browser session (sessionId)
 * - Multiple clients can watch the same session
 * - Lazy start: streaming starts when first client connects
 * - Auto stop: streaming stops when last client disconnects
 */
export class StreamManager {
  private static instance: StreamManager | null = null;

  private sessions: Map<string, StreamSession> = new Map();
  private pageResolver: ((sessionId: string) => Promise<StagehandPage | null>) | null = null;

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): StreamManager {
    if (!StreamManager.instance) {
      StreamManager.instance = new StreamManager();
    }
    return StreamManager.instance;
  }

  /**
   * Reset instance (for testing)
   */
  static resetInstance(): void {
    if (StreamManager.instance) {
      StreamManager.instance.stopAll();
    }
    StreamManager.instance = null;
  }

  /**
   * Set the function to resolve Page from sessionId
   * This connects StreamManager to SessionManager
   */
  setPageResolver(resolver: (sessionId: string) => Promise<StagehandPage | null>): void {
    this.pageResolver = resolver;
  }

  /**
   * Subscribe a client to a browser session's stream
   *
   * @param sessionId - Browser session to watch
   * @param clientId - Unique client identifier
   * @param callback - Function to receive frames
   * @param qualityPreset - Quality preset name
   * @returns Cleanup function to unsubscribe
   */
  async subscribe(
    sessionId: string,
    clientId: string,
    callback: StreamClientCallback,
    qualityPreset: keyof typeof StreamQualityPresets = 'medium',
  ): Promise<() => Promise<void>> {
    // Get or create session
    let session = this.sessions.get(sessionId);

    if (!session) {
      // Create new streaming session
      const quality = Presets[qualityPreset];
      const provider = this.createProvider('cdp', sessionId, quality);

      session = {
        sessionId,
        provider,
        clients: new Map(),
        quality,
      };

      // Wire up frame forwarding
      provider.onFrame((frame) => {
        this.broadcastFrame(sessionId, frame);
      });

      this.sessions.set(sessionId, session);
    }

    // Register client
    session.clients.set(clientId, {
      id: clientId,
      callback,
      registeredAt: new Date(),
    });

    logger.debug(`[StreamManager] Client ${clientId} subscribed to session ${sessionId}`, {
      totalClients: session.clients.size,
    });

    // Start streaming if this is the first client
    if (session.clients.size === 1) {
      await this.startStreaming(sessionId);
    }

    // Return unsubscribe function
    return async () => {
      await this.unsubscribe(sessionId, clientId);
    };
  }

  /**
   * Unsubscribe a client from a session
   */
  async unsubscribe(sessionId: string, clientId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.clients.delete(clientId);

    logger.debug(`[StreamManager] Client ${clientId} unsubscribed from session ${sessionId}`, {
      remainingClients: session.clients.size,
    });

    // Stop streaming if no more clients
    if (session.clients.size === 0) {
      await this.stopStreaming(sessionId);
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Get status of a stream
   */
  getStatus(sessionId: string): StreamStatus | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const stats = session.provider.getStats();

    return {
      sessionId,
      providerType: session.provider.getType(),
      state: session.provider.getState(),
      fps: session.quality.fps,
      quality: session.quality,
      clientCount: session.clients.size,
      startedAt: stats.startedAt,
      framesEmitted: stats.framesEmitted,
      lastFrameAt: stats.lastFrameAt,
    };
  }

  /**
   * Get all active stream session IDs
   */
  getActiveSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Set quality for a stream
   */
  async setQuality(
    sessionId: string,
    qualityPreset: keyof typeof StreamQualityPresets,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const quality = Presets[qualityPreset];
    session.quality = quality;
    await session.provider.setQuality(quality);
  }

  /**
   * Stop all streams
   */
  async stopAll(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());
    await Promise.all(sessionIds.map((id) => this.stopStreaming(id)));
    this.sessions.clear();
  }

  // ─────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────

  /**
   * Create a stream provider
   */
  private createProvider(
    type: StreamProviderType,
    sessionId: string,
    quality: StreamQuality,
  ): StreamProvider {
    switch (type) {
      case 'cdp':
        return new CDPStreamProvider(sessionId, quality);
      case 'webrtc':
        throw new Error('WebRTC provider not yet implemented');
      default:
        throw new Error(`Unknown provider type: ${type}`);
    }
  }

  /**
   * Start streaming for a session
   */
  private async startStreaming(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (!this.pageResolver) {
      throw new Error('Page resolver not set. Call setPageResolver first.');
    }

    // Wait for page to be ready (retry up to 10 times with 500ms delay)
    let page: StagehandPage | null = null;
    const maxRetries = 10;
    const retryDelay = 500;

    for (let i = 0; i < maxRetries; i++) {
      page = await this.pageResolver(sessionId);
      if (page) break;

      logger.debug(`[StreamManager] Waiting for page to be ready... (attempt ${i + 1}/${maxRetries})`);
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }

    if (!page) {
      logger.error(`[StreamManager] No page found for session ${sessionId} after ${maxRetries} retries`);
      // Don't throw - just log error and let clients show "connecting" state
      return;
    }

    await session.provider.start(page);
  }

  /**
   * Stop streaming for a session
   */
  private async stopStreaming(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    await session.provider.stop();
  }

  /**
   * Broadcast frame to all clients of a session
   */
  private broadcastFrame(sessionId: string, frame: StreamFrame): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    for (const client of session.clients.values()) {
      try {
        client.callback(frame);
      } catch (error) {
        logger.warn(`[StreamManager] Error sending frame to client ${client.id}:`, error);
      }
    }
  }
}
