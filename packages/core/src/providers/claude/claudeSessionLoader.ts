/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_CLAUDE_PROVIDER: Full-fidelity parser for Claude JSONL session files.
// Produces Gemini Content[] that mirrors the real conversation (text, tool calls,
// tool results, images, compaction boundaries) — used by /resume-claude to populate
// the mirrored history so rewind, summary-building, and provider switching all
// read from the real conversation instead of a synthetic placeholder.

import type { Content, Part } from '@google/genai';
import { findCompressSplitPoint } from '../../context/chatCompressionService.js';

const SESSION_CONTEXT_PREFIX = '<session_context>';
const CONVERSATION_HISTORY_PREFIX = '<auditaria_conversation_history>';

// Matches COMPACTION_PRESERVE_FRACTION in providerManager.ts — keep last 30% after compaction.
const COMPACTION_PRESERVE_FRACTION = 0.3;

interface ClaudeJSONLEntry {
  type?: string;
  subtype?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: {
    id?: string;
    role?: string;
    content?: unknown;
  };
}

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  source?: { type?: string; media_type?: string; data?: string };
}

/**
 * Parse a Claude JSONL session file into Gemini Content[].
 *
 * Full-fidelity: preserves text, tool calls, tool results, images, and compaction
 * boundaries. Groups streamed assistant blocks sharing the same message.id into a
 * single model turn. Pads dangling tool calls with placeholder responses.
 *
 * Returns an empty array on read errors or if the file has no conversation content.
 */
export async function loadClaudeSessionAsContent(
  jsonlPath: string,
): Promise<Content[]> {
  let data: string;
  try {
    const { readFile } = await import('node:fs/promises');
    data = await readFile(jsonlPath, 'utf-8');
  } catch {
    return [];
  }

  const lines = data.split('\n').filter(Boolean);
  const history: Content[] = [];

  // Assistant turns are streamed across multiple JSONL lines sharing message.id.
  // We accumulate into currentAssistant* and flush when the id changes or a user
  // message arrives.
  let currentAssistantId: string | undefined;
  let currentAssistantParts: Part[] = [];

  // tool_use id -> tool name (for resolving functionResponse.name from tool_result)
  const toolIdToName = new Map<string, string>();

  // Tool calls seen but not yet matched with a tool_result. After parsing, any
  // remaining entries get a placeholder functionResponse so Gemini's pair
  // invariant holds.
  const unmatchedToolCalls = new Map<string, string>(); // id -> name

  // Compaction state machine:
  //   idle → (compact_boundary) → awaitingSummary → (user text block) → idle
  let awaitingCompactionSummary = false;

  const flushAssistant = () => {
    if (currentAssistantParts.length > 0) {
      history.push({ role: 'model', parts: currentAssistantParts });
      currentAssistantParts = [];
    }
    currentAssistantId = undefined;
  };

  for (const rawLine of lines) {
    let entry: ClaudeJSONLEntry;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Claude JSONL format (see types at top)
      entry = JSON.parse(rawLine) as ClaudeJSONLEntry;
    } catch {
      continue;
    }

    // Skip sidechain messages (sub-agent scratchpads) and meta entries
    // (local-command-caveat, etc.).
    if (entry.isMeta || entry.isSidechain) continue;

    // Skip non-conversation bookkeeping entries.
    if (
      entry.type === 'file-history-snapshot' ||
      entry.type === 'queue-operation' ||
      entry.type === 'last-prompt'
    ) {
      continue;
    }

    // Compaction boundary — flush, mark awaiting the summary that follows.
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      flushAssistant();
      awaitingCompactionSummary = true;
      continue;
    }

    // Skip other system messages (local_command output, status, etc.).
    if (entry.type === 'system') continue;

    const message = entry.message;
    if (!message?.role) continue;
    const content = message.content;

    if (message.role === 'user') {
      flushAssistant();
      processUserMessage(
        content,
        history,
        toolIdToName,
        unmatchedToolCalls,
        () => {
          // Called when this user message was consumed as the compaction summary.
          awaitingCompactionSummary = false;
        },
        awaitingCompactionSummary,
      );
      continue;
    }

    if (message.role === 'assistant') {
      // An assistant message arriving without a preceding summary user text means
      // the compaction summary won't come — clear the flag and fall back to a
      // generic marker.
      if (awaitingCompactionSummary) {
        applyCompactionFallback(history);
        awaitingCompactionSummary = false;
      }

      const msgId = message.id;
      if (msgId && msgId !== currentAssistantId) {
        flushAssistant();
        currentAssistantId = msgId;
      } else if (!msgId) {
        // No id — can't group. Flush whatever we had, treat as its own turn.
        flushAssistant();
      }
      appendAssistantBlocks(
        content,
        currentAssistantParts,
        toolIdToName,
        unmatchedToolCalls,
      );
      continue;
    }
  }

  // End-of-file flush for any trailing assistant turn.
  flushAssistant();

  // If we ended still awaiting a compaction summary, apply the fallback wrapper.
  if (awaitingCompactionSummary) {
    applyCompactionFallback(history);
  }

  // Pad dangling tool calls with placeholder responses so Gemini's functionCall/
  // functionResponse pairing invariant holds (required for /compress, and for
  // buildConversationSummary to produce a well-formed transcript).
  padDanglingToolCalls(history, unmatchedToolCalls);

  return history;
}

