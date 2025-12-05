/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { StreamProvider } from './stream-provider.js';
import type { StreamFrame, StreamQuality, StreamProviderType, StagehandPage } from './types.js';
import { logger } from '../logger.js';

/**
 * CDP Screencast frame event data
 */
interface ScreencastFrameEvent {
  data: string; // Base64 encoded image
  metadata: {
    offsetTop: number;
    pageScaleFactor: number;
    deviceWidth: number;
    deviceHeight: number;
    scrollOffsetX: number;
    scrollOffsetY: number;
    timestamp?: number;
  };
  sessionId: number;
}

/**
 * CDP Session-like interface (matches Stagehand's CDPSessionLike)
 */
interface CDPSessionLike {
  send<R = unknown>(method: string, params?: object): Promise<R>;
  on<P = unknown>(event: string, handler: (params: P) => void): void;
  off<P = unknown>(event: string, handler: (params: P) => void): void;
}

/**
 * Stream provider using Chrome DevTools Protocol (CDP) screencast
 *
 * Hybrid approach:
 * - Headless or headed+visible: Uses Page.startScreencast (efficient, real-time)
 * - Headed+minimized: Uses Page.captureScreenshot polling at 2 FPS (works when minimized)
 *
 * Works with Stagehand's Page objects which have built-in CDP support
 * via getSessionForFrame() and sendCDP() methods.
 *
 * @see https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-startScreencast
 * @see https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-getWindowBounds
 */
export class CDPStreamProvider extends StreamProvider {
  private cdpSession: CDPSessionLike | null = null;
  private isStreaming = false;
  private frameHandler: ((event: ScreencastFrameEvent) => void) | null = null;

  // Hybrid mode: screenshot polling when minimized
  private screenshotInterval: NodeJS.Timeout | null = null;
  private windowStateCheckInterval: NodeJS.Timeout | null = null;
  private isMinimized = false;
  private isHeadless = false;

  getType(): StreamProviderType {
    return 'cdp';
  }

  /**
   * Start CDP screencast streaming with hybrid approach
   *
   * Detects if browser is headless or headed, and switches between:
   * - Page.startScreencast for headless or visible windows
   * - Page.captureScreenshot polling for minimized windows
   *
   * @param page - Stagehand Page object (from stagehand.context.pages()[0])
   */
  async start(page: StagehandPage): Promise<void> {
    if (this.state === 'streaming') {
      logger.debug(`[CDPStreamProvider] Already streaming for session ${this.sessionId}`);
      return;
    }

    this.setState('starting');
    this.page = page;

    try {
      // Get CDP session from Stagehand page
      const mainFrameId = page.mainFrameId();
      this.cdpSession = page.getSessionForFrame(mainFrameId) as CDPSessionLike;

      // Detect if running in headless mode
      this.isHeadless = await this.detectHeadlessMode();
      logger.debug(`[CDPStreamProvider] Browser mode: ${this.isHeadless ? 'headless' : 'headed'}`);

      // Start with screencast mode (works for headless + headed visible)
      await this.startScreencastMode();

      // For headed browsers, monitor window state and switch to screenshot polling when minimized
      if (!this.isHeadless) {
        this.startWindowStateMonitoring();
      }

      this.isStreaming = true;
      this.startedAt = new Date();
      this.setState('streaming');

      logger.debug(`[CDPStreamProvider] Started streaming for session ${this.sessionId}`, {
        quality: this.quality,
        mode: this.isHeadless ? 'headless' : 'headed',
      });
    } catch (error) {
      this.setState('error');
      throw new Error(`Failed to start CDP screencast: ${error}`);
    }
  }

  /**
   * Stop CDP screencast streaming and cleanup all resources
   */
  async stop(): Promise<void> {
    if (this.state !== 'streaming' && this.state !== 'starting') {
      return;
    }

    this.setState('stopping');

    try {
      // Stop window state monitoring
      if (this.windowStateCheckInterval) {
        clearInterval(this.windowStateCheckInterval);
        this.windowStateCheckInterval = null;
      }

      // Stop screenshot polling if active
      await this.stopScreenshotMode();

      // Stop screencast if active
      await this.stopScreencastMode();
    } catch (error) {
      logger.warn(`[CDPStreamProvider] Error stopping streaming:`, error);
    } finally {
      this.cdpSession = null;
      this.isStreaming = false;
      this.page = null;
      this.setState('idle');

      logger.debug(`[CDPStreamProvider] Stopped streaming for session ${this.sessionId}`);
    }
  }

  /**
   * Update streaming quality (requires restart)
   */
  async setQuality(quality: StreamQuality): Promise<void> {
    this.quality = quality;

    if (this.state === 'streaming' && this.page) {
      // Restart with new quality
      const page = this.page;
      await this.stop();
      await this.start(page as StagehandPage);
    }
  }

  /**
   * Handle incoming screencast frame
   */
  private async handleFrame(event: ScreencastFrameEvent): Promise<void> {
    if (!this.isStreaming || !this.page) {
      return;
    }

    // Acknowledge frame to receive next one
    try {
      await (this.page as StagehandPage).sendCDP('Page.screencastFrameAck', {
        sessionId: event.sessionId,
      });
    } catch {
      // Session might be closed, ignore
    }

    // Emit frame
    const frame: StreamFrame = {
      data: event.data,
      timestamp: event.metadata.timestamp || Date.now(),
      width: event.metadata.deviceWidth,
      height: event.metadata.deviceHeight,
      sessionId: this.sessionId,
    };

    this.emitFrame(frame);
  }

