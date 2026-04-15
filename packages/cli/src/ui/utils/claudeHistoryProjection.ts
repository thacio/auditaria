/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_REWIND_FEATURE: Project a mirrored Claude Content[] into the
// chat-log HistoryItem[]. Used by /resume-claude and the --resume-claude CLI
// flag so both code paths render from the same parsed conversation.

import type { Content, Part } from '@google/genai';
import type { HistoryItem } from '../types.js';

/**
 * Convert mirrored Content[] from a resumed Claude session into HistoryItem[]
 * for the chat log. Shows user text turns and assistant text turns; tool calls
 * are represented as inline markers (the full functionCall/functionResponse
 * pair stays in the mirrored history for rewind and token estimation). Skips
 * compaction snapshot entries — those are protocol noise, not visible turns.
 */
export function buildUIHistoryFromContent(
  history: readonly Content[],
): HistoryItem[] {
  const items: HistoryItem[] = [];
  let idCounter = 1;

  for (const entry of history) {
    if (!entry.parts || entry.parts.length === 0) continue;
    const text = extractDisplayText(entry.parts);
    if (!text) continue;
    if (
      text.startsWith('<state_snapshot>') ||
      text.startsWith('<context_compacted>')
    ) {
      continue;
    }

    if (entry.role === 'user') {
      // Skip pure tool-response user turns — the tool call marker on the
      // preceding assistant turn already signals that a tool ran.
      const hasOnlyToolResponse = entry.parts.every(
        (p) => 'functionResponse' in p,
      );
      if (hasOnlyToolResponse) continue;
      items.push({ type: 'user', text, id: idCounter++ });
    } else if (entry.role === 'model') {
      items.push({ type: 'gemini', text, id: idCounter++ });
    }
  }

  return items;
}

function extractDisplayText(parts: readonly Part[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    if ('text' in part && part.text) {
      segments.push(part.text);
    } else if ('functionCall' in part && part.functionCall) {
      segments.push(`[Tool call: ${part.functionCall.name}]`);
    } else if ('inlineData' in part && part.inlineData) {
      segments.push(`[Attachment: ${part.inlineData.mimeType || 'binary'}]`);
    }
    // functionResponse parts aren't rendered here — they're represented by
    // the tool-call marker on the preceding assistant turn.
  }
  return segments.join('\n');
}
