/**
 * @license
 * Copyright 2025 Thacio LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
} from './tools.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import type { Content, Part } from '@google/genai';
import type { Config } from '../config/config.js';
import { tokenLimit } from '../core/tokenLimits.js';
import { DEFAULT_COMPRESSION_TOKEN_THRESHOLD } from '../services/chatCompressionService.js';
import {
  CONTEXT_INSPECT_TOOL_NAME,
  CONTEXT_FORGET_TOOL_NAME,
  CONTEXT_RESTORE_TOOL_NAME,
} from './tool-names.js';

// Configuration: Auto-forget context_inspect output after successful forget operation
// Set to false to keep context_inspect output visible
const AUTO_FORGET_INSPECT_AFTER_FORGET = true;

// Configuration: Minimum character threshold for function responses to be forgettable
// Function responses smaller than this will not appear in the forgettable items list
// Attachments are always forgettable regardless of size
const MIN_FORGETTABLE_RESPONSE_CHARS = 2000;

// ============================================
// Storage and Utilities Section
// ============================================

interface ForgottenContent {
  id: string;
  type: 'functionResponse' | 'attachment';
  originalContent: any;
  description: string;
  messagePosition?: number;
  toolName?: string;
  fileName?: string;
}

interface ForgettableItem {
  id: string;
  type: 'functionResponse' | 'attachment';
  name: string;
  status?: string;
  originalLength: number;
  preview: string;
  messageBefore?: string;
  messagePosition?: number;
}

interface InspectResult {
  forgettableItems: ForgettableItem[];
  statistics: {
    totalForgettable: number;
    currentTokenCount: number;
    percentageUsed: number;
    percentageRemainingUntilCompact: number;
  };
}

interface ForgetResult {
  forgotten: Array<{ id: string; description: string }>;
  failed: Array<{ id: string; reason: string }>;
  autoForgotten: string[];
}

interface RestoreResult {
  restored: string[];
  failed: Array<{ id: string; reason: string }>;
}

/**
 * Singleton storage for forgotten content and history backup
 */
class ContextStorage {
  private static instance: ContextStorage;
  private storage = new Map<string, ForgottenContent>();
  private historyBackup: Content[] | null = null;
  private originalHistoryBackup: Content[] | null = null; // Never modified backup

  static getInstance(): ContextStorage {
    if (!ContextStorage.instance) {
      ContextStorage.instance = new ContextStorage();
    }
    return ContextStorage.instance;
  }

  /**
   * Backs up the current history state
   * @param history The current conversation history to backup
   * @param isOriginal If true, this is the original untouched history
   */
  backupHistory(history: Content[], isOriginal = false): void {
    // Deep clone to avoid reference issues
    const backup = JSON.parse(JSON.stringify(history));

    if (isOriginal) {
      // Intelligently merge: only backup content that isn't already backed up
      // This prevents overwriting original content with hidden placeholders
      if (!this.originalHistoryBackup) {
        // First backup - store everything
        this.originalHistoryBackup = backup;
      } else {
        // Subsequent backup - only add NEW content that wasn't in original
        // Create a merged backup that preserves original content
        const merged = JSON.parse(JSON.stringify(this.originalHistoryBackup));

        // If new history is longer, append the new messages
        for (let i = merged.length; i < backup.length; i++) {
          merged.push(backup[i]);
        }

        // Also check within existing messages for new parts (though rare)
        for (let i = 0; i < Math.min(merged.length, backup.length); i++) {
          if (backup[i].parts && merged[i].parts) {
            // If new message has more parts, check if they should be added
            for (let j = merged[i].parts.length; j < backup[i].parts.length; j++) {
              const newPart = backup[i].parts[j];
              // Only add if it's not a forgotten placeholder
              if (!this.isForgottenPlaceholder(newPart)) {
                merged[i].parts.push(newPart);
              }
            }
          }
        }

        this.originalHistoryBackup = merged;
      }
    }

    // Always update the working backup
    this.historyBackup = backup;
  }

  /**
   * Checks if a part contains a forgotten placeholder
   */
  private isForgottenPlaceholder(part: any): boolean {
    if (!part || typeof part !== 'object') return false;

    if ('functionResponse' in part && part.functionResponse?.response?.output) {
      const output = part.functionResponse.response.output;
      return typeof output === 'string' && output.includes('[CONTENT FORGOTTEN');
    }

    if ('text' in part && typeof part.text === 'string') {
      return part.text.includes('[CONTENT FORGOTTEN');
    }

    return false;
  }

  /**
   * Gets the backup history
   * @param useOriginal If true, returns the original untouched backup
   */
  getHistoryBackup(useOriginal = false): Content[] | null {
    if (useOriginal) {
      return this.originalHistoryBackup ?
        JSON.parse(JSON.stringify(this.originalHistoryBackup)) : null;
    }
    return this.historyBackup ?
      JSON.parse(JSON.stringify(this.historyBackup)) : null;
  }

  /**
   * Finds content in the backup history
   */
  findInBackup(id: string): { content: any, position: { messageIndex: number, partIndex: number } } | null {
    const backup = this.originalHistoryBackup || this.historyBackup;
    if (!backup) return null;

    for (let i = 0; i < backup.length; i++) {
      const message = backup[i];
      if (message.parts) {
        for (let j = 0; j < message.parts.length; j++) {
          const part = message.parts[j];
          if (part && typeof part === 'object') {
            // Check for functionResponse
            if ('functionResponse' in part) {
              if (part.functionResponse?.id === id) {
                return {
                  content: part.functionResponse,
                  position: { messageIndex: i, partIndex: j }
                };
              }
            }
            // Check for attachments (inlineData or fileData)
            // For attachments, we need to match by generated ID pattern
            if (id.startsWith('attachment-')) {
              // Check if this is an inlineData attachment
              if ('inlineData' in part && part.inlineData) {
                // Since we generate IDs based on message index, check if this could be the right attachment
                const expectedInlinePattern = `attachment-inline-${i}-`;
                if (id.startsWith(expectedInlinePattern)) {
                  return {
                    content: part,
                    position: { messageIndex: i, partIndex: j }
                  };
                }
              }
              // Check if this is a fileData attachment
              if ('fileData' in part && part.fileData) {
                const expectedFilePattern = `attachment-file-${i}-`;
                if (id.startsWith(expectedFilePattern)) {
                  return {
                    content: part,
                    position: { messageIndex: i, partIndex: j }
                  };
                }
              }
            }
          }
        }
      }
    }
    return null;
  }

  forget(id: string, content: ForgottenContent): void {
    this.storage.set(id, content);
  }

  restore(id: string): ForgottenContent | null {
    const content = this.storage.get(id);
    if (content) {
      this.storage.delete(id);
      return content;
    }
    return null;
  }

  isForgotten(id: string): boolean {
    return this.storage.has(id);
  }

  getAll(): ForgottenContent[] {
    return Array.from(this.storage.values());
  }

