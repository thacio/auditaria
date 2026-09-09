/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  appendFile,
  rm,
  utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listCodexSessions,
  validateCodexSessionId,
} from './codexSessionBrowser.js';
import { loadCodexSessionAsContent } from './codexSessionLoader.js';
import { CodexPtyDriver } from './codexPtyDriver.js';
import type { JsonlFileTail } from '../terminal/jsonlTail.js';

const id = '11111111-2222-3333-4444-555555555555';
const otherId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const message = (role: string, text: string) => ({
  type: 'message',
  role,
  content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
});
const response = (payload: object) => ({ type: 'response_item', payload });
let home: string;
let cwd: string;
async function rollout(
  entries: object[],
  sessionId = id,
  project = cwd,
  date = '2026/09/09',
) {
  const dir = join(home, 'sessions', date);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `rollout-2026-09-09T10-00-00-${sessionId}.jsonl`);
  await writeFile(
    file,
    [
      { type: 'session_meta', payload: { id: sessionId, cwd: project } },
      ...entries,
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n',
  );
  return file;
}
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'codex-resume-'));
  cwd = join(home, 'project');
  vi.stubEnv('CODEX_HOME', home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('Codex native session discovery', () => {
  it('uses CODEX_HOME, filters by project, and skips injected context in previews', async () => {
    await rollout([
      response(message('user', '# AGENTS.md instructions for project')),
      response(message('user', 'Olá 世界')),
    ]);
    await rollout(
      [response(message('user', 'Other project'))],
      otherId,
      join(home, 'other'),
    );
    const sessions = await listCodexSessions(cwd);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: id,
      firstPrompt: 'Olá 世界',
    });
    expect(await validateCodexSessionId(cwd, id)).toEqual({
      valid: true,
      filePath: sessions[0].filePath,
    });
    expect((await validateCodexSessionId(cwd, otherId)).valid).toBe(false);
    expect((await validateCodexSessionId(cwd, '../escape')).valid).toBe(false);
  });
  it('finds old sessions and limits after project filtering and modification-time sorting', async () => {
    const old = await rollout(
      [response(message('user', 'Old'))],
      id,
      cwd,
      '2025/01/01',
    );
    await utimes(old, new Date(0), new Date(0));
    await rollout([response(message('user', 'New'))], otherId);
    expect((await listCodexSessions(cwd, 1)).map((s) => s.sessionId)).toEqual([
      otherId,
    ]);
    expect((await validateCodexSessionId(cwd, id)).valid).toBe(true);
  });
  it('handles a missing session directory', async () => {
    expect(await listCodexSessions(cwd)).toEqual([]);
    expect((await validateCodexSessionId(cwd, id)).valid).toBe(false);
  });
  it('rejects filename/metadata ID mismatches and subagent rollouts', async () => {
    await rollout([
      {
        type: 'session_meta',
        payload: { id, cwd, source: { subagent: { thread_spawn: {} } } },
      },
    ]);
    // The initial metadata is canonical; write a dedicated subagent fixture.
    const file = (await validateCodexSessionId(cwd, id)).filePath;
    await writeFile(
      file,
      JSON.stringify({
        type: 'session_meta',
        payload: { id, cwd, source: { subagent: {} } },
      }) + '\n',
    );
    expect(await listCodexSessions(cwd)).toEqual([]);
    await writeFile(
      file,
      JSON.stringify({ type: 'session_meta', payload: { id: otherId, cwd } }) +
        '\n',
    );
    expect((await validateCodexSessionId(cwd, id)).valid).toBe(false);
  });
});

