/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_AGENT_SESSION: Discovery of stored CLI sessions on disk.
// Scans the provider-specific session directories (Claude: ~/.claude/projects/,
// Codex: ~/.codex/sessions/) and returns previews the LLM can use to find a
// session ID to resume via the external_agent_session tool.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type DiscoverableProvider = 'claude' | 'codex';

export interface SessionPreview {
  provider: DiscoverableProvider;
  nativeSessionId: string;
  /** Best-effort human label: customTitle / aiTitle / first prompt. */
  title?: string;
  firstPrompt?: string;
  lastPrompt?: string;
  /** Working directory the session was created in. */
  cwd?: string;
  gitBranch?: string;
  /** When the session file was last touched (ms epoch). */
  modifiedAt: number;
  /** When the session started, if extractable (ms epoch). */
  createdAt?: number;
  /** Number of JSONL lines in the file (rough activity proxy). */
  entries?: number;
  /** Path to the underlying JSONL file (for debugging — not for the LLM to use directly). */
  filePath?: string;
}

export interface DiscoverOptions {
  /** Provider to scan. Omit to scan all supported providers. */
  provider?: DiscoverableProvider;
  /** When false (default) scan only sessions whose cwd matches the current cwd. */
  allProjects?: boolean;
  /** Maximum entries returned per provider, sorted newest first. Default: 20. */
  limit?: number;
  /** Case-insensitive substring filter applied to title/first/last prompt. */
  query?: string;
}

/** Public entry: scan one or all providers. */
export async function discoverSessions(
  currentCwd: string,
  opts: DiscoverOptions = {},
): Promise<SessionPreview[]> {
  const providers: DiscoverableProvider[] = opts.provider
    ? [opts.provider]
    : ['claude', 'codex'];

  const results: SessionPreview[] = [];
  for (const p of providers) {
    if (p === 'claude') {
      results.push(...(await discoverClaudeSessions(currentCwd, opts)));
    } else if (p === 'codex') {
      results.push(...(await discoverCodexSessions(currentCwd, opts)));
    }
  }

  const filtered = applyQueryFilter(results, opts.query);
  filtered.sort((a, b) => b.modifiedAt - a.modifiedAt);

  const limit = opts.limit && opts.limit > 0 ? opts.limit : 20;
  return filtered.slice(0, limit);
}

// -------------------------------------------------------------------
// Claude session discovery
// -------------------------------------------------------------------

/**
 * Replicates Claude's path sanitization (sessionStoragePortable.ts):
 * replace any non-alphanumeric character with '-'. Truncation+hash for paths
 * over 200 chars is omitted because typical user cwds stay well under the limit.
 */
function claudeSanitizePath(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

function claudeProjectsRoot(): string {
  const override = process.env['CLAUDE_CONFIG_DIR'];
  return override
    ? join(override, 'projects')
    : join(homedir(), '.claude', 'projects');
}

async function discoverClaudeSessions(
  currentCwd: string,
  opts: DiscoverOptions,
): Promise<SessionPreview[]> {
  const root = claudeProjectsRoot();

  let projectDirs: string[];
  if (opts.allProjects) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      projectDirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => join(root, e.name));
    } catch {
      return [];
    }
  } else {
    projectDirs = [join(root, claudeSanitizePath(currentCwd))];
  }

  const previews: SessionPreview[] = [];
  for (const dir of projectDirs) {
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const sessionId = name.slice(0, -6);
      if (!isUuid(sessionId)) continue;
      const filePath = join(dir, name);
      const preview = await readClaudePreview(filePath, sessionId);
      if (preview) previews.push(preview);
    }
  }
  return previews;
}