  get(id: string): ForgottenContent | undefined {
    return this.storage.get(id);
  }

  clear(): void {
    this.storage.clear();
    this.historyBackup = null;
    // Don't clear originalHistoryBackup - keep it for the session
  }

  /**
   * Exports the current state for persistence
   * @returns A serializable object containing all forgotten content and backups
   */
  exportState(): any {
    return {
      version: 1,
      timestamp: new Date().toISOString(),
      forgottenContent: Array.from(this.storage.entries()).map(([id, content]) => ({
        id,
        content
      })),
      historyBackup: this.historyBackup,
      originalHistoryBackup: this.originalHistoryBackup
    };
  }

  /**
   * Imports a previously exported state
   * @param state The state object to import
   * @returns True if import was successful, false otherwise
   */
  importState(state: any): boolean {
    try {
      // Validate the state structure
      if (!state || typeof state !== 'object' || state.version !== 1) {
        console.warn('Invalid or incompatible context state version');
        return false;
      }

      // Clear current state completely
      this.storage.clear();
      this.historyBackup = null;
      this.originalHistoryBackup = null;

      // Restore forgotten content
      if (Array.isArray(state.forgottenContent)) {
        for (const item of state.forgottenContent) {
          if (item.id && item.content) {
            this.storage.set(item.id, item.content);
          }
        }
      }

      // Restore history backups (only if present in the state)
      if (state.historyBackup) {
        this.historyBackup = state.historyBackup;
      }
      if (state.originalHistoryBackup) {
        this.originalHistoryBackup = state.originalHistoryBackup;
      }

      return true;
    } catch (error) {
      console.error('Failed to import context state:', error);
      return false;
    }
  }

  /**
   * Checks if there is any state to export
   * @returns True if there is content to save, false otherwise
   */
  hasContent(): boolean {
    return this.storage.size > 0 ||
           this.historyBackup !== null ||
           this.originalHistoryBackup !== null;
  }

  /**
   * Clears all storage including backups and forgotten content
   * Used when starting a completely new conversation (e.g., /clear command)
   */
  clearAll(): void {
    this.storage.clear();
    this.historyBackup = null;
    this.originalHistoryBackup = null;
  }
}

/**
 * Compresses long text outputs for display
 */
function compressOutput(text: string, maxLength = 150): {
  preview: string;
  originalLength: number;
} {
  if (!text || text.length <= maxLength) {
    return {
      preview: text || '[empty]',
      originalLength: text?.length || 0
    };
  }

  const start = text.slice(0, 100);
  const end = text.slice(-50);
  const truncated = text.length - 150;

  return {
    preview: `${start}[...${truncated} chars truncated...]${end}`,
    originalLength: text.length
  };
}

/**
 * Generates ID for attachments
 */
function generateAttachmentId(messageId: number, index: number): string {
  return `att-${messageId}-${index}`;
}

/**
 * Creates a placeholder for forgotten content
 */
function createForgottenPlaceholder(id: string, type: string, description: string): string {
  return `[CONTENT FORGOTTEN - YOU HAVE AMNESIA ABOUT THIS]

⚠️ CRITICAL: As an LLM, you have COMPLETELY FORGOTTEN this content. It no longer exists in your context.
You have ZERO memory of what was here. You cannot recall, reference, or use this information.

Type: ${type}
ID: ${id}

${description}

To restore this content, you MUST either:
- Use ${CONTEXT_RESTORE_TOOL_NAME} with ID: ${id}
- OR run the original command/read the file again

Until then, you are CLUELESS about this content. Do not pretend to remember it.`;
}

/**
 * Extracts text content from a Part
 */
function getTextFromPart(part: Part): string {
  if (typeof part === 'string') {
    return part;
  }
  if (part && typeof part === 'object') {
    if ('text' in part) {
      return part.text || '';
    }
    if ('functionResponse' in part && part.functionResponse?.response?.output) {
      return String(part.functionResponse.response.output);
    }
  }
  return '';
}

/**
 * Describes a single part with its type and key details
 */
function describePart(part: Part): string {
  // Handle string parts
  if (typeof part === 'string') {
    const text = part as string;
    const truncated = text.length > 80 ? `${text.slice(0, 80)}...` : text;
    return `text: "${truncated}"`;
  }

  if (part && typeof part === 'object') {
    // Text part
    if ('text' in part && part.text) {
      const truncated = part.text.length > 80
        ? `${part.text.slice(0, 80)}...`
        : part.text;
      return `text: "${truncated}"`;
    }

    // Function call
    if ('functionCall' in part && part.functionCall) {
      const name = part.functionCall.name || 'unknown';
      const args = part.functionCall.args || {};
      const argsStr = JSON.stringify(args);
      const truncatedArgs = argsStr.length > 60
        ? `${argsStr.slice(0, 60)}...`
        : argsStr;
      return `functionCall: ${name}(${truncatedArgs})`;
    }

    // Function response
    if ('functionResponse' in part && part.functionResponse) {
      const name = part.functionResponse.name || 'unknown';
      const output = part.functionResponse.response?.output || '';
      const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
      const truncatedOutput = outputStr.length > 60
        ? `${outputStr.slice(0, 60)}...`
        : outputStr;
      return `functionResponse: ${name} -> "${truncatedOutput}"`;
    }

    // Inline data (images, etc.)
    if ('inlineData' in part && part.inlineData) {
      return `inlineData: ${part.inlineData.mimeType || 'unknown'}`;
    }

    // File data
    if ('fileData' in part && part.fileData) {
      return `fileData: ${part.fileData.mimeType || 'unknown'}`;
    }

    // Thought (internal reasoning)
    if ('thought' in part && part.thought) {
      const thoughtText = typeof part.thought === 'string' ? String(part.thought) : '';
      if (thoughtText && thoughtText.length > 0) {
        const truncated = thoughtText.length > 60
          ? `${thoughtText.slice(0, 60)}...`
          : thoughtText;
        return `thought: "${truncated}"`;
      }
      return 'thought';
    }

    // Unknown part type
    return `unknown part type`;
  }

  return 'unknown';
}

/**
 * Creates a description of the message before a function response
 */
function describeMessageBefore(content: Content): string {
  const role = content.role || 'unknown';
  const partsCount = content.parts?.length || 0;

  if (partsCount === 0) {
    return `[${role}] (no parts)`;
  }

  // Describe each part
  const partDescriptions = (content.parts || []).map(describePart);

  if (partsCount === 1) {
    return `[${role}] ${partDescriptions[0]}`;
  }

  // Multiple parts - list them
  return `[${role}] (${partsCount} parts): ${partDescriptions.join(', ')}`;
}

/**
 * Gets function response info from history
 */