/**
 * Process a user message, pushing the corresponding Content entry (if any) into
 * `history`. If `awaitingSummary` is true and this message is pure text, it's
 * consumed as the compaction summary instead (applying trim + <state_snapshot>).
 */
function processUserMessage(
  content: unknown,
  history: Content[],
  toolIdToName: Map<string, string>,
  unmatchedToolCalls: Map<string, string>,
  onSummaryConsumed: () => void,
  awaitingSummary: boolean,
): void {
  // Claude user messages are either a plain string or an array of blocks.
  if (typeof content === 'string') {
    if (isSystemContextText(content)) return;
    if (awaitingSummary) {
      applyCompactionWithSummary(history, content);
      onSummaryConsumed();
      return;
    }
    history.push({ role: 'user', parts: [{ text: content }] });
    return;
  }

  if (!Array.isArray(content)) return;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Claude JSONL content block shape
  const blocks = content as ClaudeContentBlock[];

  // If awaiting summary and this user message is pure text, treat the combined
  // text as the summary.
  if (awaitingSummary) {
    const summaryText = blocks
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!)
      .join('\n');
    // Only consume as summary if there's no tool_result (summary messages from
    // Claude are text-only).
    const hasToolResult = blocks.some((b) => b.type === 'tool_result');
    if (summaryText && !hasToolResult && !isSystemContextText(summaryText)) {
      applyCompactionWithSummary(history, summaryText);
      onSummaryConsumed();
      return;
    }
    // Otherwise the summary never came — fall back to generic marker and
    // process this message normally below.
    applyCompactionFallback(history);
    onSummaryConsumed();
  }

  const parts: Part[] = [];
  for (const block of blocks) {
    if (block.type === 'tool_result') {
      const toolId = block.tool_use_id || '';
      const toolName = toolIdToName.get(toolId) || 'unknown';
      unmatchedToolCalls.delete(toolId);
      parts.push({
        functionResponse: {
          id: toolId,
          name: toolName,
          response: { output: stringifyToolResultContent(block.content) },
        },
      });
      continue;
    }

    if (block.type === 'text' && block.text) {
      if (isSystemContextText(block.text)) continue;
      parts.push({ text: block.text });
      continue;
    }

    if (block.type === 'image') {
      const src = block.source;
      if (src?.data && src?.media_type) {
        parts.push({
          inlineData: { mimeType: src.media_type, data: src.data },
        });
      }
      continue;
    }
  }

  if (parts.length > 0) {
    history.push({ role: 'user', parts });
  }
}

/**
 * Append the blocks of one assistant JSONL line to the current turn's parts.
 * Assistant turns group by message.id — callers flush between turns.
 */
function appendAssistantBlocks(
  content: unknown,
  parts: Part[],
  toolIdToName: Map<string, string>,
  unmatchedToolCalls: Map<string, string>,
): void {
  if (!Array.isArray(content)) return;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Claude JSONL content block shape
  const blocks = content as ClaudeContentBlock[];

  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      parts.push({ text: block.text });
      continue;
    }

    if (block.type === 'tool_use' && block.id && block.name) {
      parts.push({
        functionCall: { name: block.name, args: block.input || {} },
      });
      toolIdToName.set(block.id, block.name);
      unmatchedToolCalls.set(block.id, block.name);
      continue;
    }

    // Skip thinking blocks — not useful for mirrored history.
  }
}

/**
 * A Claude tool_result block's `content` field can be:
 *   - a string
 *   - an array of {type: 'text', text}
 *   - (rare) an array with image blocks
 * We flatten to a string for the functionResponse.output (which Gemini treats
 * as string by default). Binary output inside tool_result is uncommon; describe
 * it if we see it.
 */
function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const segments: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Claude JSONL content block shape
  for (const block of content as ClaudeContentBlock[]) {
    if (block.type === 'text' && block.text) {
      segments.push(block.text);
    } else if (block.type === 'image') {
      const mime = block.source?.media_type || 'unknown';
      segments.push(`[Tool returned image: ${mime}]`);
    }
  }
  return segments.join('\n');
}

