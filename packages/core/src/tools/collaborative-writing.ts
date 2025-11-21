/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as Diff from 'diff';
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import type { ToolInvocation, ToolResult } from './tools.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
} from './tools.js';
import { ToolErrorType } from './tool-error.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import type { GeminiChat } from '../core/geminiChat.js';
import {
  COLLABORATIVE_WRITING_START_TOOL_NAME,
  COLLABORATIVE_WRITING_END_TOOL_NAME,
} from './tool-names.js';

// ============================================
// Interfaces and Type Definitions
// ============================================

interface TrackedFile {
  filePath: string;
  lastKnownContent: string;
  lastKnownHash: string;
  lastModifiedTime: number;
  lastChangeSource: 'ai' | 'external'; // Track who made the last change (ai=AI edit, external=everything else)
  startedAt: Date;
  watcher?: FSWatcher; // File watcher instance for event-driven change detection
  pendingNotification?: 'modified' | 'deleted'; // Flag set by watcher when change detected
}

type FileChangeType = 'modified' | 'deleted' | 'permission_denied' | 'recreated';

interface FileChangeInfo {
  type: FileChangeType;
  filePath: string;
  diff?: string;
  currentContent?: string;
  currentHash?: string;
  currentMtime?: number;
  linesAdded?: number;
  linesRemoved?: number;
  lastKnownContent?: string;
  lastModifiedTime?: number;
  error?: string;
}

// ============================================
// CollaborativeWritingRegistry - Singleton Storage
// ============================================

/**
 * Singleton registry for tracking files in collaborative writing mode.
 * Stores file state and provides methods to track/untrack files.
 */
class CollaborativeWritingRegistry {
  private static instance: CollaborativeWritingRegistry;
  private trackedFiles = new Map<string, TrackedFile>();

  static getInstance(): CollaborativeWritingRegistry {
    if (!CollaborativeWritingRegistry.instance) {
      CollaborativeWritingRegistry.instance = new CollaborativeWritingRegistry();
    }
    return CollaborativeWritingRegistry.instance;
  }

  /**
   * Start tracking a file for collaborative writing.
   * Initial state is 'external' since we don't know who created/modified it before tracking.
   * Creates a file watcher for event-driven change detection.
   */
  async startTracking(filePath: string): Promise<void> {
    // Read current file state
    const content = await fs.readFile(filePath, 'utf-8');
    const hash = this.computeHash(content);
    const stats = await fs.stat(filePath);

    const tracked: TrackedFile = {
      filePath,
      lastKnownContent: content,
      lastKnownHash: hash,
      lastModifiedTime: stats.mtimeMs,
      lastChangeSource: 'external', // Initial state
      startedAt: new Date(),
      watcher: undefined,
      pendingNotification: undefined,
    };

    // Create file watcher for event-driven change detection
    // Using native fs.watch() like DirectoryWatcherService for consistency
    try {
      // console.log('[COLLAB-WRITE] Creating file watcher for:', filePath);

      const watcher = watch(filePath, (eventType, filename) => {
        // console.log('[COLLAB-WRITE] Watcher event:', { eventType, filename, filePath });

        // eventType: 'change' = file content modified
        // eventType: 'rename' = file deleted or renamed
        if (eventType === 'change') {
          // File was modified - set flag for notification
          tracked.pendingNotification = 'modified';
          // console.log('[COLLAB-WRITE] Marked as pending modification:', filePath);
        } else if (eventType === 'rename') {
          // File was deleted or renamed - set flag for deletion notification
          tracked.pendingNotification = 'deleted';
          // console.log('[COLLAB-WRITE] Marked as pending deletion:', filePath);
        }
      });

      // Handle watcher errors
      watcher.on('error', (error) => {
        console.error('[COLLAB-WRITE] Watcher error for', filePath, ':', error);
        // On error, set pending notification to force manual check
        tracked.pendingNotification = 'modified';
      });

      tracked.watcher = watcher;
      // console.log('[COLLAB-WRITE] File watcher created successfully for:', filePath);
    } catch (error) {
      // If watcher creation fails, log warning but continue tracking
      // Detection will fall back to polling (existing mtime/hash check)
      console.warn('[COLLAB-WRITE] Failed to create file watcher for', filePath, ':', error);
      console.warn('[COLLAB-WRITE] Falling back to polling-based detection');
    }

    this.trackedFiles.set(filePath, tracked);
  }

