/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_CODEX_PROVIDER: Read native rollouts without rewriting Codex's history.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Content, Part } from '@google/genai';
import { isPlainObject } from '../terminal/turnObserver.js';
import { mapCodexToolName, parseToolArguments } from './codexTurnObserver.js';

/** Stream complete JSONL records, tolerating interrupted/malformed writes. */
export async function* readCodexSessionEntries(filePath: string) {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      try {
        const entry: unknown = JSON.parse(line);
        if (isPlainObject(entry)) yield entry;
      } catch {
        // An incomplete final line is normal for a running session.
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

export function isCodexContextText(text: string): boolean {
  return /^\s*(#\s*AGENTS\.md instructions|<(INSTRUCTIONS|environment_context|user_instructions|permissions instructions|skills_instructions|apps_instructions|collaboration_mode|agents_md|memory|turn_context|available_tools|session_context|auditaria_conversation_history)\b)/i.test(
    text,
  );
}

export function codexMessageParts(content: unknown): Part[] {
  if (!Array.isArray(content)) return [];
  const parts: Part[] = [];
  for (const block of content) {
    if (!isPlainObject(block)) continue;
    const text = block['text'];
    const imageUrl = block['image_url'];
    if (['input_text', 'output_text', 'text'].includes(String(block['type']))) {
      if (typeof text === 'string') parts.push({ text });
    } else if (
      block['type'] === 'input_image' &&
      typeof imageUrl === 'string'
    ) {
      const url = imageUrl;
      const data = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url);
      parts.push(
        data
          ? { inlineData: { mimeType: data[1], data: data[2] } }
          : { fileData: { fileUri: url, mimeType: 'image/*' } },
      );
    }
  }
  return parts;
}

/** Use response_items as the canonical transcript; event_msg repeats them. */
export async function loadCodexSessionAsContent(
  filePath: string,
): Promise<Content[]> {
  const history: Content[] = [];
  const calls = new Map<
    string,
    { name: string; entry: Content; answered: boolean }
  >();

  const append = (item: Record<string, unknown>) => {
    const type = item['type'];
    if (type === 'message') {
      const role = item['role'];
      if (role !== 'user' && role !== 'assistant') return;
      const parts = codexMessageParts(item['content']).filter(
        (p) => role !== 'user' || !p.text || !isCodexContextText(p.text),
      );
      if (parts.length)
        history.push({ role: role === 'assistant' ? 'model' : 'user', parts });
      return;
    }
    const id = item['call_id'] ?? item['id'];
    if (typeof id !== 'string') return;
    if (
      type === 'function_call' ||
      type === 'custom_tool_call' ||
      type === 'local_shell_call'
    ) {
      const rawName =
        type === 'local_shell_call' ? 'local_shell' : item['name'];
      if (typeof rawName !== 'string' || calls.has(id)) return;
      const name = mapCodexToolName(rawName);
      const args = parseToolArguments(
        item['arguments'] ?? item['input'] ?? item['action'],
      );
      const entry: Content = {
        role: 'model',
        parts: [{ functionCall: { id, name, args } }],
      };
      history.push(entry);
      calls.set(id, { name, entry, answered: false });
    } else if (
      type === 'function_call_output' ||
      type === 'custom_tool_call_output' ||
      type === 'local_shell_call_output'
    ) {
      const call = calls.get(id);
      if (!call || call.answered) return;
      call.answered = true;
      history.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              id,
              name: call.name,
              response: { output: item['output'] ?? '' },
            },
          },
        ],
      });
    }
  };

  for await (const entry of readCodexSessionEntries(filePath)) {
    const payload = entry['payload'];
    if (!isPlainObject(payload)) continue;
    if (entry['type'] === 'response_item') append(payload);
    if (entry['type'] === 'compacted') {
      // Codex's replacement_history is the actual post-compaction context.
      // Replaying the old transcript here would resurrect forgotten content.
      history.length = 0;
      calls.clear();
      if (Array.isArray(payload['replacement_history'])) {
        for (const item of payload['replacement_history']) {
          if (isPlainObject(item)) append(item);
        }
      } else {
        const summary =
          payload['message'] ||
          payload['summary'] ||
          'Earlier conversation was compacted by Codex.';
        history.push({
          role: 'user',
          parts: [
            { text: `<state_snapshot>\n${String(summary)}\n</state_snapshot>` },
          ],
        });
      }
    }
    if (
      entry['type'] === 'event_msg' &&
      payload['type'] === 'thread_rolled_back'
    ) {
      const count = payload['num_turns'];
      if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0)
        continue;
      let remaining = count;
      for (let i = history.length - 1; i >= 0; i--) {
        if (
          history[i].role === 'user' &&
          history[i].parts?.some((p) => !p.functionResponse)
        ) {
          if (--remaining === 0) {
            history.splice(i);
            break;
          }
        }
      }
      for (const [id, call] of calls)
        if (!history.includes(call.entry)) calls.delete(id);
    }
  }

  // Match missing outputs by ID, even when a tool name was used repeatedly.
  for (const [id, call] of calls) {
    if (call.answered) continue;
    const index = history.indexOf(call.entry);
    history.splice(index + 1, 0, {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id,
            name: call.name,
            response: { output: '[Tool result not captured in session]' },
          },
        },
      ],
    });
  }
  return history;
}