  /**
   * Detect if browser is running in headless mode
   * Uses CDP to check if Browser.getWindowForTarget returns a window
   */
  private async detectHeadlessMode(): Promise<boolean> {
    if (!this.page) return true;

    try {
      // In headless mode, Browser.getWindowForTarget will fail
      await (this.page as StagehandPage).sendCDP('Browser.getWindowForTarget');
      return false; // Has window = headed mode
    } catch (error) {
      return true; // No window = headless mode
    }
  }

  /**
   * Start screencast mode (Page.startScreencast)
   */
  private async startScreencastMode(): Promise<void> {
    if (!this.page || !this.cdpSession) return;

    // Create frame handler if not exists
    if (!this.frameHandler) {
      this.frameHandler = (event: ScreencastFrameEvent) => {
        this.handleFrame(event);
      };
    }

    // Listen for screencast frames
    this.cdpSession.on('Page.screencastFrame', this.frameHandler);

    // Start screencast with quality settings
    await (this.page as StagehandPage).sendCDP('Page.startScreencast', {
      format: 'jpeg',
      quality: this.quality.quality,
      maxWidth: this.quality.maxWidth,
      maxHeight: this.quality.maxHeight,
      everyNthFrame: Math.max(1, Math.floor(30 / this.quality.fps)),
    });

    logger.debug(`[CDPStreamProvider] Screencast mode started for session ${this.sessionId}`);
  }

  /**
   * Stop screencast mode
   */
  private async stopScreencastMode(): Promise<void> {
    if (!this.cdpSession || !this.page) return;

    try {
      // Remove event listener
      if (this.frameHandler) {
        this.cdpSession.off('Page.screencastFrame', this.frameHandler);
        this.frameHandler = null;
      }

      // Stop screencast
      await (this.page as StagehandPage).sendCDP('Page.stopScreencast');
      logger.debug(`[CDPStreamProvider] Screencast mode stopped for session ${this.sessionId}`);
    } catch (error) {
      // Might already be stopped, ignore
    }
  }

  /**
   * Start screenshot polling mode at 2 FPS (for minimized windows)
   */
  private async startScreenshotMode(): Promise<void> {
    if (!this.page || this.screenshotInterval) return;

    logger.debug(`[CDPStreamProvider] Starting screenshot mode (2 FPS) for session ${this.sessionId}`);

    const captureScreenshot = async () => {
      if (!this.page || !this.isStreaming) return;

      try {
        // Capture screenshot with captureBeyondViewport to match screencast behavior
        const result = await (this.page as StagehandPage).sendCDP('Page.captureScreenshot', {
          format: 'jpeg',
          quality: this.quality.quality,
          captureBeyondViewport: false, // Only capture visible viewport
          fromSurface: true, // Capture from compositor surface (includes deviceScaleFactor)
        });

        // Get layout metrics to determine actual viewport dimensions
        const metrics = (await (this.page as StagehandPage).sendCDP(
          'Page.getLayoutMetrics',
        )) as any;

        // Use visualViewport for actual displayed dimensions (handles deviceScaleFactor)
        const width = metrics.visualViewport?.clientWidth || metrics.contentSize.width;
        const height = metrics.visualViewport?.clientHeight || metrics.contentSize.height;

        const frame: StreamFrame = {
          data: (result as any).data,
          timestamp: Date.now(),
          width,
          height,
          sessionId: this.sessionId,
        };

        this.emitFrame(frame);
      } catch (error) {
        logger.warn(`[CDPStreamProvider] Screenshot capture failed:`, error);
      }
    };

    // Poll at 2 FPS (500ms interval)
    this.screenshotInterval = setInterval(captureScreenshot, 500);
  }

  /**
   * Stop screenshot polling mode
   */
  private async stopScreenshotMode(): Promise<void> {
    if (this.screenshotInterval) {
      clearInterval(this.screenshotInterval);
      this.screenshotInterval = null;
      logger.debug(`[CDPStreamProvider] Screenshot mode stopped for session ${this.sessionId}`);
    }
  }

  /**
   * Check if window is currently minimized
   */
  private async checkWindowState(): Promise<boolean> {
    if (!this.page || this.isHeadless) return false;

    try {
      const windowInfo = (await (this.page as StagehandPage).sendCDP(
        'Browser.getWindowForTarget',
      )) as any;
      const boundsInfo = (await (this.page as StagehandPage).sendCDP('Browser.getWindowBounds', {
        windowId: windowInfo.windowId,
      })) as any;

      return boundsInfo.bounds.windowState === 'minimized';
    } catch (error) {
      // If error, assume not minimized
      return false;
    }
  }

  /**
   * Start monitoring window state and switch streaming modes accordingly
   */
  private startWindowStateMonitoring(): void {
    // Check window state every 2 seconds
    this.windowStateCheckInterval = setInterval(async () => {
      const minimized = await this.checkWindowState();

      if (minimized && !this.isMinimized) {
        // Window was just minimized - switch to screenshot mode
        logger.debug(`[CDPStreamProvider] Window minimized, switching to screenshot mode`);
        this.isMinimized = true;
        await this.stopScreencastMode();
        await this.startScreenshotMode();
      } else if (!minimized && this.isMinimized) {
        // Window was restored - switch back to screencast mode
        logger.debug(`[CDPStreamProvider] Window restored, switching to screencast mode`);
        this.isMinimized = false;
        await this.stopScreenshotMode();
        await this.startScreencastMode();
      }
    }, 2000);
  }
}
