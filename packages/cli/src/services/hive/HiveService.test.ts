/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_HIVE_FEATURE
//
// Pure-logic tests for the hive policy helpers: invite parsing and the hard
// tool-gate decision (§6.1/§7.3). The full delivery loop is covered by the
// hub integration test (HiveHub.test.ts).

import { describe, it, expect, afterEach } from 'vitest';
import { parseInvite, isToolGatedForConsult } from './hivePolicy.js';
import { hiveInstanceKey } from './hivePaths.js';

// Mirrors core's Kind string-enum values (hivePolicy is core-import-free).
const Kind = {
  Execute: 'execute',
  Edit: 'edit',
  Delete: 'delete',
  Move: 'move',
  Read: 'read',
  Search: 'search',
  Fetch: 'fetch',
  Think: 'think',
  Communicate: 'communicate',
  Other: 'other',
} as const;
type Kind = (typeof Kind)[keyof typeof Kind];

describe('parseInvite', () => {
  it('parses a full invite with token', () => {
    const invite = parseInvite(
      '/hive join https://lucky-mole-fd21.trycloudflare.com/AbCdEf#k7mq-x3rp-9wnz-h4td.inv_9f2k',
    );
    expect(invite).toEqual({
      url: 'https://lucky-mole-fd21.trycloudflare.com/AbCdEf',
      passphrase: 'k7mq-x3rp-9wnz-h4td',
      inviteToken: 'inv_9f2k',
    });
  });

  it('parses a re-join invite without token', () => {
    const invite = parseInvite(
      'https://new-url.trycloudflare.com/AbCdEf#k7mq-x3rp-9wnz-h4td',
    );
    expect(invite).toEqual({
      url: 'https://new-url.trycloudflare.com/AbCdEf',
      passphrase: 'k7mq-x3rp-9wnz-h4td',
    });
  });

  it('parses a loopback/LAN invite', () => {
    const invite = parseInvite('http://127.0.0.1:18800/tok#pass-word');
    expect(invite).toEqual({
      url: 'http://127.0.0.1:18800/tok',
      passphrase: 'pass-word',
    });
  });

  it('passphrases containing dots keep only the .inv_ suffix as token', () => {
    const invite = parseInvite('https://x.y/t#pa.ss.inv_abc');
    expect(invite).toEqual({
      url: 'https://x.y/t',
      passphrase: 'pa.ss',
      inviteToken: 'inv_abc',
    });
  });

  it('rejects garbage', () => {
    expect(parseInvite('')).toBeUndefined();
    expect(parseInvite('https://no-fragment.example.com')).toBeUndefined();
    expect(parseInvite('#only-fragment')).toBeUndefined();
  });
});

describe('isToolGatedForConsult (hard tool gate)', () => {
  const kinds: Record<string, Kind> = {
    run_shell_command: Kind.Execute,
    write_file: Kind.Edit,
    edit: Kind.Edit,
    delete_file: Kind.Delete,
    move_file: Kind.Move,
    read_file: Kind.Read,
    grep: Kind.Search,
    knowledge_search: Kind.Search,
    web_fetch: Kind.Fetch,
    think: Kind.Think,
    hive_send: Kind.Communicate,
    hive_status: Kind.Communicate,
    hive_check: Kind.Communicate,
    stagehand_browser: Kind.Other,
    external_agent_session: Kind.Other,
  };
  const lookup = (name: string): Kind | undefined => kinds[name];

  it('gates state-changing kinds (execute/edit/delete/move)', () => {
    expect(isToolGatedForConsult('run_shell_command', lookup)).toBe(true);
    expect(isToolGatedForConsult('write_file', lookup)).toBe(true);
    expect(isToolGatedForConsult('edit', lookup)).toBe(true);
    expect(isToolGatedForConsult('delete_file', lookup)).toBe(true);
    expect(isToolGatedForConsult('move_file', lookup)).toBe(true);
  });

  it('gates explicitly-named tools regardless of kind', () => {
    expect(isToolGatedForConsult('stagehand_browser', lookup)).toBe(true);
    expect(isToolGatedForConsult('external_agent_session', lookup)).toBe(true);
  });

  it('never gates the messaging path — replies are part of reliability', () => {
    expect(isToolGatedForConsult('hive_send', lookup)).toBe(false);
    expect(isToolGatedForConsult('hive_status', lookup)).toBe(false);
    expect(isToolGatedForConsult('hive_check', lookup)).toBe(false);
  });

  it('lets read/search/fetch/think tools through', () => {
    expect(isToolGatedForConsult('read_file', lookup)).toBe(false);
    expect(isToolGatedForConsult('grep', lookup)).toBe(false);
    expect(isToolGatedForConsult('knowledge_search', lookup)).toBe(false);
    expect(isToolGatedForConsult('web_fetch', lookup)).toBe(false);
    expect(isToolGatedForConsult('think', lookup)).toBe(false);
  });

  it('treats unknown tools (MCP/discovered — unknown provenance) as gated', () => {
    expect(isToolGatedForConsult('some_mcp_tool', lookup)).toBe(true);
  });
});

describe('hiveInstanceKey (per-instance state on one machine)', () => {
  const saved = process.env['AUDITARIA_HIVE_INSTANCE'];
  afterEach(() => {
    if (saved === undefined) delete process.env['AUDITARIA_HIVE_INSTANCE'];
    else process.env['AUDITARIA_HIVE_INSTANCE'] = saved;
  });

  it('derives a stable key from the working directory by default', () => {
    delete process.env['AUDITARIA_HIVE_INSTANCE'];
    const a = hiveInstanceKey('/home/u/projectA');
    expect(a).toMatch(/^p_[A-Za-z0-9_-]+$/);
    // Stable for the same cwd, distinct for a different cwd → distinct peers.
    expect(hiveInstanceKey('/home/u/projectA')).toBe(a);
    expect(hiveInstanceKey('/home/u/projectB')).not.toBe(a);
  });

  it('honors AUDITARIA_HIVE_INSTANCE (run several peers in one directory)', () => {
    process.env['AUDITARIA_HIVE_INSTANCE'] = 'alpha';
    expect(hiveInstanceKey('/same/dir')).toBe('alpha');
    process.env['AUDITARIA_HIVE_INSTANCE'] = 'beta';
    expect(hiveInstanceKey('/same/dir')).toBe('beta');
  });

  it('sanitizes the override to a filesystem-safe token', () => {
    process.env['AUDITARIA_HIVE_INSTANCE'] = 'a/b\\c:*d';
    expect(hiveInstanceKey()).toBe('a_b_c__d');
  });
});
