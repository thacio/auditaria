/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_REWIND_FEATURE: Claude session browsing and resume support

import { join } from 'node:path';
import { homedir } from 'node:os';
import { readdir, stat, open } from 'node:fs/promises';

/**
 * Derives the Claude project directory hash from a working directory path.
 * Claude replaces : \ / with - and strips leading separators.
 * E.g., "C:\projects\auditaria" → "C--projects-auditaria"
 *
 * Shared by ClaudeFileCheckpointAdapter and this module.
 */
export function getClaudeProjectDirHash(cwd: string): string {
  return cwd.replace(/[:\\/]/g, '-').replace(/^-+/, '');
}

/**
 * Metadata for a Claude session, extracted via lite loading.
 */
export interface ClaudeSessionInfo {
  sessionId: string;
  firstPrompt: string;
  timestamp: Date;
  fileSize: number;
  filePath: string;
}

/**
 * Extracts a JSON string field value from raw text without JSON.parse.
 * Scans for "key":"value" or "key": "value" patterns.
 * Handles escaped quotes within values.
 */
export function extractFieldFromText(
  text: string,
  key: string,
): string | undefined {
  const patterns = [`"${key}":"`, `"${key}": "`];
  for (const pattern of patterns) {
    const idx = text.indexOf(pattern);
    if (idx < 0) continue;
    const valueStart = idx + pattern.length;
    let i = valueStart;
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2; // Skip escaped character
        continue;
      }
      if (text[i] === '"') {
        // Unescape basic JSON escapes
        return text
          .slice(valueStart, i)
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
      i++;
    }
  }
  return undefined;
}

const HEAD_READ_SIZE = 8192; // 8KB — enough for first prompt and session metadata

/**
 * Lists Claude sessions for the current project, sorted by most recent first.
 * Uses lite loading: stat for sorting, then read first 8KB for metadata.
 */