function extractFunctionResponses(history: Content[]): ForgettableItem[] {
  const items: ForgettableItem[] = [];
  let messageIndex = 0;

  for (const content of history) {
    if (content.parts) {
      for (const part of content.parts) {
        if (part && typeof part === 'object' && 'functionResponse' in part && part.functionResponse) {
          const funcResponse = part.functionResponse!;
          const output = funcResponse.response?.output || '';
          const outputText = typeof output === 'string' ? output : JSON.stringify(output);
          const compressed = compressOutput(outputText);

          // Find the most recent user message before this function response
          let messageBefore = '';
          for (let i = messageIndex - 1; i >= 0; i--) {
            const msg = history[i];
            if (msg.role === 'user') {
              messageBefore = describeMessageBefore(msg);
              break;
            }
          }

          // Only include function responses that meet the minimum character threshold
          if (outputText.length >= MIN_FORGETTABLE_RESPONSE_CHARS) {
            items.push({
              id: funcResponse.id || `func-${messageIndex}-${Date.now()}`,
              type: 'functionResponse',
              name: funcResponse.name || 'unknown',
              originalLength: outputText.length,
              preview: compressed.preview,
              messageBefore,
              messagePosition: messageIndex
            });
          }
        }
      }
    }
    messageIndex++;
  }

  return items;
}

/**
 * Determines if an item will be automatically forgotten during context_forget execution
 * This includes: latest context_inspect output (if enabled) and error/failure responses
 */
function shouldAutoForget(
  item: ForgettableItem,
  history: Content[],
  storage: ContextStorage
): boolean {
  // Check if already forgotten
  if (storage.isForgotten(item.id)) {
    return false; // Already handled
  }

  // Find the actual part in history to check its properties
  for (let i = 0; i < history.length; i++) {
    const content = history[i];
    if (content.parts) {
      for (const part of content.parts) {
        if (part && typeof part === 'object' && 'functionResponse' in part && part.functionResponse) {
          const funcResponse = part.functionResponse;

          // Check if this is the item we're looking for - ONLY match by ID, not name
          if (funcResponse.id === item.id) {
            // Check if it's a context_inspect response (only latest will be auto-forgotten)
            if (funcResponse.name === CONTEXT_INSPECT_TOOL_NAME && AUTO_FORGET_INSPECT_AFTER_FORGET) {
              // Find if this is the most recent context_inspect
              let isLatest = true;
              for (let j = i + 1; j < history.length; j++) {
                const laterContent = history[j];
                if (laterContent.parts) {
                  for (const laterPart of laterContent.parts) {
                    if (laterPart && typeof laterPart === 'object' && 'functionResponse' in laterPart && laterPart.functionResponse) {
                      if (laterPart.functionResponse.name === CONTEXT_INSPECT_TOOL_NAME) {
                        isLatest = false;
                        break;
                      }
                    }
                  }
                }
                if (!isLatest) break;
              }
              if (isLatest) return true;
            }

            // Check if it's an error/failure/cancellation (always auto-forgotten)
            // Proper way: check if response.error exists (not response.output)
            // When tools fail, they have response.error instead of response.output
            if (funcResponse.response && 'error' in funcResponse.response) {
              return true;
            }

            return false;
          }
        }
      }
    }
  }

  return false;
}

/**
 * Gets attachment info from history (inlineData and fileData parts)
 */
function extractAttachments(history: Content[]): ForgettableItem[] {
  const items: ForgettableItem[] = [];
  let messageIndex = 0;

  for (const content of history) {
    if (content.parts) {
      for (const part of content.parts) {
        if (part && typeof part === 'object') {
          // Check for inlineData (images, PDFs, etc.)
          if ('inlineData' in part && part.inlineData) {
            const inlineData = part.inlineData;
            const mimeType = inlineData.mimeType || 'unknown';
            const data = inlineData.data || '';
            const dataLength = typeof data === 'string' ? data.length : 0;

            // Generate a unique ID for this attachment
            const id = `attachment-inline-${messageIndex}-${Date.now()}`;

            // Find the most recent user message before this attachment
            let messageBefore = '';
            for (let i = messageIndex - 1; i >= 0; i--) {
              const msg = history[i];
              if (msg.role === 'user') {
                messageBefore = describeMessageBefore(msg);
                break;
              }
            }

            items.push({
              id,
              type: 'attachment',
              name: `Inline ${mimeType}`,
              originalLength: dataLength,
              preview: `${mimeType} (${Math.round(dataLength / 1024)}KB)`,
              messageBefore,
              messagePosition: messageIndex
            });
          }

          // Check for fileData (uploaded files)
          if ('fileData' in part && part.fileData) {
            const fileData = part.fileData;
            const mimeType = fileData.mimeType || 'unknown';
            const uri = fileData.fileUri || '';

            // Generate a unique ID for this attachment
            const id = `attachment-file-${messageIndex}-${Date.now()}`;

            // Find the most recent user message before this attachment
            let messageBefore = '';
            for (let i = messageIndex - 1; i >= 0; i--) {
              const msg = history[i];
              if (msg.role === 'user') {
                messageBefore = describeMessageBefore(msg);
                break;
              }
            }

            items.push({
              id,
              type: 'attachment',
              name: `File ${mimeType}`,
              originalLength: uri.length,
              preview: `${mimeType} file`,
              messageBefore,
              messagePosition: messageIndex
            });
          }
        }
      }
    }
    messageIndex++;
  }

  return items;
}

// ============================================
// Tool 1: Context Inspect Tool
// ============================================

const CONTEXT_INSPECT_DESCRIPTION = `Inspects the conversation history to identify content that can be FORGOTTEN (erased from LLM memory) to reduce context usage.

⚠️ CRITICAL UNDERSTANDING: You are an LLM (Large Language Model). When you "forget" content:
- You will have COMPLETE AMNESIA about it
- It will be as if you NEVER read it
- You CANNOT recall, reference, or use any information from it
- Your confidence in "remembering" is an ILLUSION - you will be CLUELESS

This tool shows:
- Function call responses larger than ${MIN_FORGETTABLE_RESPONSE_CHARS} characters (configurable threshold)
- Attachments (images, files, PDFs, etc.) of any size with their types and sizes
- Position references to help identify messages in the conversation
- Statistics on potential token savings

**CRITICAL WARNINGS ABOUT FORGETTING**:

🚨 MULTI-STEP INSTRUCTIONS: If you are following instructions with multiple steps, DO NOT forget them until ALL steps are complete. Even if you "read them already," forgetting means you CANNOT continue the remaining steps.

🚨 ACTIVE WORK: If you're currently working on something that references this content, forgetting it will BREAK your ability to complete the task.

🚨 "I REMEMBER IT" IS A LIE: Your confidence that you remember something is meaningless. Once forgotten, you have ZERO memory of it.

QUESTIONS TO ASK BEFORE FORGETTING (be VERY conservative):
1. "Am I currently following multi-step instructions? If yes, DO NOT FORGET them."
2. "Will I need ANY information from this content for future steps in my current task?"
3. "Does this contain requirements, specifications, or instructions I haven't fully completed?"
4. "Is this related to ANY unresolved issue or ongoing work?"
5. "Could I possibly need to reference this content in the next few messages?"

SAFE TO FORGET (only these):
- Large file reads that are completely irrelevant to current and future tasks
- Old search results that have been fully processed and won't be needed again
- Completed subtasks with no remaining dependencies
- Truly redundant or duplicate information

NEVER FORGET:
- Multi-step instructions (until ALL steps are done)
- Code you're actively working on
- Requirements or specifications for incomplete tasks
- Error messages being debugged
- Context critical to current task
- Files needed for decision-making
- Anything you might need in the next several messages

Example workflow:
1. Use ${CONTEXT_INSPECT_TOOL_NAME} to see what can be forgotten
2. Use ${CONTEXT_FORGET_TOOL_NAME} with selected IDs (be VERY selective)
3. To access forgotten content again:
   - Use ${CONTEXT_RESTORE_TOOL_NAME} with ID
   - OR run the original command/read the file again

⚠️ IF IN DOUBT, DO NOT FORGET. Forgetting the wrong content will cause task failure and conversation breakdown.

Note: As your remaining context drops below 30%, you may need to forget content, the benefits of hiding a content increases, and you should be a little more prone in hiding unimportant information, but BE CAREFUL.`;

