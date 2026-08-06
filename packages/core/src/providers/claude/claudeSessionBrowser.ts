/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_REWIND_FEATURE: Claude session browsing and resume support

import { join } from 'node:path';
import { homedir } from 'node:os';
import { readdir, stat, open } from 'node:fs/promises';
import { isLocalCommandNoise } from './claudeSessionLoader.js';

/**
 * Derives the Claude project directory hash from a working directory path.
 * Claude Code replaces EVERY character outside `[A-Za-z0-9_-]` with `-`, so
 * drive colons, path separators, spaces, AND non-ASCII characters
 * (diacritics, CJK, etc.) all collapse to single dashes.
 *
 * Empirically verified against on-disk `~/.claude/projects/` entries:
 *   "C:\projects\auditaria"
 *     → "C--projects-auditaria"
 *   "C:\Users\thaci\OneDrive - Tribunal de Contas da União\Teams-Galileu"
 *     → "C--Users-thaci-OneDrive---Tribunal-de-Contas-da-Uni-o-Teams-Galileu"
 *
 * The narrower `[:\\/]` regex we shipped originally missed spaces and
 * diacritics, which silently broke /resume-claude (and the live
 * provider's background hook watcher) for any project under OneDrive,
 * "Program Files", or any path with accented characters.
 *
 * Shared by ClaudeFileCheckpointAdapter, claudeCLIDriver (transcript
 * path), and this module — keep them on this single function so they
 * can't drift again.
 */
export function getClaudeProjectDirHash(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+/, '');
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

const SCAN_CHUNK_SIZE = 65536; // 64KB per read
const MAX_SCAN_BYTES = 2 * 1024 * 1024; // stop scanning after 2MB — previews only

/** True for text that shouldn't be shown as a session preview (injected context / command bookkeeping). */
function isNonConversationalPreviewText(text: string): boolean {
  return (
    text.startsWith('<session_context>') ||
    text.startsWith('<auditaria_conversation_history>') ||
    // Claude-injected abort marker (e.g. "[Request interrupted by user]"),
    // not something the user typed — skip in previews, keep in loaded history.
    text.startsWith('[Request interrupted by user') ||
    isLocalCommandNoise(text)
  );
}

/**
 * Extract a genuine user prompt from one parsed JSONL entry, or undefined.
 * Accepts `user` messages (string or text blocks) and queued prompts
 * (`queue-operation` enqueue); rejects meta/sidechain entries, tool results,
 * injected context, and local-command bookkeeping.
 */
function extractPromptFromEntry(
  entry: Record<string, unknown>,
): string | undefined {
  if (entry['isMeta'] === true || entry['isSidechain'] === true) {
    return undefined;
  }
  const type = entry['type'];

  if (type === 'queue-operation') {
    const content = entry['content'];
    if (entry['operation'] === 'enqueue' && typeof content === 'string') {
      const t = content.trim();
      if (t && !isNonConversationalPreviewText(t)) return t;
    }
    return undefined;
  }

  if (type !== 'user') return undefined;
  const message = entry['message'];
  if (!message || typeof message !== 'object') return undefined;
  const { role, content } = message as { role?: unknown; content?: unknown };
  if (role !== 'user') return undefined;

  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Claude JSONL content block shape
    const blocks = content as Array<Record<string, unknown> | null>;
    // Tool-result user messages carry tool output, not user prompts.
    if (blocks.some((b) => b?.['type'] === 'tool_result')) return undefined;
    text = blocks
      .map((b) => (b && b['type'] === 'text' ? b['text'] : undefined))
      .filter((t): t is string => typeof t === 'string')
      .join('\n');
  }
  text = text.trim();
  if (!text || isNonConversationalPreviewText(text)) return undefined;
  return text;
}

/** Extract the first assistant text block from a parsed entry, or undefined. */
function extractAssistantTextFromEntry(
  entry: Record<string, unknown>,
): string | undefined {
  if (entry['isMeta'] === true || entry['isSidechain'] === true) {
    return undefined;
  }
  if (entry['type'] !== 'assistant') return undefined;
  const message = entry['message'];
  if (!message || typeof message !== 'object') return undefined;
  const { content } = message as { content?: unknown };
  if (!Array.isArray(content)) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Claude JSONL content block shape
  for (const block of content as Array<Record<string, unknown> | null>) {
    if (block && block['type'] === 'text') {
      const t = block['text'];
      if (typeof t === 'string' && t.trim()) return t.trim();
    }
  }
  return undefined;
}

const TAIL_SCAN_BYTES = 131072; // 128KB — ai-title entries repeat; last one is current

/**
 * Read the tail of the file and return the LAST ai-title entry, if any.
 * Claude Code appends `{"type":"ai-title","aiTitle":"..."}` lines whenever it
 * (re)generates the conversation title — the most recent one is the name shown
 * in Claude Code's own /resume picker.
 */