  /**
   * Stop tracking a file and clean up its watcher.
   */
  stopTracking(filePath: string): boolean {
    const tracked = this.trackedFiles.get(filePath);
    if (tracked) {
      this.closeWatcher(tracked);
    }
    return this.trackedFiles.delete(filePath);
  }

  /**
   * Helper method to safely close a file watcher.
   * Centralized cleanup logic (DRY principle).
   */
  private closeWatcher(tracked: TrackedFile): void {
    if (tracked.watcher) {
      try {
        // console.log('[COLLAB-WRITE] Closing watcher for:', tracked.filePath);
        tracked.watcher.close();
        tracked.watcher = undefined;
      } catch (error) {
        console.warn('[COLLAB-WRITE] Error closing watcher for', tracked.filePath, ':', error);
      }
    }
  }

  /**
   * Get a tracked file by path.
   */
  getTrackedFile(filePath: string): TrackedFile | undefined {
    return this.trackedFiles.get(filePath);
  }

  /**
   * Get all tracked files.
   */
  getAllTrackedFiles(): TrackedFile[] {
    return Array.from(this.trackedFiles.values());
  }

  /**
   * Update the state of a tracked file after detecting changes.
   * @param source - Who made the change: 'ai' or 'external'
   */
  updateFileState(
    filePath: string,
    content: string,
    hash: string,
    mtime: number,
    source: 'ai' | 'external',
  ): void {
    const tracked = this.trackedFiles.get(filePath);
    if (tracked) {
      tracked.lastKnownContent = content;
      tracked.lastKnownHash = hash;
      tracked.lastModifiedTime = mtime;
      tracked.lastChangeSource = source; // Track the source of the change
    }
  }

  /**
   * Check if a file is being tracked.
   */
  isTracking(filePath: string): boolean {
    return this.trackedFiles.has(filePath);
  }

  /**
   * Get count of tracked files.
   */
  getTrackedCount(): number {
    return this.trackedFiles.size;
  }

  /**
   * Clear all tracked files and close all watchers.
   */
  clear(): void {
    // console.log('[COLLAB-WRITE] Clearing all tracked files and watchers');
    // Close all watchers before clearing
    for (const tracked of this.trackedFiles.values()) {
      this.closeWatcher(tracked);
    }
    this.trackedFiles.clear();
  }

  /**
   * Compute SHA-256 hash of content.
   */
  private computeHash(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
  }
}

// ============================================
// Helper Functions
// ============================================

/**
 * Compute SHA-256 hash of content.
 */
function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}


/**
 * Format a diff with line numbers for better LLM comprehension.
 */
function formatDiffWithLineNumbers(patch: Diff.ParsedDiff): string {
  let result = '';

  patch.hunks.forEach((hunk) => {
    // Add hunk header with line number information
    result += `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;

    // Add each line with proper prefix
    hunk.lines.forEach((line) => {
      result += line + '\n';
    });
  });

  return result.trim();
}

/**
 * Format a file change notification for the AI.
 */
function formatChangeNotification(change: FileChangeInfo): string {
  const timestamp = new Date().toISOString();

  switch (change.type) {
    case 'modified': {
      return `System: [SYSTEM NOTIFICATION - Collaborative Writing]

File externally modified: ${change.filePath}

Timestamp: ${timestamp}
Changes: +${change.linesAdded || 0} lines, -${change.linesRemoved || 0} lines

Diff (with line numbers):
\`\`\`diff
${change.diff}
\`\`\`

This file is in collaborative-writing mode. The above changes were made externally
(by the user or another process) and have been automatically detected.`;
    }

    case 'deleted': {
      return `[SYSTEM NOTIFICATION - Collaborative Writing]

File deleted: ${change.filePath}

The tracked file no longer exists. It was either deleted or moved.
The file has been automatically removed from collaborative-writing tracking.

Last known state:
- Last modified: ${new Date(change.lastModifiedTime || 0).toISOString()}
- Size: ${change.lastKnownContent?.length || 0} bytes

If this deletion was unintentional, you may aknowledge the user and check if it's needed to recreate the file or check if it was moved.`;
    }

    case 'permission_denied': {
      return `[SYSTEM NOTIFICATION - Collaborative Writing]

Permission denied: ${change.filePath}

Cannot read the tracked file due to insufficient permissions.
Error: ${change.error}

The file will continue to be tracked. This may be a temporary permission issue.
If the problem persists, consider ending collaborative-writing mode for this file.`;
    }

    case 'recreated': {
      return `[SYSTEM NOTIFICATION - Collaborative Writing]

File recreated: ${change.filePath}

The tracked file was previously deleted and has now been recreated.

Timestamp: ${timestamp}
Changes from previous version: +${change.linesAdded || 0} lines, -${change.linesRemoved || 0} lines

Diff (with line numbers):
\`\`\`diff
${change.diff}
\`\`\`

The file is still in collaborative-writing mode and will continue to be tracked.`;
    }

    default:
      return `[SYSTEM NOTIFICATION - Collaborative Writing]

File change detected: ${change.filePath}

An unknown type of change was detected. Please check the file manually.`;
  }
}

