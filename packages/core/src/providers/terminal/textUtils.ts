/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_PROVIDER_TERMINAL: Small text helpers shared by PTY-driven
 * provider drivers.
 */

/**
 * Compact one-line summary of a tool call's input, used for the inline
 * "↪ Calling X: …" markers surfaced for background (web-terminal) turns.
 * Picks whichever single field reads best (command for shell tools,
 * file paths, patterns, …) and falls back to a truncated JSON dump.
 */
export function summariseToolArgs(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed by the typeof guard above
  const obj = input as Record<string, unknown>;
  const preferred = [
    'command',
    'file_path',
    'filePath',
    'path',
    'pattern',
    'query',
    'url',
    'name',
    'question',
    'intent',
  ];
  for (const k of preferred) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 0) {
      const trimmed = v.trim();
      return trimmed.length > 140 ? trimmed.slice(0, 137) + '…' : trimmed;
    }
  }
  try {
    const dump = JSON.stringify(obj);
    return dump.length > 140 ? dump.slice(0, 137) + '…' : dump;
  } catch {
    return '';
  }
}
