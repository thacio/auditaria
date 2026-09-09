/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_CODEX_PROVIDER: Project-scoped discovery of native Codex sessions.
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ExternalSessionInfo } from '../externalSession.js';
import { isPlainObject } from '../terminal/turnObserver.js';
import {
  codexMessageParts,
  isCodexContextText,
  readCodexSessionEntries,
} from './codexSessionLoader.js';

export type CodexSessionInfo = ExternalSessionInfo;
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function projectPath(cwd: string): string {
  const path = resolve(cwd)
    .replace(/^\\\\\?\\/, '')
    .replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

async function* rolloutFiles(directory: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isPlainObject(error) && error['code'] === 'ENOENT') return;
    // Error instances aren't plain objects.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* rolloutFiles(path);
    else if (
      entry.isFile() &&
      entry.name.startsWith('rollout-') &&
      entry.name.endsWith('.jsonl')
    )
      yield path;
  }
}

async function sessionInfo(
  filePath: string,
  cwd: string,
  preview: boolean,
): Promise<CodexSessionInfo | undefined> {
  let sessionId: string | undefined;
  let firstPrompt = '(no prompt)';
  let scanned = 0;
  try {
    for await (const entry of readCodexSessionEntries(filePath)) {
      const payload = entry['payload'];
      if (!isPlainObject(payload)) continue;
      if (entry['type'] === 'session_meta') {
        const id = payload['id'] ?? payload['session_id'];
        const project = payload['cwd'];
        if (
          typeof id !== 'string' ||
          !SESSION_ID.test(id) ||
          typeof project !== 'string' ||
          projectPath(project) !== projectPath(cwd)
        )
          return undefined;
        // Subagents have their own rollouts but aren't user conversations.
        if (isPlainObject(payload['source']) && 'subagent' in payload['source'])
          return undefined;
        sessionId = id;
        if (!preview) break;
      }
      if (
        entry['type'] === 'response_item' &&
        payload['type'] === 'message' &&
        payload['role'] === 'user'
      ) {
        const text = codexMessageParts(payload['content'])
          .map((p) => p.text ?? '')
          .filter((t) => !isCodexContextText(t))
          .join('\n')
          .trim();
        if (text && !text.startsWith('<turn_aborted>')) {
          firstPrompt = text.slice(0, 200);
          break;
        }
      }
      // Preview reads are bounded; history loading streams the entire file.
      scanned += JSON.stringify(entry).length;
      if (scanned > 2 * 1024 * 1024) break;
    }
    if (!sessionId) return undefined;
    const info = await stat(filePath);
    return {
      sessionId,
      firstPrompt,
      timestamp: info.mtime,
      fileSize: info.size,
      filePath,
    };
  } catch {
    // A session may be moved or removed while the picker is being populated.
    return undefined;
  }
}

export async function listCodexSessions(
  cwd: string,
  limit = 20,
): Promise<CodexSessionInfo[]> {
  if (limit <= 0) return [];
  const sessions: CodexSessionInfo[] = [];
  const files: string[] = [];
  for await (const file of rolloutFiles(
    join(process.env['CODEX_HOME'] || join(homedir(), '.codex'), 'sessions'),
  )) {
    files.push(file);
  }
  // Bound open handles while avoiding thousands of serial metadata reads.
  for (let i = 0; i < files.length; i += 32) {
    const batch = await Promise.all(
      files.slice(i, i + 32).map((file) => sessionInfo(file, cwd, false)),
    );
    for (const info of batch) if (info) sessions.push(info);
  }
  sessions.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return Promise.all(
    sessions
      .slice(0, limit)
      .map(async (s) => (await sessionInfo(s.filePath, cwd, true)) ?? s),
  );
}

export async function validateCodexSessionId(
  cwd: string,
  sessionId: string,
  codexHome = process.env['CODEX_HOME'] || join(homedir(), '.codex'),
): Promise<{ valid: boolean; filePath: string }> {
  if (SESSION_ID.test(sessionId)) {
    for await (const filePath of rolloutFiles(join(codexHome, 'sessions'))) {
      if (!filePath.toLowerCase().endsWith(`-${sessionId.toLowerCase()}.jsonl`))
        continue;
      const info = await sessionInfo(filePath, cwd, false);
      if (info?.sessionId.toLowerCase() === sessionId.toLowerCase())
        return { valid: true, filePath };
    }
  }
  return { valid: false, filePath: '' };
}