/**
 * Detect if a file has changed since last tracking.
 * Now uses event-driven file watcher flags for efficient detection.
 * Falls back to polling (mtime/hash check) if no watcher exists.
 */
async function detectFileChange(
  tracked: TrackedFile,
): Promise<FileChangeInfo | null> {
  // console.log('[COLLAB-WRITE] detectFileChange checking:', tracked.filePath);
  // console.log('[COLLAB-WRITE] Current registry state:', {
  //   lastChangeSource: tracked.lastChangeSource,
  //   pendingNotification: tracked.pendingNotification,
  //   hasWatcher: !!tracked.watcher,
  //   lastKnownHash: tracked.lastKnownHash.substring(0, 8) + '...',
  //   lastModifiedTime: tracked.lastModifiedTime,
  // });

  // OPTIMIZATION: Check pendingNotification flag first (event-driven)
  // If watcher exists and no flag is set, skip expensive file operations
  if (tracked.watcher && !tracked.pendingNotification) {
    // console.log('[COLLAB-WRITE] Watcher active, no pending notification - skipping check');
    return null; // No changes detected by watcher
  }

  // If flag is 'deleted', handle deletion immediately
  if (tracked.pendingNotification === 'deleted') {
    // console.log('[COLLAB-WRITE] Pending deletion detected by watcher');
    // Try to confirm deletion by attempting to stat the file
    try {
      await fs.stat(tracked.filePath);
      // File still exists - might have been recreated
      // console.log('[COLLAB-WRITE] File exists after delete event - might be recreated');
      // Clear the deletion flag and check for modification instead
      tracked.pendingNotification = 'modified';
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'code' in error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code === 'ENOENT') {
          // Confirmed: file was deleted
          // console.log('[COLLAB-WRITE] Deletion confirmed');
          return {
            type: 'deleted',
            filePath: tracked.filePath,
            lastKnownContent: tracked.lastKnownContent,
            lastModifiedTime: tracked.lastModifiedTime,
          };
        }
      }
      // Other errors - rethrow
      throw error;
    }
  }

  // If we reach here, either:
  // 1. Watcher detected modification (pendingNotification='modified')
  // 2. No watcher exists (fallback to polling)
  // 3. File was recreated after deletion

  try {
    // Try to stat the file
    const stats = await fs.stat(tracked.filePath);

    // console.log('[COLLAB-WRITE] File stats:', {
    //   currentMtime: stats.mtimeMs,
    //   trackedMtime: tracked.lastModifiedTime,
    //   mtimeChanged: stats.mtimeMs !== tracked.lastModifiedTime,
    // });

    // If no watcher and mtime unchanged, skip (polling fallback optimization)
    if (!tracked.watcher && stats.mtimeMs === tracked.lastModifiedTime) {
      // console.log('[COLLAB-WRITE] No watcher, no mtime change - skipping');
      return null;
    }

    // Read current content
    const currentContent = await fs.readFile(tracked.filePath, 'utf-8');
    const currentHash = computeHash(currentContent);

    // console.log('[COLLAB-WRITE] Content comparison:', {
    //   currentHash: currentHash.substring(0, 8) + '...',
    //   trackedHash: tracked.lastKnownHash.substring(0, 8) + '...',
    //   hashesMatch: currentHash === tracked.lastKnownHash,
    //   currentContentLength: currentContent.length,
    //   trackedContentLength: tracked.lastKnownContent.length,
    // });

    // If hash matches, it's a false positive
    if (currentHash === tracked.lastKnownHash) {
      // console.log('[COLLAB-WRITE] Hash unchanged (false positive)');
      // Clear the pending flag since there's no actual change
      tracked.pendingNotification = undefined;
      return null;
    }

    // Content has changed!
    // console.log('[COLLAB-WRITE] Content HAS changed!');

    // console.log('[COLLAB-WRITE] Generating diff for AI notification...');

    // Content has changed - generate structured diff with line numbers
    const fileName = path.basename(tracked.filePath);
    const parsedPatch = Diff.structuredPatch(
      fileName,
      fileName,
      tracked.lastKnownContent,
      currentContent,
      'AI last known',
      'Current state',
      { context: 3 },
    );

    // Format the diff with line numbers for LLM
    const formattedDiff = formatDiffWithLineNumbers(parsedPatch);

    // Count lines added/removed
    let linesAdded = 0;
    let linesRemoved = 0;
    parsedPatch.hunks.forEach((hunk) => {
      hunk.lines.forEach((line) => {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          linesAdded++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          linesRemoved++;
        }
      });
    });

    return {
      type: 'modified',
      filePath: tracked.filePath,
      diff: formattedDiff,
      currentContent,
      currentHash,
      currentMtime: stats.mtimeMs,
      linesAdded,
      linesRemoved,
    };
  } catch (error: unknown) {
    // Check for specific error types
    if (error && typeof error === 'object' && 'code' in error) {
      const nodeError = error as NodeJS.ErrnoException;

      if (nodeError.code === 'ENOENT') {
        // File was deleted
        return {
          type: 'deleted',
          filePath: tracked.filePath,
          lastKnownContent: tracked.lastKnownContent,
          lastModifiedTime: tracked.lastModifiedTime,
        };
      } else if (nodeError.code === 'EACCES' || nodeError.code === 'EPERM') {
        // Permission denied
        return {
          type: 'permission_denied',
          filePath: tracked.filePath,
          error: nodeError.message,
        };
      }
    }

    // Unexpected error - rethrow
    throw error;
  }
}