describe('Codex native history loading', () => {
  it('baselines a resumed driver at EOF and observes only newly appended turns', async () => {
    const file = await rollout([
      response(message('user', 'Old prompt')),
      response(message('assistant', 'Old reply')),
    ]);
    const driver = new CodexPtyDriver({ cwd });
    // Stop before creating hook infrastructure or spawning a real process.
    const internals = driver as unknown as {
      ensureHookInfra(): void;
      ensureSpawned(signal: AbortSignal): Promise<string | null>;
      rolloutTail: JsonlFileTail;
      rolloutPath: string | undefined;
      bindSession(payload: Record<string, unknown>): void;
    };
    vi.spyOn(internals, 'ensureHookInfra').mockImplementation(() => {
      throw new Error('stop before spawn');
    });
    try {
      driver.setSessionId(id);
      await expect(
        internals.ensureSpawned(new AbortController().signal),
      ).rejects.toThrow('stop before spawn');
      internals.bindSession({ session_id: id, transcript_path: file });
      expect((await internals.rolloutTail.drain()).entries).toEqual([]);
      const next = response(message('user', 'Continue'));
      await appendFile(file, JSON.stringify(next) + '\n');
      expect((await internals.rolloutTail.drain()).entries).toEqual([next]);
      driver.setSessionId(otherId);
      expect(internals.rolloutPath).toBeUndefined();
      expect(internals.rolloutTail.offset).toBe(0);
    } finally {
      driver.dispose();
    }
  });

  it('discards turns removed by a native rollback', async () => {
    const file = await rollout([
      response(message('user', 'Keep')),
      response(message('assistant', 'Kept')),
      response(message('user', 'Undo')),
      response(message('assistant', 'Removed')),
      {
        type: 'event_msg',
        payload: { type: 'thread_rolled_back', num_turns: 1 },
      },
      response(message('user', 'Replacement')),
    ]);
    expect(
      (await loadCodexSessionAsContent(file)).flatMap((entry) =>
        entry.parts?.map((part) => part.text),
      ),
    ).toEqual(['Keep', 'Kept', 'Replacement']);
  });
  it('loads canonical messages once, excluding system context and reasoning', async () => {
    const file = await rollout([
      response(message('developer', 'Private instructions')),
      response(
        message('user', '<environment_context>cwd</environment_context>'),
      ),
      response(message('user', 'Hello')),
      {
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Hello' },
      },
      response({ type: 'reasoning', encrypted_content: 'opaque' }),
      response(message('assistant', 'Hi')),
      { type: 'event_msg', payload: { type: 'agent_message', message: 'Hi' } },
    ]);
    expect(await loadCodexSessionAsContent(file)).toEqual([
      { role: 'user', parts: [{ text: 'Hello' }] },
      { role: 'model', parts: [{ text: 'Hi' }] },
    ]);
  });
  it('preserves tool IDs, custom inputs, outputs and dangling calls with repeated names', async () => {
    const file = await rollout([
      response({
        type: 'function_call',
        call_id: 'a',
        name: 'exec_command',
        arguments: '{"cmd":"echo hello"}',
      }),
      response({ type: 'function_call_output', call_id: 'a', output: 'hello' }),
      response({
        type: 'function_call',
        call_id: 'b',
        name: 'exec_command',
        arguments: '{}',
      }),
      response({
        type: 'custom_tool_call',
        call_id: 'c',
        name: 'apply_patch',
        input: '*** Begin Patch',
      }),
      response({
        type: 'custom_tool_call_output',
        call_id: 'c',
        output: { success: true },
      }),
    ]);
    const history = await loadCodexSessionAsContent(file);
    expect(history[0].parts?.[0].functionCall).toEqual({
      id: 'a',
      name: 'Bash',
      args: { cmd: 'echo hello' },
    });
    expect(history[1].parts?.[0].functionResponse?.response).toEqual({
      output: 'hello',
    });
    expect(history[3].parts?.[0].functionResponse?.id).toBe('b');
    expect(history[4].parts?.[0].functionCall?.args).toEqual({
      arguments: '*** Begin Patch',
    });
    expect(history[5].parts?.[0].functionResponse?.response).toEqual({
      output: { success: true },
    });
  });
  it('preserves image attachments', async () => {
    const file = await rollout([
      response({
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' },
        ],
      }),
    ]);
    expect((await loadCodexSessionAsContent(file))[0].parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } },
    ]);
  });
  it('uses exact replacement history after compaction without resurrecting old calls', async () => {
    const file = await rollout([
      response(message('user', 'Old prompt')),
      response({
        type: 'function_call',
        call_id: 'old',
        name: 'shell',
        arguments: '{}',
      }),
      {
        type: 'compacted',
        payload: {
          message: '',
          replacement_history: [
            message('developer', 'instructions'),
            message('user', 'Summary'),
          ],
        },
      },
      response(message('assistant', 'Continued')),
    ]);
    expect(await loadCodexSessionAsContent(file)).toEqual([
      { role: 'user', parts: [{ text: 'Summary' }] },
      { role: 'model', parts: [{ text: 'Continued' }] },
    ]);
  });
  it('retains legacy compaction summaries', async () => {
    const file = await rollout([
      response(message('user', 'Old')),
      { type: 'compacted', payload: { message: 'Important facts' } },
    ]);
    expect(
      (await loadCodexSessionAsContent(file))[0].parts?.[0].text,
    ).toContain('<state_snapshot>\nImportant facts');
  });
  it('ignores malformed entries and reports read failures', async () => {
    const file = await rollout([
      response(message('user', 'Hello')),
      { type: 'response_item', payload: null },
    ]);
    await writeFile(
      file,
      'null\n{broken\n' +
        JSON.stringify(response(message('user', 'Final line'))),
    );
    expect(await loadCodexSessionAsContent(file)).toEqual([
      { role: 'user', parts: [{ text: 'Final line' }] },
    ]);
    await expect(
      loadCodexSessionAsContent(join(home, 'missing')),
    ).rejects.toThrow();
  });
});