async function readClaudePreview(
  filePath: string,
  sessionId: string,
): Promise<SessionPreview | null> {
  let stat: { mtimeMs: number; size: number };
  try {
    const s = await fs.stat(filePath);
    stat = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }

  // Read head + tail bounded windows — JSONL files can be many MB.
  const { head, tail } = await readHeadTail(filePath, stat.size, 64 * 1024);

  // Skip sidechain (visual /resume parity).
  if (
    /"isSidechain"\s*:\s*true/.test(head.slice(0, 8 * 1024)) ||
    /"teamName"\s*:/.test(head.slice(0, 8 * 1024))
  ) {
    return null;
  }

  const customTitle =
    extractLastJsonString(tail, 'customTitle') ||
    extractLastJsonString(tail, 'aiTitle') ||
    extractLastJsonString(head, 'aiTitle');
  const lastPrompt =
    extractLastJsonString(tail, 'lastPrompt') ||
    extractLastJsonString(tail, 'summary');
  const firstPrompt = extractFirstUserPromptFromClaudeHead(head);
  const cwd = extractJsonString(head, 'cwd');
  const gitBranch =
    extractLastJsonString(tail, 'gitBranch') ||
    extractJsonString(head, 'gitBranch');
  const firstTimestamp = extractJsonString(head, 'timestamp');

  // Skip metadata-only files (no title, no prompt) — matches Claude's filter.
  if (!customTitle && !firstPrompt && !lastPrompt) return null;

  let createdAt: number | undefined;
  if (firstTimestamp) {
    const parsed = Date.parse(firstTimestamp);
    if (!Number.isNaN(parsed)) createdAt = parsed;
  }

  // Cheap line count via head only is wrong — but stat-based estimate is good enough.
  // Use the head buffer's newline density when the file fits, else mark undefined.
  const entries =
    stat.size <= 64 * 1024
      ? head.split('\n').filter((l) => l.length > 0).length
      : undefined;

  return {
    provider: 'claude',
    nativeSessionId: sessionId,
    title: customTitle || firstPrompt,
    firstPrompt,
    lastPrompt,
    cwd,
    gitBranch,
    modifiedAt: stat.mtimeMs,
    createdAt,
    entries,
    filePath,
  };
}

/**
 * Walk the head buffer looking for the first {"type":"user", ...} entry and
 * extract its message content. Strips leading XML context wrappers that
 * Auditaria / Claude inject (e.g. <auditaria_conversation_history>...).
 */
interface ClaudeUserEntry {
  type?: string;
  isSidechain?: boolean;
  message?: {
    content?: string | Array<{ type?: string; text?: string }>;
  };
}

function extractFirstUserPromptFromClaudeHead(
  head: string,
): string | undefined {
  const lines = head.split('\n');
  for (const line of lines) {
    if (!line.startsWith('{') || !line.includes('"type":"user"')) continue;
    try {
      const obj = parseJsonAs<ClaudeUserEntry>(line);
      if (obj.type !== 'user') continue;
      if (obj.isSidechain) return undefined;
      const content = obj.message?.content;
      let text: string | undefined;
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        const block = content.find(
          (c) => c && c.type === 'text' && typeof c.text === 'string',
        );
        text = block?.text;
      }
      if (!text) continue;
      if (text.startsWith('[Request interrupted')) continue;
      const stripped = stripLeadingContextTags(text);
      if (!stripped) continue;
      return stripped.length > 200 ? stripped.slice(0, 200) + '…' : stripped;
    } catch {
      // Line might be truncated at the head boundary — keep scanning.
    }
  }
  return undefined;
}

// -------------------------------------------------------------------
// Codex session discovery
// -------------------------------------------------------------------

function codexSessionsRoot(): string {
  const override = process.env['CODEX_HOME'];
  return override
    ? join(override, 'sessions')
    : join(homedir(), '.codex', 'sessions');
}

async function discoverCodexSessions(
  currentCwd: string,
  opts: DiscoverOptions,
): Promise<SessionPreview[]> {
  const root = codexSessionsRoot();

  // Codex layout: <root>/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl
  // Scan only the most recent N day-directories to keep this cheap.
  const candidates = await collectCodexJsonlFiles(root, opts.limit ?? 20);
  if (candidates.length === 0) return [];

  const previews: SessionPreview[] = [];
  const normalizedCwd = currentCwd.toLowerCase();
  for (const filePath of candidates) {
    const preview = await readCodexPreview(filePath);
    if (!preview) continue;
    if (!opts.allProjects && preview.cwd) {
      if (preview.cwd.toLowerCase() !== normalizedCwd) continue;
    }
    previews.push(preview);
  }
  return previews;
}

/**
 * Walk YYYY/MM/DD subdirectories newest-first, collecting jsonl files until we
 * have at least `wantedAtLeast * 4` candidates (over-collect so post-cwd
 * filtering still has enough). Stops at 500 to bound cost.
 */