// ============================================
// CollaborativeWritingService - Main Orchestration
// ============================================

/**
 * Service that orchestrates collaborative writing functionality.
 * Checks for file changes and injects notifications into chat history.
 */
class CollaborativeWritingService {
  private static instance: CollaborativeWritingService;
  private readonly registry: CollaborativeWritingRegistry;

  constructor() {
    this.registry = CollaborativeWritingRegistry.getInstance();
  }

  static getInstance(): CollaborativeWritingService {
    if (!CollaborativeWritingService.instance) {
      CollaborativeWritingService.instance = new CollaborativeWritingService();
    }
    return CollaborativeWritingService.instance;
  }

  /**
   * Check all tracked files for changes and inject notifications into chat history.
   * This is called before each user message is processed.
   */
  async checkAndInjectFileUpdates(
    chat: GeminiChat,
    signal: AbortSignal,
  ): Promise<void> {
    // console.log(
    //   '[COLLAB-WRITE] ========== checkAndInjectFileUpdates called ==========',
    // );

    // If aborted, exit early
    if (signal.aborted) {
      // console.log('[COLLAB-WRITE] Aborted, exiting early');
      return;
    }

    const trackedFiles = this.registry.getAllTrackedFiles();

    // console.log('[COLLAB-WRITE] Tracked files count:', trackedFiles.length);
    // if (trackedFiles.length > 0) {
    //   console.log(
    //     '[COLLAB-WRITE] Tracked files:',
    //     trackedFiles.map((f) => ({
    //       path: f.filePath,
    //       source: f.lastChangeSource,
    //     })),
    //   );
    // }

    // No files to check
    if (trackedFiles.length === 0) {
      // console.log('[COLLAB-WRITE] No tracked files, exiting');
      return;
    }

    // Check each file for changes
    const changes: FileChangeInfo[] = [];
    for (const tracked of trackedFiles) {
      try {
        const change = await detectFileChange(tracked);
        if (change) {
          // console.log('[COLLAB-WRITE] Change detected for:', tracked.filePath);
          changes.push(change);
        }
      } catch (error) {
        // Log error but continue checking other files
        console.error(
          `[COLLAB-WRITE] Error checking file ${tracked.filePath} for changes:`,
          error,
        );
      }
    }

    // console.log('[COLLAB-WRITE] Total changes found:', changes.length);

    // No changes detected
    if (changes.length === 0) {
      // console.log('[COLLAB-WRITE] No changes to inject, exiting');
      return;
    }

    // Inject notifications for each changed file
    for (const change of changes) {
      // console.log('[COLLAB-WRITE] Injecting notification for:', {
      //   filePath: change.filePath,
      //   type: change.type,
      //   linesAdded: change.linesAdded,
      //   linesRemoved: change.linesRemoved,
      // });

      this.injectFileUpdateNotification(chat, change);

      // Update registry or remove file based on change type
      if (change.type === 'modified') {
        // console.log(
        //   '[COLLAB-WRITE] Updating registry with external change source',
        // );
        this.registry.updateFileState(
          change.filePath,
          change.currentContent!,
          change.currentHash!,
          change.currentMtime!,
          'external', // Mark as external change
        );

        // Clear pending notification flag after processing
        const tracked = this.registry.getTrackedFile(change.filePath);
        if (tracked) {
          tracked.pendingNotification = undefined;
          // console.log('[COLLAB-WRITE] Cleared pending notification flag');
        }
      } else if (change.type === 'deleted') {
        // console.log('[COLLAB-WRITE] File deleted - auto-ending tracking (watcher will be closed)');
        // Auto-end tracking when file is deleted
        // This closes the watcher and removes from registry
        this.registry.stopTracking(change.filePath);
      }
      // For permission_denied, keep tracking - might be temporary
      // Clear the flag so we try again next time
      else if (change.type === 'permission_denied') {
        const tracked = this.registry.getTrackedFile(change.filePath);
        if (tracked) {
          tracked.pendingNotification = undefined;
        }
      }
    }

    // console.log(
    //   '[COLLAB-WRITE] ========== checkAndInjectFileUpdates complete ==========',
    // );
  }

