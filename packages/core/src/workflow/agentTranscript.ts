/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: Read the shared leaf transcript for either interface.
import * as fs from 'node:fs/promises';
import { isRecord, stringField } from './guards.js';

export interface WorkflowAgentDetail {
  prompt: string;
  result?: string;
  tools: Array<{ name: string; summary: string }>;
  truncated: boolean;
}

const READ_BYTES = 1024 * 1024;
const TEXT_CHARS = 64 * 1024;

export async function readAgentTranscript(
  file: string,
): Promise<WorkflowAgentDetail> {
  const handle = await fs.open(file, 'r');
  let source: string;
  let truncated = false;
  try {
    const { size } = await handle.stat();
    const start = Buffer.alloc(Math.min(size, READ_BYTES));
    await handle.read(start, 0, start.length, 0);
    source = start.toString('utf8');
    if (size > READ_BYTES) {
      truncated = true;
      const tail = Buffer.alloc(Math.min(size - READ_BYTES, READ_BYTES));
      await handle.read(tail, 0, tail.length, size - tail.length);
      const suffix = tail.toString('utf8');
      source =
        source.slice(0, source.lastIndexOf('\n') + 1) +
        suffix.slice(suffix.indexOf('\n') + 1);
    }
  } finally {
    await handle.close();
  }
  const detail: WorkflowAgentDetail = { prompt: '', tools: [], truncated };
  const content: string[] = [];
  for (const line of source.split('\n')) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // The provider can still be writing the final line.
    }
    if (!isRecord(row)) continue;
    const message = row['message'];
    const event = row['event'];
    const activity = row['activity'];
    if (row['type'] === 'user' && isRecord(message)) {
      detail.prompt = stringField(message, 'content') ?? detail.prompt;
      content.length = 0;
      detail.tools = [];
      detail.result = undefined;
    } else if (row['type'] === 'workflow_result') {
      const value = row['value'];
      detail.result =
        typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    } else if (isRecord(event)) {
      if (event['type'] === 'content')
        content.push(stringField(event, 'text') ?? '');
      if (event['type'] === 'tool_use') {
        detail.tools.push({
          name: stringField(event, 'toolName') ?? 'tool',
          summary: textOf(event['input']),
        });
      }
    } else if (
      isRecord(activity) &&
      activity['type'] === 'TOOL_CALL_START' &&
      isRecord(activity['data'])
    ) {
      detail.tools.push({
        name: stringField(activity['data'], 'name') ?? 'tool',
        summary: textOf(activity['data']['args']),
      });
    } else if (row['type'] === 'result' && isRecord(row['output'])) {
      detail.result = stringField(row['output'], 'result');
    }
  }
  detail.result ??= content.length ? content.join('') : undefined;
  const bound = (text: string) => {
    if (text.length <= TEXT_CHARS) return text;
    detail.truncated = true;
    return text.slice(0, TEXT_CHARS);
  };
  detail.prompt = bound(detail.prompt);
  if (detail.result) detail.result = bound(detail.result);
  detail.tools = detail.tools.slice(-3);
  return detail;
}

function textOf(value: unknown): string {
  return (
    typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '')
  ).slice(0, 2000);
}