function isSystemContextText(text: string): boolean {
  return (
    text.startsWith(SESSION_CONTEXT_PREFIX) ||
    text.startsWith(CONVERSATION_HISTORY_PREFIX)
  );
}

/**
 * Apply compaction with Claude's own summary: trim earlier history to the last
 * 30% (respecting turn boundaries) and prepend a <state_snapshot> wrapper so
 * downstream code (Gemini's chatCompressionService) recognizes a prior snapshot.
 * Mirrors compactMirroredHistory() in providerManager.ts.
 */
function applyCompactionWithSummary(history: Content[], summary: string): void {
  replaceHistoryWithSnapshot(
    history,
    `<state_snapshot>\n${summary}\n</state_snapshot>`,
  );
}

function applyCompactionFallback(history: Content[]): void {
  replaceHistoryWithSnapshot(
    history,
    '<context_compacted>\n' +
      'The external provider has compacted its context window. ' +
      'Older conversation history was summarized internally by the provider. ' +
      'Only recent messages are preserved below.\n' +
      '</context_compacted>',
  );
}

function replaceHistoryWithSnapshot(
  history: Content[],
  snapshotText: string,
): void {
  if (history.length === 0) {
    // Nothing before the boundary — still record the snapshot so the conversation
    // structure reflects that a compaction happened.
    history.push({ role: 'user', parts: [{ text: snapshotText }] });
    history.push({
      role: 'model',
      parts: [{ text: 'Got it. Thanks for the additional context!' }],
    });
    return;
  }

  // findCompressSplitPoint works on a full history; we apply it to what we have
  // so far. If the history is too small to split, keep it all but still prepend
  // the snapshot so the summary is preserved.
  let splitPoint = 0;
  if (history.length > 4) {
    splitPoint = findCompressSplitPoint(
      history,
      1 - COMPACTION_PRESERVE_FRACTION,
    );
  }
  const tail = splitPoint > 0 ? history.slice(splitPoint) : history.slice();

  history.length = 0;
  history.push({ role: 'user', parts: [{ text: snapshotText }] });
  history.push({
    role: 'model',
    parts: [{ text: 'Got it. Thanks for the additional context!' }],
  });
  history.push(...tail);
}

/**
 * Walk history and pair any functionCall in a model turn with a following
 * functionResponse. If any are unpaired, inject a placeholder user turn with
 * synthetic functionResponses right after the offending model turn.
 *
 * Uses the `unmatchedToolCalls` map to know which tool_use ids never got a
 * matching tool_result.
 */
function padDanglingToolCalls(
  history: Content[],
  unmatchedToolCalls: Map<string, string>,
): void {
  if (unmatchedToolCalls.size === 0) return;

  // Build reverse lookup: tool name → list of unmatched ids (ordered doesn't
  // matter since Gemini only checks pairing, not ids on functionCall).
  const unmatchedByName = new Map<string, string[]>();
  for (const [id, name] of unmatchedToolCalls) {
    const list = unmatchedByName.get(name) ?? [];
    list.push(id);
    unmatchedByName.set(name, list);
  }

  // Walk model turns; for each, check the next entry for matching responses.
  // Anything still unmatched by name we inject.
  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    if (entry.role !== 'model' || !entry.parts) continue;

    const toolNamesInTurn: string[] = [];
    for (const part of entry.parts) {
      if ('functionCall' in part && part.functionCall?.name) {
        toolNamesInTurn.push(part.functionCall.name);
      }
    }
    if (toolNamesInTurn.length === 0) continue;

    // Pull any response ids the next turn already covers, so we don't duplicate.
    const coveredIds = new Set<string>();
    const next = history[i + 1];
    if (next?.role === 'user' && next.parts) {
      for (const p of next.parts) {
        if ('functionResponse' in p && p.functionResponse?.id) {
          coveredIds.add(p.functionResponse.id);
        }
      }
    }

    const placeholderParts: Part[] = [];
    for (const name of toolNamesInTurn) {
      const ids = unmatchedByName.get(name);
      if (!ids || ids.length === 0) continue;
      // Find the first id for this name that isn't already covered downstream.
      const idx = ids.findIndex((id) => !coveredIds.has(id));
      if (idx < 0) continue;
      const id = ids.splice(idx, 1)[0];
      placeholderParts.push({
        functionResponse: {
          id,
          name,
          response: {
            output: '[Error: tool result not captured in session]',
          },
        },
      });
    }

    if (placeholderParts.length === 0) continue;

    if (next?.role === 'user') {
      next.parts = [...placeholderParts, ...(next.parts ?? [])];
    } else {
      history.splice(i + 1, 0, { role: 'user', parts: placeholderParts });
    }
  }
}