export async function listClaudeSessions(
  cwd: string,
  limit: number = 20,
): Promise<ClaudeSessionInfo[]> {
  const projectDirHash = getClaudeProjectDirHash(cwd);
  const sessionsDir = join(homedir(), '.claude', 'projects', projectDirHash);

  // 1. List .jsonl files
  let files: string[];
  try {
    files = (await readdir(sessionsDir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return []; // Directory doesn't exist
  }

  if (files.length === 0) return [];

  // 2. Stat all files, sort by mtime descending (most recent first)
  const entries = await Promise.all(
    files.map(async (f) => {
      const fullPath = join(sessionsDir, f);
      try {
        const s = await stat(fullPath);
        return { file: f, path: fullPath, mtime: s.mtimeMs, size: s.size };
      } catch {
        return null;
      }
    }),
  );
  const valid = entries
    .filter(
      (e): e is { file: string; path: string; mtime: number; size: number } =>
        e !== null && e.size > 100, // Skip tiny/empty files
    )
    .sort((a, b) => b.mtime - a.mtime);

  // 3. For top N, read head to extract metadata
  const results: ClaudeSessionInfo[] = [];

  for (const entry of valid.slice(0, limit)) {
    try {
      const fd = await open(entry.path, 'r');
      try {
        const buf = Buffer.alloc(HEAD_READ_SIZE);
        const { bytesRead } = await fd.read(buf, 0, HEAD_READ_SIZE, 0);
        const head = buf.toString('utf-8', 0, bytesRead);

        const sessionId = entry.file.replace('.jsonl', '');

        // Extract first prompt from queue-operation enqueue entry
        // Pattern: {"type":"queue-operation","operation":"enqueue",...,"content":"..."}
        let firstPrompt: string | undefined;
        const enqueueIdx = head.indexOf('"operation":"enqueue"');
        if (enqueueIdx >= 0) {
          // Find the content field near this enqueue operation
          const searchFrom = Math.max(0, enqueueIdx - 200);
          const enqueueBlock = head.slice(
            searchFrom,
            Math.min(head.length, enqueueIdx + 500),
          );
          firstPrompt = extractFieldFromText(enqueueBlock, 'content');
        }

        // Fallback: try lastPrompt or direct content extraction
        if (!firstPrompt) {
          firstPrompt = extractFieldFromText(head, 'content');
        }

        // Skip if prompt looks like system context
        if (
          firstPrompt?.startsWith('<session_context>') ||
          firstPrompt?.startsWith('<auditaria_conversation_history>')
        ) {
          // Try to find the next enqueue
          const secondEnqueueIdx = head.indexOf(
            '"operation":"enqueue"',
            enqueueIdx + 20,
          );
          if (secondEnqueueIdx >= 0) {
            const block2 = head.slice(
              secondEnqueueIdx - 200,
              secondEnqueueIdx + 500,
            );
            firstPrompt = extractFieldFromText(block2, 'content');
          }
        }

        const timestamp = extractFieldFromText(head, 'timestamp');

        results.push({
          sessionId,
          firstPrompt: (firstPrompt || '(no prompt)').slice(0, 200),
          timestamp: timestamp ? new Date(timestamp) : new Date(entry.mtime),
          fileSize: entry.size,
          filePath: entry.path,
        });
      } finally {
        await fd.close();
      }
    } catch {
      // Skip files we can't read
    }
  }

  return results;
}

/**
 * Builds a conversation summary from a Claude JSONL file.
 * Extracts user prompts and assistant text responses, skipping tool calls
 * and system context messages.
 *
 * Returns a summary string suitable for injection into mirrored history.
 */
export async function buildClaudeSessionSummary(
  jsonlPath: string,
): Promise<string | null> {
  let data: string;
  try {
    const { readFile } = await import('node:fs/promises');
    data = await readFile(jsonlPath, 'utf-8');
  } catch {
    return null;
  }

  const lines = data.split('\n').filter(Boolean);
  const turns: Array<{ role: string; text: string }> = [];

  for (const line of lines) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Claude JSONL format
      const entry = JSON.parse(line) as Record<string, unknown>;

      // Skip non-message entries
      if (
        entry.type === 'queue-operation' ||
        entry.type === 'file-history-snapshot' ||
        entry.type === 'last-prompt'
      ) {
        continue;
      }

      const message = entry.message as
        | { role?: string; content?: unknown }
        | undefined;
      if (!message?.role) continue;

      // Extract text content
      let text = '';
      if (typeof message.content === 'string') {
        text = message.content;
      } else if (Array.isArray(message.content)) {
        const textBlocks = (
          message.content as Array<{ type?: string; text?: string }>
        )
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text || '');
        text = textBlocks.join('\n');
      }

      if (!text) continue;

      // Skip system context messages
      if (
        text.startsWith('<session_context>') ||
        text.startsWith('<auditaria_conversation_history>')
      ) {
        continue;
      }

      // Skip tool_result user messages (they contain tool output, not user prompts)
      if (
        Array.isArray(message.content) &&
        (message.content as Array<{ type?: string }>).some(
          (b) => b.type === 'tool_result',
        )
      ) {
        continue;
      }

      if (message.role === 'user') {
        turns.push({ role: 'User', text: text.slice(0, 500) });
      } else if (message.role === 'assistant') {
        turns.push({ role: 'Assistant', text: text.slice(0, 500) });
      }
    } catch {
      // Skip malformed lines
    }
  }

  if (turns.length === 0) return null;

  const summary = turns
    .map((t) => `${t.role}: ${t.text}`)
    .join('\n\n');

  return `<previous_conversation_summary>\n${summary}\n</previous_conversation_summary>`;
}

/**
 * Validates that a session ID exists as a JSONL file for the given project.
 */
export async function validateClaudeSessionId(
  cwd: string,
  sessionId: string,
): Promise<{ valid: boolean; filePath: string }> {
  const projectDirHash = getClaudeProjectDirHash(cwd);
  const filePath = join(
    homedir(),
    '.claude',
    'projects',
    projectDirHash,
    `${sessionId}.jsonl`,
  );
  try {
    await stat(filePath);
    return { valid: true, filePath };
  } catch {
    return { valid: false, filePath };
  }
}