  /**
   * Called after AI successfully edits a tracked file.
   * Updates registry without triggering notifications.
   * This prevents the AI from being notified about its own edits.
   * Clears pendingNotification flag even if watcher fired.
   */
  async updateAfterAIEdit(filePath: string): Promise<void> {
    const absolutePath = path.resolve(filePath);

    // console.log('[COLLAB-WRITE] updateAfterAIEdit called for:', absolutePath);

    if (!this.registry.isTracking(absolutePath)) {
      // console.log('[COLLAB-WRITE] File not tracked, skipping update');
      return;
    }

    // const trackedBefore = this.registry.getTrackedFile(absolutePath);
    // console.log('[COLLAB-WRITE] Registry state BEFORE AI update:', {
    //   lastChangeSource: trackedBefore?.lastChangeSource,
    //   pendingNotification: trackedBefore?.pendingNotification,
    //   lastKnownHash: trackedBefore?.lastKnownHash.substring(0, 8) + '...',
    //   lastModifiedTime: trackedBefore?.lastModifiedTime,
    // });

    try {
      const content = await fs.readFile(absolutePath, 'utf-8');
      const hash = computeHash(content);
      const stats = await fs.stat(absolutePath);

      // console.log('[COLLAB-WRITE] Read file after AI edit:', {
      //   contentLength: content.length,
      //   newHash: hash.substring(0, 8) + '...',
      //   newMtime: stats.mtimeMs,
      // });

      this.registry.updateFileState(
        absolutePath,
        content,
        hash,
        stats.mtimeMs,
        'ai', // Mark as AI change
      );

      // CRITICAL: Clear pendingNotification flag to prevent self-notification
      // Even if file watcher fired during AI edit, we ignore it
      const tracked = this.registry.getTrackedFile(absolutePath);
      if (tracked) {
        tracked.pendingNotification = undefined;
        // console.log('[COLLAB-WRITE] Cleared pendingNotification flag (AI edit)');
      }

      // const trackedAfter = this.registry.getTrackedFile(absolutePath);
      // console.log('[COLLAB-WRITE] Registry state AFTER AI update:', {
      //   lastChangeSource: trackedAfter?.lastChangeSource,
      //   pendingNotification: trackedAfter?.pendingNotification,
      //   lastKnownHash: trackedAfter?.lastKnownHash.substring(0, 8) + '...',
      //   lastModifiedTime: trackedAfter?.lastModifiedTime,
      // });
    } catch (error) {
      console.error('[COLLAB-WRITE] Error updating after AI edit:', error);
    }
  }


