/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import path from 'node:path';
import type { WebSocket } from 'ws';
import { collaborativeWritingService } from '@google/gemini-cli-core';
import { WebFeature } from '../core/webFeature.js';
import type { WebFeatureContext } from '../core/types.js';
import { readString } from '../protocol.js';

type ToggleAction = 'start' | 'end';

function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('ENOENT')) return 'File not found';
  if (message.includes('EACCES') || message.includes('EPERM')) {
    return 'Permission denied';
  }
  return message;
}

/**
 * The editor's "collaborative writing" toggle: lets the user start/stop AI
 * tracking of a file from the web, and keeps the toggle in sync when the
 * AI tool itself starts or stops tracking.
 */
export class CollaborativeWritingFeature extends WebFeature {
  readonly name = 'collaborative-writing';
  private unsubscribe: (() => void) | null = null;

  protected onAttach(ctx: WebFeatureContext): void {
    this.unsubscribe = collaborativeWritingService
      .getRegistry()
      .onChange(() => this.broadcastStatus());

    ctx.inbound.on('collaborative_writing_status_request', () =>
      this.broadcastStatus(),
    );
    ctx.inbound.on('collaborative_writing_toggle', (message) => {
      const action = readString(message, 'action');
      return this.toggle(
        readString(message, 'path') ?? '',
        action === 'start' || action === 'end' ? action : undefined,
      );
    });
  }

  protected onDetach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  override sendInitialState(ws: WebSocket): void {
    this.send(ws, 'collaborative_writing_status', this.snapshot());
  }

  private snapshot() {
    const trackedFiles = collaborativeWritingService
      .getRegistry()
      .getAllTrackedFiles()
      .map((file) => ({
        path: file.filePath,
        startedAt: file.startedAt.toISOString(),
        lastChangeSource: file.lastChangeSource,
      }));
    return { trackedFiles };
  }

  private broadcastStatus(): void {
    this.broadcast('collaborative_writing_status', this.snapshot());
  }

  private async toggle(
    filePath: string,
    action: ToggleAction | undefined,
  ): Promise<void> {
    const respond = (resolvedPath: string, success: boolean, message: string) =>
      this.broadcast('collaborative_writing_toggle_result', {
        path: resolvedPath,
        action,
        success,
        message,
      });

    if (!filePath) {
      respond(filePath, false, 'File path is required');
      return;
    }
    if (!action) {
      respond(filePath, false, 'Action must be "start" or "end"');
      return;
    }

    const registry = collaborativeWritingService.getRegistry();
    const resolvedPath = path.resolve(
      this.ctx?.workspaceRoot ?? process.cwd(),
      filePath,
    );
    const tracking = registry.isTracking(resolvedPath);

    // The status broadcast follows automatically via the registry listener.
    try {
      if (action === 'start') {
        if (tracking) {
          respond(resolvedPath, true, 'Already tracking this file');
        } else {
          await registry.startTracking(resolvedPath);
          respond(
            resolvedPath,
            true,
            'Started collaborative writing for this file',
          );
        }
      } else if (!tracking) {
        respond(resolvedPath, true, 'File was not being tracked');
      } else {
        registry.stopTracking(resolvedPath);
        respond(
          resolvedPath,
          true,
          'Stopped collaborative writing for this file',
        );
      }
    } catch (error) {
      respond(resolvedPath, false, friendlyError(error));
    }
  }
}
