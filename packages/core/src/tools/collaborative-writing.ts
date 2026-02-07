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
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolErrorType } from './tool-error.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import type { GeminiChat } from '../core/geminiChat.js';
import { COLLABORATIVE_WRITING_TOOL_NAME } from './tool-names.js';
import { debugLogger } from '../utils/debugLogger.js';

// ============================================
// Interfaces and Type Definitions
// ============================================

interface TrackedFile {
  filePath: string;
  lastKnownContent: string;
  lastKnownHash: string;
  lastModifiedTime: number;
  lastChangeSource: 'ai' | 'external';
  startedAt: Date;
  watcher?: FSWatcher;
  pendingNotification?: 'modified' | 'deleted';
}

type FileChangeType =
  | 'modified'
  | 'deleted'
  | 'permission_denied'
  | 'recreated';

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

const COLLABORATIVE_WRITING_ACTIONS = ['start', 'end', 'status'] as const;
type CollaborativeWritingAction =
  (typeof COLLABORATIVE_WRITING_ACTIONS)[number];

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
      CollaborativeWritingRegistry.instance =
        new CollaborativeWritingRegistry();
    }
    return CollaborativeWritingRegistry.instance;
  }

  /**
   * Start tracking a file for collaborative writing.
   * Initial state is 'external' since we don't know who created/modified it before tracking.
   * Creates a file watcher for event-driven change detection.
   */
  async startTracking(filePath: string): Promise<void> {
    const content = await fs.readFile(filePath, 'utf-8');
    const hash = this.computeHash(content);
    const stats = await fs.stat(filePath);

    const tracked: TrackedFile = {
      filePath,
      lastKnownContent: content,
      lastKnownHash: hash,
      lastModifiedTime: stats.mtimeMs,
      lastChangeSource: 'external',
      startedAt: new Date(),
      watcher: undefined,
      pendingNotification: undefined,
    };

    try {
      const watcher = watch(filePath, (eventType) => {
        if (eventType === 'change') {
          tracked.pendingNotification = 'modified';
        } else if (eventType === 'rename') {
          tracked.pendingNotification = 'deleted';
          debugLogger.log(
            '[COLLAB-WRITE] Marked as pending deletion:',
            filePath,
          );
        }
      });

      watcher.on('error', (error) => {
        debugLogger.error(
          '[COLLAB-WRITE] Watcher error for',
          filePath,
          ':',
          error,
        );
        tracked.pendingNotification = 'modified';
      });

      tracked.watcher = watcher;
    } catch (error) {
      debugLogger.warn(
        '[COLLAB-WRITE] Failed to create file watcher for',
        filePath,
        ':',
        error,
      );
      debugLogger.warn(
        '[COLLAB-WRITE] Falling back to polling-based detection',
      );
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

  private closeWatcher(tracked: TrackedFile): void {
    if (tracked.watcher) {
      try {
        tracked.watcher.close();
        tracked.watcher = undefined;
      } catch (error) {
        debugLogger.warn(
          '[COLLAB-WRITE] Error closing watcher for',
          tracked.filePath,
          ':',
          error,
        );
      }
    }
  }

  getTrackedFile(filePath: string): TrackedFile | undefined {
    return this.trackedFiles.get(filePath);
  }

  getAllTrackedFiles(): TrackedFile[] {
    return Array.from(this.trackedFiles.values());
  }

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
      tracked.lastChangeSource = source;
    }
  }

  isTracking(filePath: string): boolean {
    return this.trackedFiles.has(filePath);
  }

  getTrackedCount(): number {
    return this.trackedFiles.size;
  }

  clear(): void {
    for (const tracked of this.trackedFiles.values()) {
      this.closeWatcher(tracked);
    }
    this.trackedFiles.clear();
  }

  private computeHash(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
  }
}

// ============================================
// Helper Functions
// ============================================

function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