class ContextInspectToolInvocation extends BaseToolInvocation<{}, ToolResult> {
  constructor(
    params: {},
    messageBus?: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
    private readonly config?: Config,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    return 'Inspecting conversation history for forgettable content';
  }

  async execute(
    _signal: AbortSignal,
    _updateOutput?: (output: string) => void,
  ): Promise<ToolResult> {
    // Access history through GeminiClient
    let history: Content[] = [];

    try {
      if (this.config?.getGeminiClient) {
        const geminiClient = this.config.getGeminiClient();
        history = geminiClient.getHistory();
      }
    } catch (error) {
      // Fallback to global if available (for testing)
      history = (global as any).__contextManagementHistory || [];
    }
    const storage = ContextStorage.getInstance();

    if (!history || history.length === 0) {
      return {
        llmContent: 'No conversation history available to inspect.',
        returnDisplay: 'No conversation history available.',
      };
    }

    // Always backup the current history to ensure new content is captured
    // This ensures that content added after previous hide/unhide cycles is backed up
    storage.backupHistory(history, true);

    // Extract function responses and attachments
    const functionResponses = extractFunctionResponses(history);
    const attachments = extractAttachments(history);

    // Combine all forgettable items
    const forgettableItems = [...functionResponses, ...attachments];

    // Filter out already forgotten items
    const availableItems = forgettableItems.filter(item => !storage.isForgotten(item.id));

    // Filter out items that will be auto-forgotten anyway (saves tokens)
    const itemsToShow = availableItems.filter(item => !shouldAutoForget(item, history, storage));

    if (itemsToShow.length === 0) {
      const autoForgetCount = availableItems.length - itemsToShow.length;
      const message = autoForgetCount > 0
        ? `No manually forgettable content found. ${autoForgetCount} item(s) will be auto-forgotten (errors/failures/latest inspect output).`
        : 'No forgettable content found in the conversation history. All function responses and attachments may already be forgotten or there are no function responses or attachments to forget.';
      return {
        llmContent: message,
        returnDisplay: message,
      };
    }

    // Calculate statistics
    const totalCharacters = availableItems.reduce((sum, item) => sum + item.originalLength, 0);

    // Get current token usage
    let currentTokenCount = 0;
    let maxTokenLimit = 1_048_576; // Default
    let percentageUsed = 0;
    let percentageRemainingUntilCompact = 100;

    try {
      if (this.config?.getGeminiClient) {
        const geminiClient = this.config.getGeminiClient();
        currentTokenCount = geminiClient.getChat().getLastPromptTokenCount();
        const currentModel = this.config.getModel();
        maxTokenLimit = tokenLimit(currentModel);
        percentageUsed = Math.round((currentTokenCount / maxTokenLimit) * 100);

        // Get the actual compression threshold from config, or use default
        const compressionThreshold =
          (await this.config.getCompressionThreshold()) ?? DEFAULT_COMPRESSION_TOKEN_THRESHOLD;
        const compactTokenLimit = maxTokenLimit * compressionThreshold;
        const compressionThresholdPercentage = Math.round(compressionThreshold * 100);

        // Debug logging
        console.log(`[Context Inspector Debug]`);
        console.log(`  compressionThreshold: ${compressionThreshold} (${compressionThresholdPercentage}%)`);
        console.log(`  maxTokenLimit: ${maxTokenLimit}`);
        console.log(`  compactTokenLimit: ${compactTokenLimit}`);
        console.log(`  currentTokenCount: ${currentTokenCount}`);
        console.log(`  percentageUsed: ${percentageUsed}%`);

        // Calculate percentage remaining until compact as percentage of total model limit
        if (currentTokenCount < compactTokenLimit) {
          // This should be: (threshold% - used%) = remaining%
          percentageRemainingUntilCompact = compressionThresholdPercentage - percentageUsed;

          // Ensure it's not negative due to rounding
          if (percentageRemainingUntilCompact < 0) {
            percentageRemainingUntilCompact = 0;
          }
        } else {
          // Already past compact threshold
          percentageRemainingUntilCompact = 0;
        }

        console.log(`  percentageRemainingUntilCompact: ${percentageRemainingUntilCompact}%`);
        console.log(`  Sum check: ${percentageUsed}% + ${percentageRemainingUntilCompact}% = ${percentageUsed + percentageRemainingUntilCompact}% (should equal compression threshold ${compressionThresholdPercentage}%)`)
      }
    } catch (error) {
      // Fallback - use default values
    }

    const autoForgetCount = availableItems.length - itemsToShow.length;

    const result: InspectResult = {
      forgettableItems: itemsToShow,
      statistics: {
        totalForgettable: itemsToShow.length,
        currentTokenCount,
        percentageUsed,
        percentageRemainingUntilCompact
      }
    };

    // Format for LLM
    const llmOutput = `Found ${itemsToShow.length} forgettable items in the conversation:

${itemsToShow.map((item, index) =>
  `${index + 1}. ID: ${item.id}
   Type: ${item.type}
   Name: ${item.name}
   Size: ${item.originalLength} characters
   Preview: ${item.preview}
   Related to user request: ${item.messageBefore || 'N/A'}`
).join('\n\n')}

Current Context Statistics:
- Token usage: ${result.statistics.currentTokenCount.toLocaleString()} (${result.statistics.percentageUsed}% of model limit)
- Remaining until compact: ${result.statistics.percentageRemainingUntilCompact}%
- Total forgettable items: ${result.statistics.totalForgettable}${autoForgetCount > 0 ? `\n- Auto-forgettable items (not shown): ${autoForgetCount}` : ''}

⚠️ REMEMBER: Forgetting content = COMPLETE AMNESIA. You will be CLUELESS about it.
DO NOT forget instruction, specially multi-step, or anything needed for current/future tasks.

To forget items (be VERY selective), use ${CONTEXT_FORGET_TOOL_NAME} with the IDs and descriptions.${autoForgetCount > 0 ? `\n\nNote: ${autoForgetCount} item(s) will be auto-forgotten (errors/failures/latest inspect output) and are not shown above.` : ''}`;

    return {
      llmContent: llmOutput,
      returnDisplay: JSON.stringify(result, null, 2),
    };
  }
}