  /**
   * Inject a system notification into chat history to notify the AI about a file change.
   *
   * IMPORTANT: We inject this as a simple user message, NOT as a function call/response pair.
   * If we inject it as a function call, the AI sees itself calling "uncallable_system_callback_collaborative_writing_file_updated"
   * in the history and tries to replicate this behavior (calling a non-existent tool).
   */
  private injectFileUpdateNotification(
    chat: GeminiChat,
    change: FileChangeInfo,
  ): void {
    // console.log('[COLLAB-WRITE] Injecting notification as user message');

    // ============================================
    // OLD IMPLEMENTATION (COMMENTED OUT - BUG FIX)
    // ============================================
    // Problem: When we inject a fictitious function call/response pair, the AI sees
    // "uncallable_system_callback_collaborative_writing_file_updated" in its own history (role: 'model') and learns
    // that it should call this function after modifying tracked files.
    // But this function is NOT a registered tool - it only exists for injection purposes.
    // Result: AI tries to call the non-existent tool and gets errors like:
    // "Ferramenta 'uncallable_system_callback_collaborative_writing_file_updated' não encontrada no registro"
    //
    // The bug was reproduced in testing where after the AI used the Edit tool,
    // it spontaneously tried to call uncallable_system_callback_collaborative_writing_file_updated, causing errors.
    //
    // OLD CODE:
    // const callId = `collab-write-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    // const functionCallContent: Content = {
    //   role: 'model',
    //   parts: [{
    //     functionCall: {
    //       name: 'uncallable_system_callback_collaborative_writing_file_updated',
    //       args: { file_path: change.filePath, change_type: change.type },
    //       id: callId,
    //     },
    //   }],
    // };
    // chat.addHistory(functionCallContent);
    // const functionResponseContent: Content = {
    //   role: 'user',
    //   parts: [{
    //     functionResponse: {
    //       name: 'uncallable_system_callback_collaborative_writing_file_updated',
    //       response: { output: formatChangeNotification(change) },
    //       id: callId,
    //     },
    //   }],
    // };
    // chat.addHistory(functionResponseContent);
    // ============================================

    // NEW IMPLEMENTATION: Inject as a simple user message
    // This prevents the AI from seeing itself call a non-existent function
    const notificationContent: Content = {
      role: 'user',
      parts: [
        {
          text: formatChangeNotification(change),
        },
      ],
    };

    chat.addHistory(notificationContent);
  }

  /**
   * Clear all tracked files (called on /clear command).
   */
  clear(): void {
    this.registry.clear();
  }

  /**
   * Get the registry instance for direct access if needed.
   */
  getRegistry(): CollaborativeWritingRegistry {
    return this.registry;
  }
}

// ============================================
// Tool 1: Collaborative Writing Start Tool
// ============================================

const COLLABORATIVE_WRITING_START_DESCRIPTION = `Start collaborative writing mode for a file. This enables real-time detection of external changes to the file using file system watchers.
With collaborative writing, you team up with the user and stay synchronized with their manual edts, working together seamlessly and collaboratively on the file.

When a file is in collaborative-writing mode:
- A file watcher monitors the file for external modifications in real-time
- When the file is modified outside of this conversation (e.g., the user manually edits it), you will receive automatic notifications
- The notification arrives as a USER MESSAGE (not a function call) before your next response
- The notification includes a diff showing exactly what changed
- You know all the updates and keep working from there, and can  respond appropriately

IMPORTANT NOTIFICATION BEHAVIOR:
- Notifications are delivered as USER MESSAGES, not function calls
- You will NOT see any function calls in history - notifications appear as regular user messages
- Do NOT attempt to call any callback functions - the system handles notifications automatically
- Notifications only include EXTERNAL changes (user edits in their editor, other processes)
- You will NOT be notified about your own edits (Edit tool, Write tool)

This is useful when:
- You're working on a file and want to stay synchronized with the user's manual edits
- The user is making changes in their editor while you're also modifying the file
- You need to be aware of external modifications to provide better assistance

Once started, the file will be automatically tracked until:
- You call ${COLLABORATIVE_WRITING_END_TOOL_NAME} to stop tracking
- The conversation is cleared with /clear
- The file is deleted (automatic removal with notification)

Example workflow:
1. User asks you to work on a file collaboratively
2. You call ${COLLABORATIVE_WRITING_START_TOOL_NAME} with the file path
3. You make changes using the Edit tool (no notification - it's your own edit)
4. User manually edits the file in their external editor
5. File watcher immediately detects the change
6. When user sends the next message, you automatically receive a notification as a user message with the diff
7. You can acknowledge the changes and adjust your approach accordingly`;