async function collectCodexJsonlFiles(
  root: string,
  wantedAtLeast: number,
): Promise<string[]> {
  const target = Math.min(500, Math.max(20, wantedAtLeast * 4));
  const out: string[] = [];

  let years: string[];
  try {
    years = (await fs.readdir(root)).filter((n) => /^\d{4}$/.test(n));
  } catch {
    return [];
  }
  years.sort().reverse();
  for (const y of years) {
    let months: string[];
    try {
      months = (await fs.readdir(join(root, y))).filter((n) =>
        /^\d{2}$/.test(n),
      );
    } catch {
      continue;
    }
    months.sort().reverse();
    for (const m of months) {
      let days: string[];
      try {
        days = (await fs.readdir(join(root, y, m))).filter((n) =>
          /^\d{2}$/.test(n),
        );
      } catch {
        continue;
      }
      days.sort().reverse();
      for (const d of days) {
        const dayDir = join(root, y, m, d);
        let files: string[];
        try {
          files = await fs.readdir(dayDir);
        } catch {
          continue;
        }
        files.sort().reverse();
        for (const f of files) {
          if (f.endsWith('.jsonl')) out.push(join(dayDir, f));
          if (out.length >= target) return out;
        }
      }
    }
  }
  return out;
}

async function readCodexPreview(
  filePath: string,
): Promise<SessionPreview | null> {
  let stat: { mtimeMs: number; size: number };
  try {
    const s = await fs.stat(filePath);
    stat = { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }

  const { head, tail } = await readHeadTail(filePath, stat.size, 64 * 1024);

  // session_meta is always the first line.
  let threadId: string | undefined;
  let cwd: string | undefined;
  let createdAt: number | undefined;
  let timestamp: string | undefined;
  let gitBranch: string | undefined;
  const firstLineEnd = head.indexOf('\n');
  if (firstLineEnd > 0) {
    try {
      const meta = parseJsonAs<CodexSessionMeta>(head.slice(0, firstLineEnd));
      const payload = meta.payload ?? meta; // older format had fields at top-level
      threadId = payload.id;
      cwd = payload.cwd;
      timestamp = payload.timestamp ?? meta.timestamp;
      // git only exists on the new (payload-wrapped) format.
      gitBranch = meta.payload?.git?.branch;
      if (timestamp) {
        const parsed = Date.parse(timestamp);
        if (!Number.isNaN(parsed)) createdAt = parsed;
      }
    } catch {
      /* ignore */
    }
  }

  if (!threadId) {
    // Fallback: parse the filename — rollout-<ts>-<uuid>.jsonl
    const m = filePath.match(/rollout-[^/\\]+-([0-9a-f-]+)\.jsonl$/i);
    threadId = m?.[1];
  }
  if (!threadId || !isUuid(threadId)) return null;

  const firstPrompt = extractFirstUserPromptFromCodex(head);
  const lastPrompt = extractLastUserPromptFromCodex(tail);

  return {
    provider: 'codex',
    nativeSessionId: threadId,
    title: firstPrompt,
    firstPrompt,
    lastPrompt,
    cwd,
    gitBranch,
    modifiedAt: stat.mtimeMs,
    createdAt,
    filePath,
  };
}

function extractFirstUserPromptFromCodex(head: string): string | undefined {
  return findUserMessageInCodexLines(head.split('\n'), 'first');
}

function extractLastUserPromptFromCodex(tail: string): string | undefined {
  return findUserMessageInCodexLines(tail.split('\n'), 'last');
}

interface CodexSessionMeta {
  payload?: {
    id?: string;
    cwd?: string;
    timestamp?: string;
    git?: { branch?: string };
  };
  // Older format inlined the fields at the top level.
  id?: string;
  cwd?: string;
  timestamp?: string;
}

interface CodexUserEntry {
  type?: string;
  role?: string;
  content?: Array<{ text?: string }>;
  payload?: {
    type?: string;
    role?: string;
    content?: Array<{ text?: string }>;
  };
}

function findUserMessageInCodexLines(
  lines: string[],
  pick: 'first' | 'last',
): string | undefined {
  const range = pick === 'first' ? lines : [...lines].reverse();
  for (const line of range) {
    if (!line.startsWith('{') || !line.includes('"role":"user"')) continue;
    try {
      const obj = parseJsonAs<CodexUserEntry>(line);
      // Newer format wraps under {type: 'response_item', payload: {...}};
      // older format puts the message at the top level.
      const payload = obj.payload ?? obj;
      if (payload.type !== 'message' || payload.role !== 'user') continue;
      const content = payload.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        const text = c?.text;
        if (!text) continue;
        const stripped = stripLeadingContextTags(text);
        if (!stripped) continue;
        return stripped.length > 200 ? stripped.slice(0, 200) + '…' : stripped;
      }
    } catch {
      /* ignore truncated/malformed lines */
    }
  }
  return undefined;
}

