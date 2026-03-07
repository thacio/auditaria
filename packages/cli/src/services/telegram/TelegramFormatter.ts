/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_TELEGRAM_FEATURE: This entire file is part of the Telegram integration

import { TELEGRAM_MAX_MESSAGE_LENGTH } from './types.js';

/**
 * Escapes special HTML characters for Telegram's HTML parse mode.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Converts basic Markdown to Telegram-safe HTML.
 *
 * Handles: bold, italic, code (inline + blocks), links, strikethrough.
 * Telegram uses a subset of HTML: <b>, <i>, <code>, <pre>, <a>, <s>.
 */
export function markdownToTelegramHtml(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeBlockContent: string[] = [];

  for (const line of lines) {
    // Code block start/end
    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        // End code block
        const content = escapeHtml(codeBlockContent.join('\n'));
        if (codeBlockLang) {
          result.push(
            `<pre><code class="language-${escapeHtml(codeBlockLang)}">${content}</code></pre>`,
          );
        } else {
          result.push(`<pre>${content}</pre>`);
        }
        inCodeBlock = false;
        codeBlockContent = [];
        codeBlockLang = '';
      } else {
        // Start code block
        inCodeBlock = true;
        codeBlockLang = line.trimStart().slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    // Process inline formatting
    let processed = escapeHtml(line);

    // Inline code (must be before bold/italic to avoid conflicts)
    processed = processed.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold: **text** or __text__
    processed = processed.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    processed = processed.replace(/__(.+?)__/g, '<b>$1</b>');

    // Italic: *text* or _text_ (but not inside words with underscores)
    processed = processed.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<i>$1</i>');
    processed = processed.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '<i>$1</i>');

    // Strikethrough: ~~text~~
    processed = processed.replace(/~~(.+?)~~/g, '<s>$1</s>');

    // Links: [text](url)
    processed = processed.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2">$1</a>',
    );

    // Headers: # text -> bold
    processed = processed.replace(/^#{1,6}\s+(.+)$/, '<b>$1</b>');

    result.push(processed);
  }

  // Handle unclosed code block
  if (inCodeBlock && codeBlockContent.length > 0) {
    const content = escapeHtml(codeBlockContent.join('\n'));
    result.push(`<pre>${content}</pre>`);
  }

  return result.join('\n');
}

/**
 * Splits text into chunks that fit within Telegram's message limit.
 * Prefers splitting at paragraph boundaries (blank lines), then line boundaries.
 * Preserves code block integrity when possible.
 */
export function chunkText(
  text: string,
  maxLength: number = TELEGRAM_MAX_MESSAGE_LENGTH - 100,
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
 * Formats a complete response for Telegram delivery.
 * Converts Markdown to HTML and splits into chunks.
 */
export function formatResponse(text: string, chunkLimit?: number): string[] {
  const html = markdownToTelegramHtml(text);
  return chunkText(html, chunkLimit);
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
  return `<i>${escapeHtml(friendly)}...</i>`;
}

/**
 * Formats an error message for Telegram.
 */
export function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `<b>Error:</b> ${escapeHtml(message)}\n\nUse /new to reset the session.`;
}