async function readLastAiTitle(
  fd: Awaited<ReturnType<typeof open>>,
  fileSize: number,
): Promise<string | undefined> {
  const start = Math.max(0, fileSize - TAIL_SCAN_BYTES);
  const len = fileSize - start;
  if (len <= 0) return undefined;
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fd.read(buf, 0, len, start);
  const lines = buf.toString('utf-8', 0, bytesRead).split('\n');
  // Walk backwards — the first (possibly truncated) line just fails to parse.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"ai-title"')) continue;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Claude JSONL entry
      const entry = JSON.parse(line) as Record<string, unknown>;
      const title = entry['aiTitle'];
      if (
        entry['type'] === 'ai-title' &&
        typeof title === 'string' &&
        title.trim()
      ) {
        return title.trim();
      }
    } catch {
      // Truncated or malformed line — keep walking.
    }
  }
  return undefined;
}

/**
 * Extract preview metadata from a session JSONL. Preference order:
 *   1. Claude Code's conversation title (last ai-title entry, tail scan)
 *   2. The first genuine user prompt (head scan, up to MAX_SCAN_BYTES)
 *   3. An ai-title seen during the head scan (large files whose last title
 *      write happens to sit outside the tail window)
 *   4. The first assistant text (sessions with only slash commands / aborts)
 * Slash-command records themselves are never shown — they're bookkeeping the
 * user won't recognize a conversation by.
 */
async function scanSessionForPreview(
  filePath: string,
  fileSize: number,
): Promise<{ firstPrompt?: string; timestamp?: string }> {
  let fd;
  try {
    fd = await open(filePath, 'r');
  } catch {
    return {};
  }
  try {
    const title = await readLastAiTitle(fd, fileSize);

    const chunk = Buffer.alloc(SCAN_CHUNK_SIZE);
    let position = 0;
    let leftover = '';
    let timestamp: string | undefined;
    let headTitle: string | undefined;
    let assistantText: string | undefined;

    const scanLine = (line: string): string | undefined => {
      if (!line.trim()) return undefined;
      let entry: Record<string, unknown>;
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Claude JSONL entry
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return undefined;
      }
      const ts = entry['timestamp'];
      if (!timestamp && typeof ts === 'string') {
        timestamp = ts;
      }
      if (!headTitle && entry['type'] === 'ai-title') {
        const t = entry['aiTitle'];
        if (typeof t === 'string' && t.trim()) headTitle = t.trim();
      }
      if (!assistantText) {
        assistantText = extractAssistantTextFromEntry(entry);
      }
      return extractPromptFromEntry(entry);
    };

    let prompt: string | undefined;
    scan: while (position < MAX_SCAN_BYTES) {
      const { bytesRead } = await fd.read(chunk, 0, SCAN_CHUNK_SIZE, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      const lines = (leftover + chunk.toString('utf-8', 0, bytesRead)).split(
        '\n',
      );
      leftover = lines.pop() ?? '';
      for (const line of lines) {
        prompt = scanLine(line);
        if (prompt) break scan;
        // With a title already in hand, the head scan only needs the
        // timestamp — no reason to churn through megabytes of JSONL.
        if (title && timestamp) break scan;
      }
    }
    // Final (possibly newline-unterminated) line, if we reached end-of-file.
    if (!prompt && position < MAX_SCAN_BYTES && leftover) {
      prompt = scanLine(leftover);
    }

    return {
      firstPrompt: title ?? prompt ?? headTitle ?? assistantText,
      timestamp,
    };
  } catch {
    return {};
  } finally {
    await fd.close();
  }
}

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

  // 3. For top N, scan the file head for the first genuine user prompt
  const results: ClaudeSessionInfo[] = [];

  for (const entry of valid.slice(0, limit)) {
    const { firstPrompt, timestamp } = await scanSessionForPreview(
      entry.path,
      entry.size,
    );
    results.push({
      sessionId: entry.file.replace('.jsonl', ''),
      firstPrompt: (firstPrompt || '(no prompt)').slice(0, 200),
      timestamp: timestamp ? new Date(timestamp) : new Date(entry.mtime),
      fileSize: entry.size,
      filePath: entry.path,
    });
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

      const rawMessage = entry.message;
      if (!rawMessage || typeof rawMessage !== 'object') continue;
      const { role, content } = rawMessage as {
        role?: unknown;
        content?: unknown;
      };
      if (!role) continue;

      // Extract text content
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Claude JSONL content block shape
        const blocks = content as Array<Record<string, unknown> | null>;
        // Skip tool_result user messages (they contain tool output, not user prompts)
        if (blocks.some((b) => b?.['type'] === 'tool_result')) continue;
        text = blocks
          .map((b) => (b && b['type'] === 'text' ? b['text'] : undefined))
          .filter((t): t is string => typeof t === 'string')
          .join('\n');
      }

      if (!text) continue;

      // Skip system context messages and local-command bookkeeping
      if (
        text.startsWith('<session_context>') ||
        text.startsWith('<auditaria_conversation_history>') ||
        isLocalCommandNoise(text)
      ) {
        continue;
      }

      if (role === 'user') {
        turns.push({ role: 'User', text: text.slice(0, 500) });
      } else if (role === 'assistant') {
        turns.push({ role: 'Assistant', text: text.slice(0, 500) });
      }
    } catch {
      // Skip malformed lines
    }
  }

  if (turns.length === 0) return null;

  const summary = turns.map((t) => `${t.role}: ${t.text}`).join('\n\n');

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
