import { describe, it, expect } from 'vitest';
import { ClaudeSessionManager } from './claudeSessionManager.js';

describe('ClaudeSessionManager', () => {
  it('should start with no session', () => {
    const mgr = new ClaudeSessionManager();
    expect(mgr.getSessionId()).toBeUndefined();
  });

  it('should store and retrieve session ID', () => {
    const mgr = new ClaudeSessionManager();
    mgr.setSessionId('abc-123');
    expect(mgr.getSessionId()).toBe('abc-123');
  });

  it('should overwrite session ID', () => {
    const mgr = new ClaudeSessionManager();
    mgr.setSessionId('first');
    mgr.setSessionId('second');
    expect(mgr.getSessionId()).toBe('second');
  });

  it('should clear session', () => {
    const mgr = new ClaudeSessionManager();
    mgr.setSessionId('abc-123');
    mgr.clearSession();
    expect(mgr.getSessionId()).toBeUndefined();
  });
});
