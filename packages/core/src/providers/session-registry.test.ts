// AUDITARIA_SESSION_MANAGEMENT: Unit tests for SessionRegistry

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionRegistry, type SessionRecord } from './session-registry.js';

function makeTmpDir(): string {
  const dir = join(
    tmpdir(),
    `session-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    contextId: 'thread-1',
    contextType: 'teams-thread',
    provider: 'claude-cli',
    nativeSessionId: 'abc-123',
    state: 'active',
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    ...overrides,
  };
}

describe('SessionRegistry', () => {
  let tmpDir: string;
  let registry: SessionRegistry;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    registry = new SessionRegistry(tmpDir);
  });

  afterEach(() => {
    registry.dispose();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // --- CRUD ---

  it('save and lookup', () => {
    const record = makeRecord();
    registry.save(record);
    const found = registry.lookup('teams-thread', 'thread-1');
    expect(found).not.toBeNull();
    expect(found!.nativeSessionId).toBe('abc-123');
  });

  it('lookup returns null for missing', () => {
    expect(registry.lookup('teams-thread', 'nonexistent')).toBeNull();
  });

  it('lookupByNativeId', () => {
    registry.save(makeRecord());
    const found = registry.lookupByNativeId('claude-cli', 'abc-123');
    expect(found).not.toBeNull();
    expect(found!.contextId).toBe('thread-1');
  });

  it('lookupByNativeId returns null for wrong provider', () => {
    registry.save(makeRecord());
    expect(registry.lookupByNativeId('codex-cli', 'abc-123')).toBeNull();
  });

  it('update patches existing record', () => {
    registry.save(makeRecord());
    registry.update('teams-thread', 'thread-1', { nativeSessionId: 'xyz-999' });
    expect(registry.lookup('teams-thread', 'thread-1')!.nativeSessionId).toBe(
      'xyz-999',
    );
  });

  it('update is no-op for missing record', () => {
    registry.update('teams-thread', 'nonexistent', { state: 'suspended' });
    expect(registry.size).toBe(0);
  });

  it('delete removes record', () => {
    registry.save(makeRecord());
    expect(registry.size).toBe(1);
    registry.delete('teams-thread', 'thread-1');
    expect(registry.size).toBe(0);
    expect(registry.lookup('teams-thread', 'thread-1')).toBeNull();
  });

  it('delete is no-op for missing record', () => {
    registry.delete('teams-thread', 'nonexistent');
    expect(registry.size).toBe(0);
  });

  // --- Lifecycle ---

  it('getActiveCount counts only active records', () => {
    registry.save(makeRecord({ contextId: 'a', state: 'active' }));
    registry.save(makeRecord({ contextId: 'b', state: 'suspended' }));
    registry.save(makeRecord({ contextId: 'c', state: 'active' }));
    expect(registry.getActiveCount()).toBe(2);
  });

  it('getActiveCount filters by provider', () => {
    registry.save(makeRecord({ contextId: 'a', provider: 'claude-cli' }));
    registry.save(makeRecord({ contextId: 'b', provider: 'codex-cli' }));
    expect(registry.getActiveCount('claude-cli')).toBe(1);
    expect(registry.getActiveCount('codex-cli')).toBe(1);
  });

  it('getActiveSessions returns active records', () => {
    registry.save(makeRecord({ contextId: 'a', state: 'active' }));
    registry.save(makeRecord({ contextId: 'b', state: 'suspended' }));
    const active = registry.getActiveSessions();
    expect(active).toHaveLength(1);
    expect(active[0].contextId).toBe('a');
  });

  it('suspend and activate', () => {
    registry.save(makeRecord());
    registry.suspend('teams-thread', 'thread-1');
    expect(registry.lookup('teams-thread', 'thread-1')!.state).toBe(
      'suspended',
    );
    registry.activate('teams-thread', 'thread-1');
    expect(registry.lookup('teams-thread', 'thread-1')!.state).toBe('active');
  });

  it('getLRU returns least recently used', () => {
    const now = Date.now();
    registry.save(makeRecord({ contextId: 'old', lastActiveAt: now - 10000 }));
    registry.save(makeRecord({ contextId: 'new', lastActiveAt: now }));
    const lru = registry.getLRU();
    expect(lru).not.toBeNull();
    expect(lru!.contextId).toBe('old');
  });

  it('getLRU skips suspended sessions', () => {
    const now = Date.now();
    registry.save(
      makeRecord({
        contextId: 'old',
        state: 'suspended',
        lastActiveAt: now - 10000,
      }),
    );
    registry.save(
      makeRecord({ contextId: 'new', state: 'active', lastActiveAt: now }),
    );
    const lru = registry.getLRU();
    expect(lru!.contextId).toBe('new');
  });

  it('getLRU filters by provider', () => {
    const now = Date.now();
    registry.save(
      makeRecord({
        contextId: 'a',
        provider: 'claude-cli',
        lastActiveAt: now - 10000,
      }),
    );
    registry.save(
      makeRecord({ contextId: 'b', provider: 'codex-cli', lastActiveAt: now }),
    );
    expect(registry.getLRU('codex-cli')!.contextId).toBe('b');
  });

  // --- Persistence ---

  it('persist and load roundtrip', () => {
    registry.save(makeRecord());
    registry.persist();

    const registry2 = new SessionRegistry(tmpDir);
    registry2.load();
    const found = registry2.lookup('teams-thread', 'thread-1');
    expect(found).not.toBeNull();
    expect(found!.nativeSessionId).toBe('abc-123');
    registry2.dispose();
  });

  it('load handles missing file', () => {
    const registry2 = new SessionRegistry(join(tmpDir, 'nonexistent'));
    registry2.load(); // Should not throw
    expect(registry2.size).toBe(0);
    registry2.dispose();
  });

  it('load handles corrupt file', () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'session-registry.json'), 'not json', 'utf-8');
    const registry2 = new SessionRegistry(tmpDir);
    registry2.load(); // Should not throw
    expect(registry2.size).toBe(0);
    registry2.dispose();
  });

  it('load handles incompatible version', () => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, 'session-registry.json'),
      JSON.stringify({ version: 999, sessions: { 'x:y': makeRecord() } }),
      'utf-8',
    );
    const registry2 = new SessionRegistry(tmpDir);
    registry2.load();
    expect(registry2.size).toBe(0); // Ignored incompatible version
    registry2.dispose();
  });

  // --- Cleanup ---

  it('cleanup removes old sessions', () => {
    const old = Date.now() - 48 * 60 * 60 * 1000; // 48h ago
    registry.save(makeRecord({ contextId: 'old', lastActiveAt: old }));
    registry.save(makeRecord({ contextId: 'new', lastActiveAt: Date.now() }));
    const removed = registry.cleanup();
    expect(removed).toBe(1);
    expect(registry.size).toBe(1);
    expect(registry.lookup('teams-thread', 'old')).toBeNull();
    expect(registry.lookup('teams-thread', 'new')).not.toBeNull();
  });

  it('cleanup with custom maxAge', () => {
    registry.save(
      makeRecord({ contextId: 'a', lastActiveAt: Date.now() - 5000 }),
    );
    registry.save(makeRecord({ contextId: 'b', lastActiveAt: Date.now() }));
    const removed = registry.cleanup(3000); // 3 second max age
    expect(removed).toBe(1);
  });

  // --- Dispose ---

  it('dispose persists dirty state', () => {
    registry.save(makeRecord());
    // Don't call persist() — let dispose handle it
    registry.dispose();

    const registry2 = new SessionRegistry(tmpDir);
    registry2.load();
    expect(registry2.size).toBe(1);
    registry2.dispose();
  });
});
