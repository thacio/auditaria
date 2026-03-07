/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_DISCORD_FEATURE: This entire file is part of the Discord integration

import { DISCORD_MAX_MESSAGE_LENGTH } from './types.js';

/**
 * Splits text into chunks that fit within Discord's message limit.
 * Prefers splitting at paragraph boundaries (blank lines), then line boundaries.
 * Preserves code block integrity when possible.
 */
export function chunkText(
  text: string,
  maxLength: number = DISCORD_MAX_MESSAGE_LENGTH - 100,
): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a paragraph boundary (blank line)
    let splitIndex = remaining.lastIndexOf('\n\n', maxLength);

    // If no paragraph boundary, try line boundary
    if (splitIndex <= 0 || splitIndex < maxLength * 0.3) {
      splitIndex = remaining.lastIndexOf('\n', maxLength);
    }

    // If no line boundary, force split at maxLength
    if (splitIndex <= 0 || splitIndex < maxLength * 0.3) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Formats a complete response for Discord delivery.
 * Discord supports Markdown natively, so no conversion is needed.
 * Just chunks the text to fit within the message limit.
 */
export function formatResponse(text: string, chunkLimit?: number): string[] {
  return chunkText(text, chunkLimit);
}

/**
 * Formats a tool call notification for the user.
 */
export function formatToolCall(toolName: string): string {
  const friendlyNames: Record<string, string> = {
    read_file: 'Reading file',
    write_file: 'Writing file',
    edit: 'Editing file',
    shell: 'Running command',
    glob: 'Searching files',
    grep: 'Searching content',
    web_search: 'Searching web',
    web_fetch: 'Fetching URL',
    knowledge_search: 'Searching knowledge base',
    knowledge_index: 'Indexing knowledge base',
    browser_agent: 'Browser automation',
    memory: 'Updating memory',
    ls: 'Listing directory',
  };

  const friendly = friendlyNames[toolName] || `Running ${toolName}`;
  return `*${friendly}...*`;
}

/**
 * Formats an error message for Discord.
 */
export function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `**Error:** ${message}\n\nUse /new to reset the session.`;
}