export interface CollaborativeWritingStartParams {
  file_path: string;
}

class CollaborativeWritingStartToolInvocation extends BaseToolInvocation<
  CollaborativeWritingStartParams,
  ToolResult
> {
  constructor(
    params: CollaborativeWritingStartParams,
    messageBus?: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
    private readonly config?: Config,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    return `Start collaborative writing: ${this.params.file_path}`;
  }

  async execute(
    _signal: AbortSignal,
    _updateOutput?: (output: string) => void,
  ): Promise<ToolResult> {
    const registry = CollaborativeWritingRegistry.getInstance();
    const filePath = this.params.file_path;

    // Resolve to absolute path
    const resolvedPath = path.resolve(
      this.config?.getTargetDir() || process.cwd(),
      filePath,
    );

    // Check if already tracking
    if (registry.isTracking(resolvedPath)) {
      return {
        llmContent: `Collaborative writing is already active for: ${resolvedPath}`,
        returnDisplay: `Already tracking: ${filePath}`,
      };
    }

    try {
      // Start tracking the file
      await registry.startTracking(resolvedPath);

      const llmContent = `Successfully started collaborative writing mode for: ${resolvedPath}

You will now receive automatic notifications when this file is modified externally. The notifications will include diffs showing what changed.

The file will be tracked until you call ${COLLABORATIVE_WRITING_END_TOOL_NAME} or the conversation is cleared.`;

      return {
        llmContent,
        returnDisplay: `Started tracking: ${filePath}`,
      };
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Check for specific error types
      if (errorMsg.includes('ENOENT')) {
        return {
          llmContent: `Failed to start collaborative writing: File not found: ${resolvedPath}`,
          returnDisplay: `Error: File not found`,
          error: {
            message: `File not found: ${resolvedPath}`,
            type: ToolErrorType.FILE_NOT_FOUND,
          },
        };
      } else if (errorMsg.includes('EACCES') || errorMsg.includes('EPERM')) {
        return {
          llmContent: `Failed to start collaborative writing: Permission denied for file: ${resolvedPath}`,
          returnDisplay: `Error: Permission denied`,
          error: {
            message: `Permission denied: ${resolvedPath}`,
            type: ToolErrorType.PERMISSION_DENIED,
          },
        };
      }

      return {
        llmContent: `Failed to start collaborative writing for ${resolvedPath}: ${errorMsg}`,
        returnDisplay: `Error: ${errorMsg}`,
        error: {
          message: errorMsg,
          type: ToolErrorType.UNKNOWN,
        },
      };
    }
  }
}

export class CollaborativeWritingStartTool extends BaseDeclarativeTool<
  CollaborativeWritingStartParams,
  ToolResult
> {
  static readonly Name = COLLABORATIVE_WRITING_START_TOOL_NAME;

  constructor(private readonly config?: Config) {
    super(
      CollaborativeWritingStartTool.Name,
      'Collaborative Writing Start',
      COLLABORATIVE_WRITING_START_DESCRIPTION,
      Kind.Other,
      {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description:
              'The path to the file to track for collaborative writing. Can be absolute or relative to the current directory.',
          },
        },
        required: ['file_path'],
        additionalProperties: false,
      },
    );
  }

  protected override validateToolParamValues(
    params: CollaborativeWritingStartParams,
  ): string | null {
    if (!params.file_path || typeof params.file_path !== 'string') {
      return 'file_path must be a non-empty string';
    }

    return null;
  }

  protected createInvocation(
    params: CollaborativeWritingStartParams,
    _messageBus?: MessageBus,
    _toolName?: string,
    _displayName?: string,
  ): ToolInvocation<CollaborativeWritingStartParams, ToolResult> {
    return new CollaborativeWritingStartToolInvocation(
      params,
      _messageBus,
      _toolName,
      _displayName,
      this.config,
    );
  }
}

