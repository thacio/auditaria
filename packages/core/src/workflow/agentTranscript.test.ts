/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readAgentTranscript } from './agentTranscript.js';

describe('readAgentTranscript', () => {
  it('reads the latest attempt and captured structured result, ignoring a partial line', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-transcript-'));
    const file = path.join(dir, 'agent.jsonl');
    const rows = [
      { type: 'user', message: { content: 'first attempt' } },
      { type: 'workflow_result', value: 'obsolete' },
      { type: 'user', message: { content: 'Full task\nwith context' } },
      {
        type: 'event',
        event: {
          type: 'tool_use',
          toolName: 'read_file',
          input: { path: 'report.md' },
        },
      },
      {
        type: 'activity',
        activity: {
          type: 'TOOL_CALL_START',
          data: { name: 'search', args: { query: 'evidence' } },
        },
      },
      { type: 'event', event: { type: 'content', text: 'An acknowledgement' } },
      { type: 'workflow_result', value: { count: 42 } },
    ];
    await fs.writeFile(
      file,
      rows.map((row) => JSON.stringify(row)).join('\n') + '\n{"unfinished',
    );
    try {
      expect(await readAgentTranscript(file)).toEqual({
        prompt: 'Full task\nwith context',
        result: '{\n  "count": 42\n}',
        tools: [
          { name: 'read_file', summary: '{\n  "path": "report.md"\n}' },
          { name: 'search', summary: '{\n  "query": "evidence"\n}' },
        ],
        truncated: false,
      });
    } finally {
      await fs.unlink(file);
      await fs.rmdir(dir);
    }
  });
});
