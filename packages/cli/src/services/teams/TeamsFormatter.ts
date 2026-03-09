/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_TEAMS_FEATURE: This entire file is part of the Teams integration

import { INCOMING_WEBHOOK_MAX_SIZE } from './types.js';

/**
 * Max text length for a single Teams message.
 * Incoming webhooks have a 28KB payload limit; we leave margin for JSON wrapper.
 */
const TEAMS_MAX_TEXT_LENGTH = INCOMING_WEBHOOK_MAX_SIZE - 1000;

/**
 * Splits text into chunks that fit within Teams' message limit.
 * Prefers splitting at paragraph boundaries, then line boundaries.
 */
export function chunkText(
  text: string,
  maxLength: number = TEAMS_MAX_TEXT_LENGTH,
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

    // Force split at maxLength if nothing found
    if (splitIndex <= 0 || splitIndex < maxLength * 0.3) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Converts Markdown to Teams-compatible HTML.
 *
 * Teams messages support a subset of HTML: bold, italic, code, pre,
 * lists (ul/ol/li), links, headings, blockquotes, br.
 */
export function markdownToTeamsHtml(md: string): string {
  let html = md;

  // Code blocks (``` ... ```) — must be before inline transforms
  html = html.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_match, _lang: string, code: string) => `<pre>${escapeHtml(code.trimEnd())}</pre>`,
  );

  // Inline code (`...`)
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Horizontal rules (---, ***, ___) — must be before header/bold transforms
  html = html.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, '<hr>');

  // Headers (## ... ) — convert to bold (Teams renders <h> tags poorly in replies)
  html = html.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Bold (**...**)
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  // Italic (*...*)
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');

  // Blockquotes (> ...)
  html = html.replace(/^>\s?(.+)$/gm, '<blockquote>$1</blockquote>');
  // Merge consecutive blockquotes
  html = html.replace(/<\/blockquote>\n<blockquote>/g, '\n');

  // Unordered lists (- item or * item)
  html = html.replace(
    /(?:^|\n)((?:[-*]\s+.+\n?)+)/g,
    (_match, block: string) => {
      const items = block
        .trim()
        .split('\n')
        .map((line: string) => `<li>${line.replace(/^[-*]\s+/, '')}</li>`)
        .join('');
      return `\n<ul>${items}</ul>\n`;
    },
  );

  // Ordered lists (1. item)
  html = html.replace(
    /(?:^|\n)((?:\d+\.\s+.+\n?)+)/g,
    (_match, block: string) => {
      const items = block
        .trim()
        .split('\n')
        .map((line: string) => `<li>${line.replace(/^\d+\.\s+/, '')}</li>`)
        .join('');
      return `\n<ol>${items}</ol>\n`;
    },
  );

  // Tables ( | col | col | )
  html = html.replace(
    /(?:^|\n)((?:\|.+\|\s*\n)*\|.+\|\s*$)/gm,
    (_match, block: string) => {
      const rows = block.trim().split('\n').filter((r: string) => r.trim());
      // Detect separator row (|---|---|) — every cell is only dashes/colons/spaces
      const isSeparator = (row: string) =>
        row.split('|').slice(1, -1).every((cell: string) => /^[\s:?-]+$/.test(cell));
      const parseRow = (row: string) =>
        row.split('|').slice(1, -1).map((c: string) => c.trim());

      let tableHtml = '<table>';
      const hasHeader = rows.length >= 2 && isSeparator(rows[1]!);

      for (let i = 0; i < rows.length; i++) {
        if (isSeparator(rows[i]!)) continue;
        const cells = parseRow(rows[i]!);
        const tag = hasHeader && i === 0 ? 'th' : 'td';
        tableHtml += '<tr>' + cells.map((c) => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
      }
      tableHtml += '</table>';
      return '\n' + tableHtml + '\n';
    },
  );

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Line breaks — double newline to <br><br>, single to <br>
  html = html.replace(/\n\n/g, '<br><br>');
  html = html.replace(/\n/g, '<br>');

  return html.trim();
}

/** Escapes HTML special characters inside code blocks. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Formats a response for Teams delivery.
 * Converts Markdown to Teams HTML, then chunks if needed.
 */
export function formatResponse(text: string, chunkLimit?: number): string[] {
  // Strip # from #auditaria to prevent re-triggering the keyword flow
  const sanitized = text.replace(/#auditaria/gi, 'auditaria');
  const html = markdownToTeamsHtml(sanitized);
  return chunkText(html, chunkLimit);
}

/**
 * Formats a tool call notification.
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
  return `<em>${friendly}...</em>`;
}

/**
 * Formats an error message for Teams.
 */
export function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `<b>Error:</b> ${escapeHtml(message)}`;
}

/**
 * Creates a labeled async response that includes thread context.
 * Used in 'labeled-async' response mode.
 */
export function formatLabeledResponse(
  text: string,
  userName: string,
  originalMessage: string,
): string {
  const preview =
    originalMessage.length > 50
      ? originalMessage.slice(0, 50) + '...'
      : originalMessage;
  return `[Re: @${userName} - "${preview}"]\n\n${text}`;
}
