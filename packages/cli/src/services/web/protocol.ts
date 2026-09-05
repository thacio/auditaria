/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

/**
 * Wire protocol shared by the web server and the browser client
 * (`packages/web-client/src/managers/WebSocketManager.js`).
 *
 * Every message travelling over the chat WebSocket is a JSON envelope:
 *
 *   { type, data, sequence, timestamp, ephemeral? }
 *
 * `sequence` is a per-connection monotonic counter the client uses to detect
 * gaps and request a resync; `ephemeral` marks transient UI state (loading
 * spinner, streaming blocks) that must never be replayed after a gap.
 *
 * This module is the single source of truth for the message vocabulary in
 * both directions. Adding a message type means adding it here first — the
 * union types make a typo a compile error at every call site.
 */

/** Messages the server pushes to chat clients. */
export type ServerMessageType =
  // Transport / resilience
  | 'connection'
  | 'force_resync'
  // Chat session snapshot + live updates
  | 'history_sync'
  | 'history_item'
  | 'response_state'
  | 'loading_state'
  | 'footer_data'
  | 'input_history_sync'
  | 'slash_commands'
  | 'model_menu_data'
  | 'mcp_servers'
  | 'console_messages'
  | 'cli_action_required'
  | 'terminal_capture'
  | 'tool_confirmation'
  | 'tool_confirmation_removal'
  | 'tool_result'
  | 'clear'
  // Provider terminal mirror (Claude / Copilot PTY)
  | 'provider_pty_state'
  | 'provider_pty_data'
  | 'provider_pty_open'
  | 'provider_screen_data'
  // File browser / editor
  | 'file_tree_response'
  | 'file_tree_children_response'
  | 'file_tree_search_response'
  | 'file_read_response'
  | 'file_write_response'
  | 'file_create_response'
  | 'file_delete_response'
  | 'file_rename_response'
  | 'file_open_system_response'
  | 'file_reveal_response'
  | 'file_operation_error'
  | 'directory_change_notification'
  | 'file_external_change'
  | 'file_external_delete'
  | 'file_watch_error'
  // DOCX parser + WYSIWYG AST bridge
  | 'parser_status'
  | 'parse_response'
  | 'parse_error'
  | 'ast_spec_response'
  | 'md_to_ast_response'
  | 'ast_to_md_response'
  | 'docx_to_md_response'
  | 'ast_error'
  // Knowledge base
  | 'knowledge_base_status'
  | 'knowledge_base_init_response'
  | 'knowledge_base_resume_response'
  | 'knowledge_base_reindex_progress'
  | 'knowledge_base_autoindex_response'
  | 'knowledge_base_search_response'
  // Collaborative writing
  | 'collaborative_writing_status'
  | 'collaborative_writing_toggle_result'
  // Artifacts (gallery + viewer)
  | 'artifact_list'
  | 'artifact_event'
  | 'artifact_versions_response'
  | 'artifact_open'
  | 'artifact_share_state'
  | 'artifact_comments_response'
  | 'artifact_comment_event'
  | 'artifact_download_offer';

/** Messages chat clients send to the server. */
export type ClientMessageType =
  // Transport / resilience
  | 'ack'
  | 'resync_request'
  // Chat
  | 'user_message'
  | 'interrupt_request'
  | 'tool_confirmation_response'
  | 'terminal_input'
  | 'set_model_request'
  // Provider terminal mirror
  | 'provider_pty_input'
  | 'provider_pty_resize'
  | 'provider_pty_refresh'
  // File browser / editor
  | 'file_tree_request'
  | 'file_tree_children_request'
  | 'file_tree_search_request'
  | 'file_read_request'
  | 'file_write_request'
  | 'file_create_request'
  | 'file_delete_request'
  | 'file_rename_request'
  | 'file_open_system'
  | 'file_reveal_request'
  | 'file_watch_request'
  | 'file_unwatch_request'
  // DOCX parser + WYSIWYG AST bridge
  | 'parser_status_request'
  | 'parse_request'
  | 'ast_spec_request'
  | 'md_to_ast_request'
  | 'ast_to_md_request'
  | 'docx_to_md_request'
  // Knowledge base
  | 'knowledge_base_status_request'
  | 'knowledge_base_init_request'
  | 'knowledge_base_resume_request'
  | 'knowledge_base_reindex_request'
  | 'knowledge_base_autoindex_request'
  | 'knowledge_base_search_request'
  // Collaborative writing
  | 'collaborative_writing_status_request'
  | 'collaborative_writing_toggle'
  // Artifacts (gallery + viewer)
  | 'artifact_list_request'
  | 'artifact_versions_request'
  | 'artifact_update_request'
  | 'artifact_delete_request'
  | 'artifact_restore_request'
  | 'artifact_share_request'
  | 'artifact_comments_request'
  | 'artifact_comment_request'
  | 'artifact_download_decision';

/**
 * Message types that are full state snapshots. The per-client replay buffer
 * keeps only the latest one of each instead of accumulating history — a file
 * tree snapshot can be several megabytes and only the newest matters.
 * NOTE: `console_messages` is intentionally NOT included — the user needs to
 * see the live log stream.
 */
export const LATEST_ONLY_MESSAGE_TYPES: ReadonlySet<ServerMessageType> =
  new Set<ServerMessageType>([
    'file_tree_response',
    'file_tree_search_response',
    'mcp_servers',
    'slash_commands',
    'model_menu_data',
    'response_state',
    'input_history_sync',
    'artifact_list',
  ]);

/** Envelope for every sequenced server → client message. */
export interface ServerEnvelope<T = unknown> {
  readonly type: ServerMessageType;
  readonly data: T;
  readonly sequence: number;
  readonly timestamp: number;
  readonly ephemeral?: true;
}

/**
 * A parsed inbound message. Only `type` is guaranteed; every other field is
 * caller-supplied and must be validated with the `read*` helpers below.
 */
export type ClientMessage = {
  readonly type: string;
} & Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates a JSON-parsed value as a client message envelope. */
export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!isRecord(value)) {
    return null;
  }
  const type = value['type'];
  if (typeof type !== 'string') {
    return null;
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return value as ClientMessage;
}

export function readString(
  message: ClientMessage,
  key: string,
): string | undefined {
  const value = message[key];
  return typeof value === 'string' ? value : undefined;
}

export function readNumber(
  message: ClientMessage,
  key: string,
): number | undefined {
  const value = message[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

export function readBoolean(
  message: ClientMessage,
  key: string,
): boolean | undefined {
  const value = message[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** `requestId` correlates request/response pairs for promise-style clients. */
export function readRequestId(message: ClientMessage): string | undefined {
  return readString(message, 'requestId');
}

/**
 * JSON.stringify replacer that strips binary blobs from history payloads
 * before they go over the wire. Handles the Gemini part shapes
 * (`inlineData` / `fileData`) and Claude's `{ type: 'image', source: { type:
 * 'base64' } }` blocks.
 */
export function webSafeReplacer(_key: string, value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  if (('inlineData' in value || 'fileData' in value) && !('text' in value)) {
    return { text: 'Binary content provided.' };
  }
  const source = value['source'];
  if (
    value['type'] === 'image' &&
    isRecord(source) &&
    source['type'] === 'base64'
  ) {
    return { type: 'text', text: 'Binary content provided.' };
  }
  return value;
}