// -------------------------------------------------------------------
// Shared helpers
// -------------------------------------------------------------------

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean {
  return UUID_REGEX.test(s);
}

/**
 * `JSON.parse` returns `any`, which trips no-unsafe-type-assertion at every
 * call site. We trust the on-disk JSONL schema (and every caller is inside a
 * try/catch that drops malformed lines), so a single localized suppression is
 * cleaner than per-call type guards.
 */
function parseJsonAs<T>(raw: string): T {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return JSON.parse(raw) as T;
}

/**
 * Strip leading XML context blocks injected by Auditaria / Claude / Codex so
 * the discovery preview shows the user's real first prompt instead of a
 * conversation-history dump.
 *
 * Examples of wrappers we eat:
 *   <auditaria_conversation_history>...</auditaria_conversation_history>
 *   <environment_context>...</environment_context>
 *   <user_instructions>...</user_instructions>
 *   <system-reminder>...</system-reminder>
 *
 * Returns the trimmed remainder, or undefined if nothing meaningful is left.
 */
const CONTEXT_TAG_REGEX = /^<([a-z][a-z0-9_-]*)\b[^>]*>/i;
function stripLeadingContextTags(text: string): string | undefined {
  let s = text.trim();
  // Eat at most 8 wrappers — defensive bound against pathological inputs.
  for (let i = 0; i < 8 && s.startsWith('<'); i++) {
    const m = s.match(CONTEXT_TAG_REGEX);
    if (!m) break;
    const tag = m[1];
    const end = `</${tag}>`;
    const endIdx = s.indexOf(end);
    if (endIdx < 0) break;
    s = s.slice(endIdx + end.length).trim();
  }
  return s.length > 0 ? s : undefined;
}

function applyQueryFilter(
  items: SessionPreview[],
  query: string | undefined,
): SessionPreview[] {
  if (!query) return items;
  const needle = query.toLowerCase();
  return items.filter((p) => {
    const hay = [p.title, p.firstPrompt, p.lastPrompt]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(needle);
  });
}

/** Read first `bufSize` and last `bufSize` bytes of `filePath` as utf-8. */
async function readHeadTail(
  filePath: string,
  fileSize: number,
  bufSize: number,
): Promise<{ head: string; tail: string }> {
  if (fileSize <= bufSize * 2) {
    try {
      const full = await fs.readFile(filePath, { encoding: 'utf-8' });
      return { head: full, tail: full };
    } catch {
      return { head: '', tail: '' };
    }
  }
  let handle: import('node:fs/promises').FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const headBuf = Buffer.alloc(bufSize);
    const tailBuf = Buffer.alloc(bufSize);
    await handle.read(headBuf, 0, bufSize, 0);
    await handle.read(tailBuf, 0, bufSize, fileSize - bufSize);
    return {
      head: headBuf.toString('utf-8'),
      tail: tailBuf.toString('utf-8'),
    };
  } catch {
    return { head: '', tail: '' };
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

/**
 * Extract the first `"key":"value"` occurrence from `text` without full JSON parsing.
 * Mirrors Claude's sessionStoragePortable.ts so we can scan partial buffers.
 */
function extractJsonString(text: string, key: string): string | undefined {
  for (const pattern of [`"${key}":"`, `"${key}": "`]) {
    const idx = text.indexOf(pattern);
    if (idx < 0) continue;
    const valueStart = idx + pattern.length;
    let i = valueStart;
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2;
        continue;
      }
      if (text[i] === '"') {
        return unescapeJsonString(text.slice(valueStart, i));
      }
      i++;
    }
  }
  return undefined;
}

function extractLastJsonString(text: string, key: string): string | undefined {
  let last: string | undefined;
  for (const pattern of [`"${key}":"`, `"${key}": "`]) {
    let from = 0;
    while (true) {
      const idx = text.indexOf(pattern, from);
      if (idx < 0) break;
      const valueStart = idx + pattern.length;
      let i = valueStart;
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          last = unescapeJsonString(text.slice(valueStart, i));
          break;
        }
        i++;
      }
      from = idx + pattern.length;
    }
  }
  return last;
}

function unescapeJsonString(raw: string): string {
  if (!raw.includes('\\')) return raw;
  try {
    return parseJsonAs<string>(`"${raw}"`);
  } catch {
    return raw;
  }
}