// ============================================
// Tool 2: Collaborative Writing End Tool
// ============================================

const COLLABORATIVE_WRITING_END_DESCRIPTION = `End collaborative writing mode for a file. This stops the file watcher and stops tracking external changes to the file.

Use this when:
- You're finished working on the file collaboratively
- You no longer need to be notified about external changes
- You want to reduce overhead by stopping unnecessary file monitoring

After calling this:
- The file watcher will be closed and removed
- The file will no longer be monitored for external modifications
- You will not receive automatic change notifications
- You can call ${COLLABORATIVE_WRITING_START_TOOL_NAME} again later if needed

Note:
- All tracked files and watchers are automatically cleaned up when the conversation is cleared with /clear
- If a tracked file is deleted, tracking is automatically ended with a deletion notification`;

export interface CollaborativeWritingEndParams {
  file_path: string;
}

class CollaborativeWritingEndToolInvocation extends BaseToolInvocation<
  CollaborativeWritingEndParams,
  ToolResult
> {
  constructor(
    params: CollaborativeWritingEndParams,
    messageBus?: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
    private readonly config?: Config,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    return `End collaborative writing: ${this.params.file_path}`;
  }

  async execute(
    _signal: AbortSignal,
    _updateOutput?: (output: string) => void,
  ): Promise<ToolResult> {
    const registry = CollaborativeWritingRegistry.getInstance();
    const filePath = this.params.file_path;

    // Resolve to absolute path
    const resolvedPath = path.resolve(
      this.config?.getTargetDir() || process.cwd(),
      filePath,
    );

    // Check if tracking
    if (!registry.isTracking(resolvedPath)) {
      return {
        llmContent: `Collaborative writing is not active for: ${resolvedPath}. No action needed.`,
        returnDisplay: `Not tracking: ${filePath}`,
      };
    }

    // Stop tracking
    const removed = registry.stopTracking(resolvedPath);

    if (removed) {
      const llmContent = `Successfully ended collaborative writing mode for: ${resolvedPath}

The file is no longer being tracked for external changes. You will not receive automatic notifications about modifications to this file.

You can call ${COLLABORATIVE_WRITING_START_TOOL_NAME} again if you need to resume collaborative writing.`;

      return {
        llmContent,
        returnDisplay: `Stopped tracking: ${filePath}`,
      };
    } else {
      return {
        llmContent: `Failed to end collaborative writing for: ${resolvedPath}`,
        returnDisplay: `Error: Could not stop tracking`,
        error: {
          message: 'Failed to remove from tracking registry',
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
  }
}

export class CollaborativeWritingEndTool extends BaseDeclarativeTool<
  CollaborativeWritingEndParams,
  ToolResult
> {
  static readonly Name = COLLABORATIVE_WRITING_END_TOOL_NAME;

  constructor(private readonly config?: Config) {
    super(
      CollaborativeWritingEndTool.Name,
      'Collaborative Writing End',
      COLLABORATIVE_WRITING_END_DESCRIPTION,
      Kind.Other,
      {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description:
              'The path to the file to stop tracking. Must match the path used when starting collaborative writing.',
          },
        },
        required: ['file_path'],
        additionalProperties: false,
      },
    );
  }

  protected override validateToolParamValues(
    params: CollaborativeWritingEndParams,
  ): string | null {
    if (!params.file_path || typeof params.file_path !== 'string') {
      return 'file_path must be a non-empty string';
    }

    return null;
  }

  protected createInvocation(
    params: CollaborativeWritingEndParams,
    _messageBus?: MessageBus,
    _toolName?: string,
    _displayName?: string,
  ): ToolInvocation<CollaborativeWritingEndParams, ToolResult> {
    return new CollaborativeWritingEndToolInvocation(
      params,
      _messageBus,
      _toolName,
      _displayName,
      this.config,
    );
  }
}

// ============================================
// Exports
// ============================================

/**
 * Singleton service instance for collaborative writing.
 * Use this to check for file updates and inject notifications.
 */
export const collaborativeWritingService =
  CollaborativeWritingService.getInstance();

/**
 * Clear all collaborative writing tracking.
 * Called when the conversation is cleared.
 */
export function clearCollaborativeWriting(): void {
  collaborativeWritingService.clear();
}