export class ContextInspectTool extends BaseDeclarativeTool<{}, ToolResult> {
  static readonly Name = CONTEXT_INSPECT_TOOL_NAME;

  constructor(private readonly config?: Config) {
    super(
      ContextInspectTool.Name,
      'Context Inspect',
      CONTEXT_INSPECT_DESCRIPTION,
      Kind.Other,
      {
        type: 'object',
        properties: {},
        required: []
      }
    );
  }

  protected createInvocation(
    params: {},
    _messageBus?: MessageBus,
    _toolName?: string,
    _displayName?: string,
  ): ToolInvocation<{}, ToolResult> {
    return new ContextInspectToolInvocation(
      params,
      _messageBus,
      _toolName,
      _displayName,
      this.config,
    );
  }
}

// ============================================
// Tool 2: Context Forget Tool
// ============================================

const CONTEXT_FORGET_DESCRIPTION = `⚠️ PERMANENTLY ERASES selected content from your LLM memory (complete amnesia).

🚨 CRITICAL: This is NOT "hiding" - this is FORGETTING. Once forgotten:
- You will have ZERO memory of this content
- You CANNOT recall ANY information from it
- It's as if you NEVER read it
- Your confidence in "remembering" will be an ILLUSION

After using ${CONTEXT_INSPECT_TOOL_NAME} to identify forgettable content, use this tool with EXTREME CAUTION.
Note: Only function responses larger than ${MIN_FORGETTABLE_RESPONSE_CHARS} characters appear as forgettable. Attachments are always forgettable regardless of size.

Each item to forget requires:
- id: The ID shown by ${CONTEXT_INSPECT_TOOL_NAME}
- description: A DETAILED summary in this exact format:

Summary: [2-3 paragraphs describing the ACTUAL CONTENT in detail. Include specific details like file paths, key findings, data structures, important values, decisions made, or requirements discovered. This summary is your ONLY record of what was here.]

Why forgetting is safe NOW: [Explain why you will NOT need this information for ANY future steps in the current task or upcoming tasks. Be BRUTALLY honest - if there's ANY chance you need it, DO NOT forget it.]

SPECIAL INSTRUCTION FOR AUDIO ATTACHMENTS:
When forgetting audio attachments, the Summary MUST include a detailed transcript summary of the audio content, including:
- Main topics discussed
- Key decisions or requirements mentioned
- Important details, names, or specifications stated
- Any action items or next steps mentioned

GOOD description examples:

1. For file/directory content:
"Summary: Directory listing of /src showing 15 TypeScript files including main.ts, config.ts, utils.ts, and several component files. Total of 4 subdirectories (components/, services/, types/, tests/). Shows file sizes ranging from 2KB to 45KB with most recent modifications from November 2024. The listing revealed the project follows a standard React/TypeScript structure with clear separation of concerns. Key files identified: main.ts (entry point), config.ts (app configuration), and 8 component files in components/ subdirectory.

Why forgetting is safe NOW: The directory structure exploration is complete. I have identified all relevant files and their purposes. No future steps require re-examining the directory listing. All files that need to be worked on have already been opened and are in context."

2. For audio attachments (MUST include detailed transcript summary):
"Summary: Audio file (3:45 duration) containing discussion about API design. Speaker outlined requirements for RESTful endpoints: GET /api/users for listing with pagination (limit/offset params), POST /api/users for creation requiring email and password fields, PUT /api/users/:id for updates, and DELETE /api/users/:id with soft-delete functionality. Emphasized need for JWT authentication on all endpoints except login/register. Mentioned rate limiting of 100 requests/minute per IP and requirement for OpenAPI documentation. Also discussed future webhook implementation for user events.

Why forgetting is safe NOW: All API requirements have been fully implemented in the codebase. The implementation is complete and tested. No remaining work requires referring back to the original audio requirements."

BAD description examples (DO NOT USE):
- "Directory listing of the current project. Already reviewed." ❌ (No actual details)
- "Content of README.md file" ❌ (No specific information about what was in it)
- "I already read this and remember it" ❌ (YOU WON'T REMEMBER - that's the point!)

IMPORTANT: The description must contain ACTUAL DETAILS from the content you're forgetting. This is your ONLY record. If you can't write detailed notes, you probably shouldn't forget it.

After execution, this tool automatically:
- Forgets the most recent ${CONTEXT_INSPECT_TOOL_NAME} output (since it's no longer needed)
- Forgets all failed/error/cancelled function calls
- Returns a summary of forgotten and failed items

⚠️ FINAL WARNING: If you're unsure whether to forget something, DO NOT FORGET IT. The consequences of forgetting active content are severe.`;

export interface ContextForgetParams {
  items: Array<{
    id: string;
    description: string;
  }>;
}

class ContextForgetToolInvocation extends BaseToolInvocation<ContextForgetParams, ToolResult> {
  constructor(
    params: ContextForgetParams,
    messageBus?: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
    private readonly config?: Config,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    const count = this.params.items?.length || 0;
    return `Forgetting ${count} item(s) from conversation history (permanent amnesia)`;
  }

