// AUDITARIA_SESSION_MANAGEMENT: Unified session registry for mapping external conversation
// contexts (Teams threads, Telegram chats, etc.) to provider-native session IDs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from '../utils/paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionRecord {
  /** External context identifier (Teams threadId, Telegram chatId, "cli-main") */
  contextId: string;

  /** Context type for namespacing */
  contextType: string;

  /** Provider that owns this session */
  provider: string;

  /** Provider's native session ID (Claude session_id, Codex thread_id, etc.) */
  nativeSessionId: string;

  /** Model used in this session */
  model?: string;

  /** Session lifecycle state */
  state: 'active' | 'suspended';

  /** Timestamps (epoch ms) */
  createdAt: number;
  lastActiveAt: number;

  /** For Gemini: path to saved history JSON file */
  historyFile?: string;
}

interface RegistryFile {
  version: number;
  sessions: Record<string, SessionRecord>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REGISTRY_VERSION = 1;
const PERSIST_DEBOUNCE_MS = 5_000;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// SessionRegistry
// ---------------------------------------------------------------------------

export class SessionRegistry {
  private sessions = new Map<string, SessionRecord>();
  private readonly persistPath: string;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private dirty = false;

  constructor(basePath?: string) {
    const base = basePath ?? join(homedir(), '.auditaria');
    this.persistPath = join(base, 'session-registry.json');
  }

  // --- Key helpers ---

  private key(contextType: string, contextId: string): string {
    return `${contextType}:${contextId}`;
  }

  // --- Lookup ---

  lookup(contextType: string, contextId: string): SessionRecord | null {
    return this.sessions.get(this.key(contextType, contextId)) ?? null;
  }

  lookupByNativeId(
    provider: string,
    nativeSessionId: string,
  ): SessionRecord | null {
    for (const record of this.sessions.values()) {
      if (
        record.provider === provider &&
        record.nativeSessionId === nativeSessionId
      ) {
        return record;
      }
    }
    return null;
  }

  // --- CRUD ---

  save(record: SessionRecord): void {
    this.sessions.set(this.key(record.contextType, record.contextId), record);
    this.schedulePersist();
  }

  update(
    contextType: string,
    contextId: string,
    patch: Partial<SessionRecord>,
  ): void {
    const k = this.key(contextType, contextId);
    const existing = this.sessions.get(k);
    if (!existing) return;
    Object.assign(existing, patch);
    this.schedulePersist();
  }

  delete(contextType: string, contextId: string): void {
    if (this.sessions.delete(this.key(contextType, contextId))) {
      this.schedulePersist();
    }
  }

  // --- Lifecycle ---

  getActiveCount(provider?: string): number {
    let count = 0;
    for (const r of this.sessions.values()) {
      if (r.state === 'active' && (!provider || r.provider === provider))
        count++;
    }
    return count;
  }

  getActiveSessions(provider?: string): SessionRecord[] {
    const result: SessionRecord[] = [];
    for (const r of this.sessions.values()) {
      if (r.state === 'active' && (!provider || r.provider === provider)) {
        result.push(r);
      }
    }
    return result;
  }

  suspend(contextType: string, contextId: string): void {
    this.update(contextType, contextId, { state: 'suspended' });
  }

  activate(contextType: string, contextId: string): void {
    this.update(contextType, contextId, {
      state: 'active',
      lastActiveAt: Date.now(),
    });
  }

  /** Returns the least-recently-used active session for the given provider (or any). */
  getLRU(provider?: string): SessionRecord | null {
    let oldest: SessionRecord | null = null;
    for (const r of this.sessions.values()) {
      if (r.state !== 'active') continue;
      if (provider && r.provider !== provider) continue;
      if (!oldest || r.lastActiveAt < oldest.lastActiveAt) {
        oldest = r;
      }
    }
    return oldest;
  }

  // --- Persistence ---

  load(): void {
    try {
      if (!existsSync(this.persistPath)) return;
      const raw = readFileSync(this.persistPath, 'utf-8');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON structure validated by version check below
      const data = JSON.parse(raw) as RegistryFile;
      if (data.version !== REGISTRY_VERSION) return; // incompatible — start fresh
      this.sessions.clear();
      for (const [key, record] of Object.entries(data.sessions)) {
        this.sessions.set(key, record);
      }
    } catch {
      // Corrupt file — start fresh
      this.sessions.clear();
    }
  }

  persist(): void {
    this.clearPersistTimer();
    const data: RegistryFile = {
      version: REGISTRY_VERSION,
      sessions: Object.fromEntries(this.sessions),
    };
    try {
      const dir = this.persistPath.replace(/[/\\][^/\\]+$/, '');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // Best-effort — don't crash on write failure
    }
    this.dirty = false;
  }

  /**
   * Remove sessions older than maxAge (default 24h).
   * Returns count of removed entries.
   */
  cleanup(maxAge: number = DEFAULT_MAX_AGE_MS): number {
    const cutoff = Date.now() - maxAge;
    let removed = 0;
    for (const [key, record] of this.sessions) {
      if (record.lastActiveAt < cutoff) {
        this.sessions.delete(key);
        removed++;
      }
    }
    if (removed > 0) this.schedulePersist();
    return removed;
  }

  /** Returns total number of tracked sessions. */
  get size(): number {
    return this.sessions.size;
  }

  // --- Disposal ---

  dispose(): void {
    if (this.dirty) this.persist();
    this.clearPersistTimer();
  }

  // --- Internal ---

  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) return; // already scheduled
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  private clearPersistTimer(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
  }
}
