/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_HIVE_FEATURE: This entire file is part of the Hive integration.
//
// Pure decision logic, deliberately free of any @google/gemini-cli-core
// import so it can be unit-tested (and reasoned about) in isolation:
//  - invite parsing
//  - the hard tool-gate decision (§6.1/§7.3)

/**
 * Parse an invite: "<url>#<passphrase>[.<inviteToken>]", optionally prefixed
 * with "/hive join". Example:
 *   /hive join https://lucky-mole.trycloudflare.com/AbC…#k7mq-x3rp-9wnz-h4td.inv_9f2k
 */
export function parseInvite(input: string):
  | {
      url: string;
      passphrase: string;
      inviteToken?: string;
    }
  | undefined {
  let text = input.trim();
  text = text.replace(/^\/hive\s+join\s+/i, '').trim();
  const hashIdx = text.indexOf('#');
  if (hashIdx <= 0) return undefined;
  const url = text.slice(0, hashIdx).replace(/\/+$/, '');
  const fragment = text.slice(hashIdx + 1).trim();
  if (!fragment) return undefined;
  const dotIdx = fragment.lastIndexOf('.inv_');
  if (dotIdx >= 0) {
    return {
      url,
      passphrase: fragment.slice(0, dotIdx),
      inviteToken: fragment.slice(dotIdx + 1),
    };
  }
  return { url, passphrase: fragment };
}

// ---------------------------------------------------------------
// Hard tool gate (§6.1 / §7.3)
// ---------------------------------------------------------------
//
// Kind values mirror core's tools.ts Kind enum (string enum). Kept as
// literals here so this module never imports the core package.

/** Tool kinds treated as state-changing for the hive tool gate. */
const GATED_KINDS = new Set<string>(['edit', 'delete', 'move', 'execute']);

/** Named tools additionally gated regardless of their declared kind. */
const GATED_TOOL_NAMES = new Set([
  'stagehand_browser',
  'external_agent_session',
  'collaborative_writing',
]);

/** Tools that must NEVER be gated — replying is part of message reliability. */
const NEVER_GATED = new Set(['hive_send', 'hive_status', 'hive_check']);

/**
 * Deterministic gate decision for one tool call requested during a
 * hive-triggered turn from a non-trusted peer. Unknown tools
 * (discovered/MCP — unknown provenance) are treated as potentially
 * state-changing.
 */
export function isToolGatedForConsult(
  toolName: string,
  lookupKind: (name: string) => string | undefined,
): boolean {
  if (NEVER_GATED.has(toolName)) return false;
  if (GATED_TOOL_NAMES.has(toolName)) return true;
  const kind = lookupKind(toolName);
  if (kind === undefined) return true; // unknown provenance → gated
  return GATED_KINDS.has(kind);
}