  async execute(
    _signal: AbortSignal,
    _updateOutput?: (output: string) => void,
  ): Promise<ToolResult> {
    const storage = ContextStorage.getInstance();

    // Access history through GeminiClient
    let history: Content[] = [];
    try {
      if (this.config?.getGeminiClient) {
        const geminiClient = this.config.getGeminiClient();
        history = geminiClient.getHistory();
      }
    } catch (error) {
      // Fallback to global if available (for testing)
      history = (global as any).__contextManagementHistory || [];
    }

    if (!history || history.length === 0) {
      return {
        llmContent: 'No conversation history available to modify.',
        returnDisplay: 'No conversation history available.',
      };
    }

    // Backup current history state before modifications
    storage.backupHistory(history, false);

    const result: ForgetResult = {
      forgotten: [],
      failed: [],
      autoForgotten: []
    };

    // Validate that descriptions follow the structured format
    for (const item of this.params.items) {
      const desc = item.description.toLowerCase();
      if (!desc.includes('summary:')) {
        return {
          llmContent: `Error: Description for item ${item.id} is missing "Summary:" section. Please follow the structured format:\n\nSummary: [detailed content description with ACTUAL details]\n\nWhy forgetting is safe NOW: [why you will NOT need this for any future steps]`,
          returnDisplay: `Missing "Summary:" in description for ${item.id}`,
        };
      }
      if (!desc.includes('why forgetting is safe now:')) {
        return {
          llmContent: `Error: Description for item ${item.id} is missing "Why forgetting is safe NOW:" section. Please follow the structured format:\n\nSummary: [detailed content description with ACTUAL details]\n\nWhy forgetting is safe NOW: [why you will NOT need this for any future steps]`,
          returnDisplay: `Missing "Why forgetting is safe NOW:" in description for ${item.id}`,
        };
      }
    }

    // Process each item to forget
    for (const item of this.params.items) {
      if (storage.isForgotten(item.id)) {
        result.failed.push({
          id: item.id,
          reason: 'Already forgotten'
        });
        continue;
      }

      // Find and forget the content in history
      let found = false;
      for (let i = 0; i < history.length; i++) {
        const content = history[i];
        if (content.parts) {
          for (let j = 0; j < content.parts.length; j++) {
            const part = content.parts[j];
            if (part && typeof part === 'object') {
              // Handle functionResponse
              if ('functionResponse' in part && part.functionResponse) {
                if (part.functionResponse.id === item.id) {
                  // Store original content
                  const forgottenContent: ForgottenContent = {
                    id: item.id,
                    type: 'functionResponse',
                    originalContent: part.functionResponse,
                    description: item.description,
                    messagePosition: i,
                    toolName: part.functionResponse.name
                  };

                  storage.forget(item.id, forgottenContent);

                  // Replace with placeholder
                  const placeholder = createForgottenPlaceholder(
                    item.id,
                    'functionResponse',
                    item.description
                  );

                  // Modify the part to show it's forgotten
                  part.functionResponse.response = {
                    output: placeholder
                  };

                  result.forgotten.push({
                    id: item.id,
                    description: item.description
                  });

                  found = true;
                  break;
                }
              }
              // Handle attachments
              else if (item.id.startsWith('attachment-')) {
                // Check if this is an inlineData attachment
                if ('inlineData' in part && part.inlineData) {
                  const expectedInlinePattern = `attachment-inline-${i}-`;
                  if (item.id.startsWith(expectedInlinePattern)) {
                    // Store original content
                    const forgottenContent: ForgottenContent = {
                      id: item.id,
                      type: 'attachment',
                      originalContent: part,
                      description: item.description,
                      messagePosition: i
                    };

                    storage.forget(item.id, forgottenContent);

                    // Replace with placeholder
                    const placeholder = createForgottenPlaceholder(
                      item.id,
                      'attachment',
                      item.description
                    );

                    // Replace the entire part with a text placeholder
                    (history[i].parts as any)[j] = { text: placeholder };

                    result.forgotten.push({
                      id: item.id,
                      description: item.description
                    });

                    found = true;
                    break;
                  }
                }
                // Check if this is a fileData attachment
                else if ('fileData' in part && part.fileData) {
                  const expectedFilePattern = `attachment-file-${i}-`;
                  if (item.id.startsWith(expectedFilePattern)) {
                    // Store original content
                    const forgottenContent: ForgottenContent = {
                      id: item.id,
                      type: 'attachment',
                      originalContent: part,
                      description: item.description,
                      messagePosition: i
                    };

                    storage.forget(item.id, forgottenContent);

                    // Replace with placeholder
                    const placeholder = createForgottenPlaceholder(
                      item.id,
                      'attachment',
                      item.description
                    );

                    // Replace the entire part with a text placeholder
                    (history[i].parts as any)[j] = { text: placeholder };

                    result.forgotten.push({
                      id: item.id,
                      description: item.description
                    });

                    found = true;
                    break;
                  }
                }
              }
            }
          }
        }
        if (found) break;
      }

      if (!found) {
        result.failed.push({
          id: item.id,
          reason: 'Not found in history'
        });
      }
    }

    // Auto-forget the most recent context_inspect output if enabled
    if (AUTO_FORGET_INSPECT_AFTER_FORGET && result.forgotten.length > 0) {
      // Find the most recent context_inspect function response
      let foundInspect = false;
      for (let i = history.length - 1; i >= 0; i--) {
        const content = history[i];
        if (content.parts) {
          for (const part of content.parts) {
            if (part && typeof part === 'object' && 'functionResponse' in part && part.functionResponse) {
              const funcResponse = part.functionResponse!;

              // Check if this is a context_inspect response
              if (funcResponse.name === CONTEXT_INSPECT_TOOL_NAME) {
                const inspectId = funcResponse.id || `inspect-auto-${Date.now()}`;

                // Only forget if not already forgotten
                if (!storage.isForgotten(inspectId)) {
                  const forgottenContent: ForgottenContent = {
                    id: inspectId,
                    type: 'functionResponse',
                    originalContent: funcResponse,
                    description: 'Auto-forgotten context_inspect output (no longer needed after forgetting items)',
                    toolName: funcResponse.name
                  };

                  storage.forget(inspectId, forgottenContent);

                  // Replace with placeholder
                  funcResponse.response = {
                    output: createForgottenPlaceholder(
                      inspectId,
                      'functionResponse',
                      'Auto-forgotten context_inspect output'
                    )
                  };

                  result.autoForgotten.push(inspectId);
                }

                // Only forget the most recent one, then break
                foundInspect = true;
                break;
              }
            }
          }
        }
        // Break outer loop if we found and processed a context_inspect
        if (foundInspect) break;
      }
    }

    // Auto-forget failed/error/cancelled operations
    // We need to track which functionCalls we've already forgotten the args for
    const forgottenCallSignatures = new Set<string>();

    for (let i = 0; i < history.length; i++) {
      const content = history[i];
      if (content.parts) {
        for (const part of content.parts) {
          if (part && typeof part === 'object' && 'functionResponse' in part && part.functionResponse) {
            const funcResponse = part.functionResponse!;

            // Proper error detection: check if response.error exists (not output string search)
            // When tools fail, they have response.error instead of response.output
            if (funcResponse.response && 'error' in funcResponse.response) {
              const id = funcResponse.id || `auto-${Date.now()}`;

              if (!storage.isForgotten(id)) {
                const forgottenContent: ForgottenContent = {
                  id,
                  type: 'functionResponse',
                  originalContent: funcResponse,
                  description: 'Auto-forgotten error/failure/cancellation',
                  toolName: funcResponse.name
                };

                storage.forget(id, forgottenContent);

                // Replace with placeholder
                funcResponse.response = {
                  output: createForgottenPlaceholder(
                    id,
                    'functionResponse',
                    'Auto-forgotten error/failure/cancellation'
                  )
                };

                result.autoForgotten.push(id);

                // Also find and forget the corresponding functionCall args
                // Look backwards from current position to find the matching functionCall
                const toolName = funcResponse.name;
                const callSignature = `${toolName}-${i}`; // Use message index to avoid double-processing

                if (toolName && !forgottenCallSignatures.has(callSignature)) {
                  // Search backwards from the current message
                  for (let j = i - 1; j >= 0 && j >= i - 5; j--) { // Only look back 5 messages
                    const prevContent = history[j];
                    if (prevContent.parts) {
                      for (const prevPart of prevContent.parts) {
                        if (prevPart && typeof prevPart === 'object' && 'functionCall' in prevPart && prevPart.functionCall) {
                          const funcCall = prevPart.functionCall;

                          // Match by tool name
                          if (funcCall.name === toolName) {
                            // Store original args if they exist and are not already forgotten
                            if (funcCall.args && !funcCall.args.forgotten) {
                              // Replace args with minimal placeholder
                              funcCall.args = { forgotten: true };
                              forgottenCallSignatures.add(callSignature);
                              // console.log(`Auto-forgotten functionCall args for ${toolName}`);
                            }

                            // Found the matching call, stop searching
                            break;
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // Update the history in GeminiClient
    try {
      if (this.config?.getGeminiClient) {
        const geminiClient = this.config.getGeminiClient();
        geminiClient.setHistory(history);
      }
    } catch (error) {
      // Fallback to global for testing
      (global as any).__contextManagementHistory = history;
    }

    // Format result for LLM
    const inspectAutoForgotten = result.autoForgotten.filter(id =>
      storage.get(id)?.toolName === CONTEXT_INSPECT_TOOL_NAME
    );
    const errorAutoForgotten = result.autoForgotten.filter(id =>
      storage.get(id)?.toolName !== CONTEXT_INSPECT_TOOL_NAME
    );

    const llmOutput = `Context forgetting completed:

⚠️ YOU NOW HAVE AMNESIA ABOUT THE FORGOTTEN CONTENT ⚠️

Successfully forgotten: ${result.forgotten.length} item(s)
${result.forgotten.map(h => `- ${h.id}\n  ${h.description.split('\n').join('\n  ')}`).join('\n\n')}

Failed to forget: ${result.failed.length} item(s)
${result.failed.map(f => `- ${f.id}: ${f.reason}`).join('\n')}

${inspectAutoForgotten.length > 0 ? `Auto-forgotten context_inspect output: ${inspectAutoForgotten.length} item(s)
${inspectAutoForgotten.map(id => `- ${id}`).join('\n')}

` : ''}${errorAutoForgotten.length > 0 ? `Auto-forgotten errors/failures: ${errorAutoForgotten.length} item(s)
${errorAutoForgotten.map(id => `- ${id}`).join('\n')}

` : ''}⚠️ IMPORTANT: You have ZERO memory of the forgotten content. Do not pretend to remember it.

Forgotten content can be accessed again by either:
- Using ${CONTEXT_RESTORE_TOOL_NAME} with the appropriate IDs
- OR simply running the original command/reading the file again`;

    // Create display version with descriptions for user visibility (truncated)
    const displayResult = {
      forgotten: result.forgotten.map(h => {
        // Extract summary text (remove "Summary:" prefix and trim)
        let summary = h.description;
        const summaryMatch = h.description.match(/Summary:\s*(.+?)(?:\n\n|$)/s);
        if (summaryMatch) {
          summary = summaryMatch[1].trim();
        }

        return {
          id: h.id,
          description: summary.length > 100
            ? `${summary.substring(0, 100)}...`
            : summary
        };
      }),
      failed: result.failed,
      autoForgotten: result.autoForgotten
    };

    return {
      llmContent: llmOutput,
      returnDisplay: JSON.stringify(displayResult, null, 2),
    };
  }
}

export class ContextForgetTool extends BaseDeclarativeTool<ContextForgetParams, ToolResult> {
  static readonly Name = CONTEXT_FORGET_TOOL_NAME;

  constructor(private readonly config?: Config) {
    super(
      ContextForgetTool.Name,
      'Context Forget',
      CONTEXT_FORGET_DESCRIPTION,
      Kind.Other,
      {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'List of items to FORGET (PERMANENT AMNESIA) with their IDs and detailed descriptions',
            items: {
              type: 'object',
              properties: {
                id: {
                  type: 'string',
                  description: 'The ID from context_inspect'
                },
                description: {
                  type: 'string',
                  description: 'DETAILED description with: 1) Summary: [actual content details], 2) Why forgetting is safe NOW: [why you will NOT need this for future steps]. Example: "Summary: package.json content with dependencies: react@18.2.0, typescript@5.0.0, 15 other packages. DevDependencies include jest, eslint. No peer dependency conflicts.\n\nWhy forgetting is safe NOW: All dependencies installed successfully. No version conflicts detected. Not working on dependency management tasks."'
                }
              },
              required: ['id', 'description']
            }
          }
        },
        required: ['items']
      }
    );
  }

  protected validateToolParamValues(params: ContextForgetParams): string | null {
    if (!params.items || !Array.isArray(params.items)) {
      return 'items must be an array';
    }

    if (params.items.length === 0) {
      return 'At least one item must be provided to forget';
    }

    for (const item of params.items) {
      if (!item.id || typeof item.id !== 'string') {
        return 'Each item must have a valid id';
      }
      if (!item.description || typeof item.description !== 'string') {
        return 'Each item must have a description';
      }
    }

    return null;
  }

  protected createInvocation(
    params: ContextForgetParams,
    _messageBus?: MessageBus,
    _toolName?: string,
    _displayName?: string,
  ): ToolInvocation<ContextForgetParams, ToolResult> {
    return new ContextForgetToolInvocation(
      params,
      _messageBus,
      _toolName,
      _displayName,
      this.config,
    );
  }
}

// ============================================
// Tool 3: Context Restore Tool
// ============================================

const CONTEXT_RESTORE_DESCRIPTION = `Restores previously forgotten function responses or attachments to the conversation history.

Use this when you need to access content that was previously forgotten with ${CONTEXT_FORGET_TOOL_NAME}.

⚠️ IMPORTANT: After restoration, you will be able to access the content again, but you should RE-READ it carefully since you had complete amnesia about it.

Note: You can also simply run the original command or read the file again instead of using this tool. This tool is useful when you want to restore the exact previous output without re-running commands.

The forgotten placeholders contain descriptions with:
- Summary: What the content contained
- Why forgetting was safe: Why it was forgotten

Review these descriptions to decide what needs to be restored.

Provide an array of IDs to restore. The IDs are shown in the forgotten message placeholders.

Returns:
- List of successfully restored items
- List of items that couldn't be restored (with reasons)`;

export interface ContextRestoreParams {
  ids: string[];
}

class ContextRestoreToolInvocation extends BaseToolInvocation<ContextRestoreParams, ToolResult> {
  constructor(
    params: ContextRestoreParams,
    messageBus?: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
    private readonly config?: Config,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    const count = this.params.ids?.length || 0;
    return `Restoring ${count} forgotten item(s) to conversation history`;
  }

  async execute(
    _signal: AbortSignal,
    _updateOutput?: (output: string) => void,
  ): Promise<ToolResult> {
    const storage = ContextStorage.getInstance();

    // Access history through GeminiClient
    let history: Content[] = [];
    try {
      if (this.config?.getGeminiClient) {
        const geminiClient = this.config.getGeminiClient();
        history = geminiClient.getHistory();
      }
    } catch (error) {
      // Fallback to global if available (for testing)
      history = (global as any).__contextManagementHistory || [];
    }

    if (!history || history.length === 0) {
      return {
        llmContent: 'No conversation history available to restore to.',
        returnDisplay: 'No conversation history available.',
      };
    }

    const result: RestoreResult = {
      restored: [],
      failed: []
    };

    // Process each ID to restore
    for (const id of this.params.ids) {
      // Check if the ID is actually forgotten
      if (!storage.isForgotten(id)) {
        result.failed.push({
          id,
          reason: 'Not currently forgotten (may have already been restored)'
        });
        continue;
      }

      // Find the original content from the backup
      const backupData = storage.findInBackup(id);

      if (!backupData) {
        result.failed.push({
          id,
          reason: 'Original content not found in backup'
        });
        continue;
      }

      // Find the current position in the modified history
      let restored = false;

      // First, try to find by the placeholder text
      for (let i = 0; i < history.length; i++) {
        const content = history[i];
        if (content.parts) {
          for (let j = 0; j < content.parts.length; j++) {
            const part = content.parts[j];
            if (part && typeof part === 'object') {
              // Check for functionResponse placeholder
              if ('functionResponse' in part && part.functionResponse) {
                const output = part.functionResponse.response?.output || '';
                if (typeof output === 'string' && output.includes(`ID: ${id}`)) {
                  // Found the placeholder, restore the original content
                  const restoredContent = JSON.parse(JSON.stringify(backupData.content));
                  content.parts[j] = { functionResponse: restoredContent };

                  // Remove from storage since it's now restored
                  storage.restore(id);
                  result.restored.push(id);
                  restored = true;
                  break;
                }
              }
              // Check for text placeholder (used for attachments)
              else if ('text' in part && part.text) {
                if (typeof part.text === 'string' && part.text.includes(`ID: ${id}`)) {
                  // Found the placeholder, restore the original attachment part
                  const restoredContent = JSON.parse(JSON.stringify(backupData.content));
                  content.parts[j] = restoredContent;

                  // Remove from storage since it's now restored
                  storage.restore(id);
                  result.restored.push(id);
                  restored = true;
                  break;
                }
              }
            }
          }
        }
        if (restored) break;
      }

      // If not found by placeholder, try by position
      if (!restored && backupData.position) {
        const { messageIndex, partIndex } = backupData.position;
        if (history[messageIndex]?.parts?.[partIndex]) {
          const part = history[messageIndex].parts[partIndex];

          // Check if this position has a hidden placeholder
          if (part && typeof part === 'object') {
            // Handle functionResponse
            if ('functionResponse' in part) {
              const restoredContent = JSON.parse(JSON.stringify(backupData.content));
              history[messageIndex].parts[partIndex] = { functionResponse: restoredContent };

              // Remove from storage
              storage.restore(id);
              result.restored.push(id);
              restored = true;
            }
            // Handle text placeholder (for attachments)
            else if ('text' in part && part.text && typeof part.text === 'string' && part.text.includes('[CONTENT FORGOTTEN')) {
              const restoredContent = JSON.parse(JSON.stringify(backupData.content));
              history[messageIndex].parts[partIndex] = restoredContent;

              // Remove from storage
              storage.restore(id);
              result.restored.push(id);
              restored = true;
            }
          }
        }
      }

      if (!restored) {
        result.failed.push({
          id,
          reason: 'Could not locate placeholder in current history'
        });
      }
    }

    // Update the history in GeminiClient
    try {
      if (this.config?.getGeminiClient) {
        const geminiClient = this.config.getGeminiClient();
        geminiClient.setHistory(history);
      }
    } catch (error) {
      // Fallback to global for testing
      (global as any).__contextManagementHistory = history;
    }

    // Get details of restored items for better feedback
    const restoredDetails = result.restored.map(id => {
      // Since the item was just removed from storage after successful restoration,
      // we can't get details from storage anymore, just show the ID
      return `- ${id}: Successfully restored to conversation history`;
    });

    // Format result for LLM
    const llmOutput = `Context restoration completed:

Successfully restored: ${result.restored.length} item(s)
${restoredDetails.join('\n')}

Failed to restore: ${result.failed.length} item(s)
${result.failed.map(f => `- ${f.id}: ${f.reason}`).join('\n')}

${result.restored.length > 0 ?
`✅ AMNESIA CLEARED: The forgotten content has been successfully restored to your context.
You now have FULL ACCESS to this content and can remember it clearly.
The content is back in the conversation history and you can reference, analyze, and use it normally.
Your previous amnesia about this content is GONE - you can now work with it as if it was never forgotten.` :
`No items were restored. Check that the IDs are correct and that the items were previously forgotten.`}`;

    return {
      llmContent: llmOutput,
      returnDisplay: JSON.stringify(result, null, 2),
    };
  }
}

export class ContextRestoreTool extends BaseDeclarativeTool<ContextRestoreParams, ToolResult> {
  static readonly Name = CONTEXT_RESTORE_TOOL_NAME;

  constructor(private readonly config?: Config) {
    super(
      ContextRestoreTool.Name,
      'Context Restore',
      CONTEXT_RESTORE_DESCRIPTION,
      Kind.Other,
      {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            description: 'List of IDs to restore from forgotten state',
            items: {
              type: 'string',
              description: 'ID of the forgotten content to restore (you had complete amnesia about this)'
            }
          }
        },
        required: ['ids']
      }
    );
  }

  protected validateToolParamValues(params: ContextRestoreParams): string | null {
    if (!params.ids || !Array.isArray(params.ids)) {
      return 'ids must be an array';
    }

    if (params.ids.length === 0) {
      return 'At least one ID must be provided to restore';
    }

    for (const id of params.ids) {
      if (!id || typeof id !== 'string') {
        return 'Each ID must be a valid string';
      }
    }

    return null;
  }

  protected createInvocation(
    params: ContextRestoreParams,
    _messageBus?: MessageBus,
    _toolName?: string,
    _displayName?: string,
  ): ToolInvocation<ContextRestoreParams, ToolResult> {
    return new ContextRestoreToolInvocation(
      params,
      _messageBus,
      _toolName,
      _displayName,
      this.config,
    );
  }
}

/**
 * Clears all context management backups and forgotten content storage.
 * Should be called when starting a new conversation (e.g., /clear command).
 */
export function clearContextBackups(): void {
  ContextStorage.getInstance().clearAll();
}

/**
 * Gets the ContextStorage singleton instance.
 * Used for accessing context management state for persistence operations.
 */
export function getContextStorage(): ContextStorage {
  return ContextStorage.getInstance();
}