function formatDiffWithLineNumbers(patch: Diff.StructuredPatch): string {
  let result = '';

  patch.hunks.forEach((hunk: Diff.StructuredPatchHunk) => {
    result += `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;

    hunk.lines.forEach((line: string) => {
      result += line + '\n';
    });
  });

  return result.trim();
}

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

async function detectFileChange(
  tracked: TrackedFile,
): Promise<FileChangeInfo | null> {
  if (tracked.watcher && !tracked.pendingNotification) {
    return null;
  }

  if (tracked.pendingNotification === 'deleted') {
    try {
      await fs.stat(tracked.filePath);
      tracked.pendingNotification = 'modified';
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'code' in error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code === 'ENOENT') {
          return {
            type: 'deleted',
            filePath: tracked.filePath,
            lastKnownContent: tracked.lastKnownContent,
            lastModifiedTime: tracked.lastModifiedTime,
          };
        }
      }
      throw error;
    }
  }

  try {
    const stats = await fs.stat(tracked.filePath);

    if (!tracked.watcher && stats.mtimeMs === tracked.lastModifiedTime) {
      return null;
    }

    const currentContent = await fs.readFile(tracked.filePath, 'utf-8');
    const currentHash = computeHash(currentContent);

    if (currentHash === tracked.lastKnownHash) {
      tracked.pendingNotification = undefined;
      return null;
    }

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

    const formattedDiff = formatDiffWithLineNumbers(parsedPatch);

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
    if (error && typeof error === 'object' && 'code' in error) {
      const nodeError = error as NodeJS.ErrnoException;

      if (nodeError.code === 'ENOENT') {
        return {
          type: 'deleted',
          filePath: tracked.filePath,
          lastKnownContent: tracked.lastKnownContent,
          lastModifiedTime: tracked.lastModifiedTime,
        };
      } else if (nodeError.code === 'EACCES' || nodeError.code === 'EPERM') {
        return {
          type: 'permission_denied',
          filePath: tracked.filePath,
          error: nodeError.message,
        };
      }
    }

    throw error;
  }
}

// ============================================
// CollaborativeWritingService - Main Orchestration
// ============================================

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

  async checkAndInjectFileUpdates(
    chat: GeminiChat,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      return;
    }

    const trackedFiles = this.registry.getAllTrackedFiles();

    if (trackedFiles.length === 0) {
      return;
    }

    const changes: FileChangeInfo[] = [];
    for (const tracked of trackedFiles) {
      try {
        const change = await detectFileChange(tracked);
        if (change) {
          changes.push(change);
        }
      } catch (error) {
        debugLogger.error(
          `[COLLAB-WRITE] Error checking file ${tracked.filePath} for changes:`,
          error,
        );
      }
    }

    if (changes.length === 0) {
      return;
    }

    for (const change of changes) {
      this.injectFileUpdateNotification(chat, change);

      if (change.type === 'modified') {
        this.registry.updateFileState(
          change.filePath,
          change.currentContent!,
          change.currentHash!,
          change.currentMtime!,
          'external',
        );

        const tracked = this.registry.getTrackedFile(change.filePath);
        if (tracked) {
          tracked.pendingNotification = undefined;
        }
      } else if (change.type === 'deleted') {
        this.registry.stopTracking(change.filePath);
      } else if (change.type === 'permission_denied') {
        const tracked = this.registry.getTrackedFile(change.filePath);
        if (tracked) {
          tracked.pendingNotification = undefined;
        }
      }
    }
  }

  async updateAfterAIEdit(filePath: string): Promise<void> {
    const absolutePath = path.resolve(filePath);

    if (!this.registry.isTracking(absolutePath)) {
      return;
    }

    try {
      const content = await fs.readFile(absolutePath, 'utf-8');
      const hash = computeHash(content);
      const stats = await fs.stat(absolutePath);

      this.registry.updateFileState(
        absolutePath,
        content,
        hash,
        stats.mtimeMs,
        'ai',
      );

      const tracked = this.registry.getTrackedFile(absolutePath);
      if (tracked) {
        tracked.pendingNotification = undefined;
      }
    } catch (error) {
      debugLogger.error('[COLLAB-WRITE] Error updating after AI edit:', error);
    }
  }

  private injectFileUpdateNotification(
    chat: GeminiChat,
    change: FileChangeInfo,
  ): void {
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

  clear(): void {
    this.registry.clear();
  }

  getRegistry(): CollaborativeWritingRegistry {
    return this.registry;
  }
}

// ============================================
// Tool Description
// ============================================

const COLLABORATIVE_WRITING_DESCRIPTION = `Manage collaborative writing mode for files. This enables real-time detection of external changes to files using file system watchers.
With collaborative writing, you team up with the user and stay synchronized with their manual edits, working together seamlessly and collaboratively on files.

## Actions

### action: "start"
Start tracking a file for collaborative writing. When a file is in collaborative-writing mode:
- A file watcher monitors the file for external modifications in real-time
- When the file is modified outside of this conversation (e.g., the user manually edits it), you will receive automatic notifications
- The notification arrives as a USER MESSAGE (not a function call) before your next response
- The notification includes a diff showing exactly what changed
- You know all the updates and keep working from there, and can respond appropriately

### action: "end"
Stop tracking a file. This closes the file watcher and stops monitoring external changes.
Use when:
- You're finished working on the file collaboratively
- You no longer need to be notified about external changes
- You want to reduce overhead by stopping unnecessary file monitoring

### action: "status"
Check current collaborative writing status. Shows all files currently being tracked with their details.

## Important Notification Behavior

- Notifications are delivered as USER MESSAGES, not function calls
- You will NOT see any function calls in history - notifications appear as regular user messages
- Do NOT attempt to call any callback functions - the system handles notifications automatically
- Notifications only include EXTERNAL changes (user edits in their editor, other processes)
- You will NOT be notified about your own edits (Edit tool, Write tool)

## Use Cases

This is useful when:
- You're working on a file and want to stay synchronized with the user's manual edits
- The user is making changes in their editor while you're also modifying the file
- You need to be aware of external modifications to provide better assistance

## Lifecycle

Once started, the file will be automatically tracked until:
- You call this tool with action "end" to stop tracking
- The conversation is cleared with /clear
- The file is deleted (automatic removal with notification)

## Example Workflow

1. User asks you to work on a file collaboratively
2. You call collaborative_writing with action "start" and the file path
3. You make changes using the Edit tool (no notification - it's your own edit)
4. User manually edits the file in their external editor
5. File watcher immediately detects the change
6. When user sends the next message, you automatically receive a notification as a user message with the diff
7. You can acknowledge the changes and adjust your approach accordingly`;

// ============================================
// Tool Parameters Interface
// ============================================

export interface CollaborativeWritingToolParams {
  /**
   * The action to perform: "start", "end", or "status"
   */
  action: CollaborativeWritingAction;

  /**
   * The path to the file to track/untrack (required for "start" and "end" actions)
   */
  file_path?: string;
}

// ============================================
// Tool Invocation
// ============================================

class CollaborativeWritingToolInvocation extends BaseToolInvocation<
  CollaborativeWritingToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: CollaborativeWritingToolParams,
    messageBus: MessageBus,
    toolName?: string,
    displayName?: string,
  ) {
    super(params, messageBus, toolName, displayName);
  }

  getDescription(): string {
    const action = this.params.action;
    if (action === 'status') {
      return 'Check collaborative writing status';
    }
    return `${action === 'start' ? 'Start' : 'End'} collaborative writing: ${this.params.file_path}`;
  }

  async execute(
    _signal: AbortSignal,
    _updateOutput?: (output: string) => void,
  ): Promise<ToolResult> {
    const registry = CollaborativeWritingRegistry.getInstance();
    const action = this.params.action;

    if (action === 'status') {
      return this.executeStatus(registry);
    }

    const filePath = this.params.file_path;
    if (!filePath) {
      return {
        llmContent: `file_path is required for action "${action}"`,
        returnDisplay: 'Error: file_path required',
        error: {
          message: `file_path is required for action "${action}"`,
          type: ToolErrorType.INVALID_TOOL_PARAMS,
        },
      };
    }

    const resolvedPath = path.resolve(this.config.getTargetDir(), filePath);

    if (action === 'start') {
      return this.executeStart(registry, resolvedPath, filePath);
    } else {
      return this.executeEnd(registry, resolvedPath, filePath);
    }
  }

  private executeStatus(registry: CollaborativeWritingRegistry): ToolResult {
    const trackedFiles = registry.getAllTrackedFiles();
    const count = trackedFiles.length;

    if (count === 0) {
      return {
        llmContent:
          'No files are currently being tracked for collaborative writing.',
        returnDisplay: 'No files tracked',
      };
    }

    const fileList = trackedFiles
      .map((f, i) => {
        const duration = Math.round(
          (Date.now() - f.startedAt.getTime()) / 1000,
        );
        return `${i + 1}. ${f.filePath}\n   - Started: ${f.startedAt.toISOString()}\n   - Duration: ${duration}s\n   - Last change source: ${f.lastChangeSource}`;
      })
      .join('\n');

    const llmContent = `Currently tracking ${count} file(s) for collaborative writing:\n\n${fileList}`;

    return {
      llmContent,
      returnDisplay: `Tracking ${count} file(s)`,
    };
  }

  private async executeStart(
    registry: CollaborativeWritingRegistry,
    resolvedPath: string,
    filePath: string,
  ): Promise<ToolResult> {
    if (registry.isTracking(resolvedPath)) {
      return {
        llmContent: `Collaborative writing is already active for: ${resolvedPath}`,
        returnDisplay: `Already tracking: ${filePath}`,
      };
    }

    try {
      await registry.startTracking(resolvedPath);

      const llmContent = `Successfully started collaborative writing mode for: ${resolvedPath}

You will now receive automatic notifications when this file is modified externally. The notifications will include diffs showing what changed.

The file will be tracked until you call this tool with action "end" or the conversation is cleared.`;

      return {
        llmContent,
        returnDisplay: `Started tracking: ${filePath}`,
      };
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      if (errorMsg.includes('ENOENT')) {
        return {
          llmContent: `Failed to start collaborative writing: File not found: ${resolvedPath}`,
          returnDisplay: 'Error: File not found',
          error: {
            message: `File not found: ${resolvedPath}`,
            type: ToolErrorType.FILE_NOT_FOUND,
          },
        };
      } else if (errorMsg.includes('EACCES') || errorMsg.includes('EPERM')) {
        return {
          llmContent: `Failed to start collaborative writing: Permission denied for file: ${resolvedPath}`,
          returnDisplay: 'Error: Permission denied',
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

  private executeEnd(
    registry: CollaborativeWritingRegistry,
    resolvedPath: string,
    filePath: string,
  ): ToolResult {
    if (!registry.isTracking(resolvedPath)) {
      return {
        llmContent: `Collaborative writing is not active for: ${resolvedPath}. No action needed.`,
        returnDisplay: `Not tracking: ${filePath}`,
      };
    }

    const removed = registry.stopTracking(resolvedPath);

    if (removed) {
      const llmContent = `Successfully ended collaborative writing mode for: ${resolvedPath}

The file is no longer being tracked for external changes. You will not receive automatic notifications about modifications to this file.

You can call this tool with action "start" again if you need to resume collaborative writing.`;

      return {
        llmContent,
        returnDisplay: `Stopped tracking: ${filePath}`,
      };
    } else {
      return {
        llmContent: `Failed to end collaborative writing for: ${resolvedPath}`,
        returnDisplay: 'Error: Could not stop tracking',
        error: {
          message: 'Failed to remove from tracking registry',
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
  }
}

// ============================================
// Tool Class
// ============================================

export class CollaborativeWritingTool extends BaseDeclarativeTool<
  CollaborativeWritingToolParams,
  ToolResult
> {
  static readonly Name = COLLABORATIVE_WRITING_TOOL_NAME;
  static readonly Bridgeable = true; // AUDITARIA_CLAUDE_PROVIDER: auto-bridge to external providers via MCP

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      CollaborativeWritingTool.Name,
      'CollaborativeWriting',
      COLLABORATIVE_WRITING_DESCRIPTION,
      Kind.Other,
      {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description:
              'The action to perform: "start" to begin tracking, "end" to stop tracking, "status" to check current state.',
            enum: COLLABORATIVE_WRITING_ACTIONS,
          },
          file_path: {
            type: 'string',
            description:
              'The path to the file to track/untrack. Required for "start" and "end" actions. Can be absolute or relative to the current directory.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      messageBus,
      true,
      false,
    );
  }

  protected override validateToolParamValues(
    params: CollaborativeWritingToolParams,
  ): string | null {
    if (
      !params.action ||
      !COLLABORATIVE_WRITING_ACTIONS.includes(params.action)
    ) {
      return `action must be one of: ${COLLABORATIVE_WRITING_ACTIONS.join(', ')}`;
    }

    if (
      (params.action === 'start' || params.action === 'end') &&
      !params.file_path
    ) {
      return `file_path is required for action "${params.action}"`;
    }

    if (params.file_path && typeof params.file_path !== 'string') {
      return 'file_path must be a string';
    }

    return null;
  }

  protected createInvocation(
    params: CollaborativeWritingToolParams,
    messageBus?: MessageBus,
    toolName?: string,
    displayName?: string,
  ): ToolInvocation<CollaborativeWritingToolParams, ToolResult> {
    return new CollaborativeWritingToolInvocation(
      this.config,
      params,
      messageBus ?? this.messageBus,
      toolName ?? this.name,
      displayName ?? this.displayName,
    );
  }
}

// ============================================
// Exports
// ============================================

export const collaborativeWritingService =
  CollaborativeWritingService.getInstance();

export function clearCollaborativeWriting(): void {
  collaborativeWritingService.clear();
}
