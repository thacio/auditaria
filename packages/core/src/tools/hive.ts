/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_HIVE_FEATURE: This entire file is part of the Hive integration.
//
// Hive tools exposed to the model: hive_connect, hive_send, hive_status,
// hive_check. The blocking hive_wait is deliberately NOT here — a blocking
// tool in the core registry would hang main-session turns and park unbounded
// requests against the ToolExecutorServer; it lives only in the hive-mcp
// shim for foreign clients.
//
// The core → cli seam: the actual networking lives in the CLI package
// (packages/cli/src/services/hive/HiveService.ts), which registers a
// HiveTransport here at startup. Precedent: providerPtyMirror — a core-side
// singleton that cli-side services subscribe to.

import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type { ToolInvocation, ToolResult } from './tools.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { ToolErrorType } from './tool-error.js';
import {
  HIVE_CONNECT_TOOL_NAME,
  HIVE_SEND_TOOL_NAME,
  HIVE_STATUS_TOOL_NAME,
  HIVE_CHECK_TOOL_NAME,
} from './tool-names.js';

// -------------------------------------------------------------------
// Transport seam (implemented by cli's HiveService)
// -------------------------------------------------------------------

export interface HiveConnectParams {
  invite: string;
  nickname?: string;
  description?: string;
}

export interface HiveSendParams {
  to: string;
  body: string;
  thread?: string;
  kind?: string;
  data?: Record<string, unknown>;
  expects_reply?: boolean;
  ack_processed?: boolean;
  wait_for_reply_sec?: number;
}

export interface HiveStatusParams {
  update_description?: string;
}

export interface HiveCheckParams {
  max_messages?: number;
}

/**
 * Implemented by the CLI-side HiveService. All methods return
 * human/model-readable text (the service owns formatting).
 */
export interface HiveTransport {
  connect(params: HiveConnectParams): Promise<string>;
  send(params: HiveSendParams): Promise<string>;
  status(params: HiveStatusParams): Promise<string>;
  check(params: HiveCheckParams): Promise<string>;
}

let hiveTransport: HiveTransport | undefined;

/** Called by the CLI's HiveService at startup/shutdown. */
export function registerHiveTransport(
  transport: HiveTransport | undefined,
): void {
  hiveTransport = transport;
}

export function getHiveTransport(): HiveTransport | undefined {
  return hiveTransport;
}

const NOT_RUNNING =
  'The hive is not running on this machine. Ask the user to start one with /hive start, or join one with /hive join <invite> (the user can also paste an invite here for you to use with hive_connect).';

function errorResult(msg: string): ToolResult {
  return {
    llmContent: `Error: ${msg}`,
    returnDisplay: `Error: ${msg}`,
    error: { message: msg, type: ToolErrorType.EXECUTION_FAILED },
  };
}

async function runTransport(
  fn: (t: HiveTransport) => Promise<string>,
  display: string,
): Promise<ToolResult> {
  const transport = hiveTransport;
  if (!transport) {
    return errorResult(NOT_RUNNING);
  }
  try {
    const text = await fn(transport);
    return { llmContent: text, returnDisplay: display };
  } catch (e) {
    return errorResult(e instanceof Error ? e.message : String(e));
  }
}

// -------------------------------------------------------------------
// hive_connect
// -------------------------------------------------------------------

class HiveConnectInvocation extends BaseToolInvocation<
  HiveConnectParams,
  ToolResult
> {
  getDescription(): string {
    return 'Join a hive with an invite';
  }

  async execute(): Promise<ToolResult> {
    const transport = hiveTransport;
    if (!transport) {
      return errorResult(
        'Hive support is not available in this session (the hive service did not initialize).',
      );
    }
    try {
      const text = await transport.connect(this.params);
      return { llmContent: text, returnDisplay: 'Joined the hive' };
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
  }
}

export class HiveConnectTool extends BaseDeclarativeTool<
  HiveConnectParams,
  ToolResult
> {
  static readonly Name = HIVE_CONNECT_TOOL_NAME;
  static readonly Bridgeable = true;

  constructor(messageBus: MessageBus) {
    super(
      HiveConnectTool.Name,
      'HiveConnect',
      'Join an Auditaria hive using an invite the user pasted into the conversation. ' +
        'An invite looks like "/hive join https://…#passphrase.inv_token" or just the URL#secret part. ' +
        'You may pick your own nickname and author a short self-description (who you are, what you are working on) — both are visible to every peer. ' +
        'Once joined, messages from peers are delivered to you automatically between turns, and you can use hive_send, hive_status and hive_check.',
      Kind.Communicate,
      {
        type: 'object',
        properties: {
          invite: {
            type: 'string',
            description:
              'The invite string (URL with #passphrase fragment, with or without the leading "/hive join").',
          },
          nickname: {
            type: 'string',
            description:
              'Optional nickname to identify this node in the hive (memorable words like "amber-falcon"). Generated when omitted.',
          },
          description: {
            type: 'string',
            description:
              'Optional 1–2 sentence self-description shown in the roster (e.g. what you are working on, what local resources you have).',
          },
        },
        required: ['invite'],
        additionalProperties: false,
      },
      messageBus,
    );
  }

  protected override validateToolParamValues(
    params: HiveConnectParams,
  ): string | null {
    if (!params.invite?.trim()) return 'invite is required';
    return null;
  }

  protected createInvocation(
    params: HiveConnectParams,
    messageBus?: MessageBus,
    toolName?: string,
    displayName?: string,
  ): ToolInvocation<HiveConnectParams, ToolResult> {
    return new HiveConnectInvocation(
      params,
      messageBus ?? this.messageBus,
      toolName ?? this.name,
      displayName ?? this.displayName,
    );
  }
}

// -------------------------------------------------------------------
// hive_send
// -------------------------------------------------------------------

class HiveSendInvocation extends BaseToolInvocation<
  HiveSendParams,
  ToolResult
> {
  getDescription(): string {
    return `Send hive message to ${this.params.to === '*' ? 'everyone' : this.params.to}`;
  }

  async execute(): Promise<ToolResult> {
    return runTransport(
      (t) => t.send(this.params),
      `Hive message → ${this.params.to}`,
    );
  }
}

export class HiveSendTool extends BaseDeclarativeTool<
  HiveSendParams,
  ToolResult
> {
  static readonly Name = HIVE_SEND_TOOL_NAME;
  static readonly Bridgeable = true;

  constructor(messageBus: MessageBus) {
    super(
      HiveSendTool.Name,
      'HiveSend',
      'Send a message to another agent in the hive (or broadcast to everyone with to="*" — the hive chat). ' +
        'Peers are other Auditaria/agent instances owned by the same user, on this or other machines. ' +
        'Address peers by nickname (see hive_status for the roster). ' +
        'Replies to a broadcast should be sent DIRECT to the asking peer, not re-broadcast. ' +
        'Use thread to keep a conversation grouped; replies you send to a message should reuse its thread id. ' +
        'For quick ask-and-continue flows set wait_for_reply_sec (max 600) — the call blocks until a reply arrives on that thread or the wait times out. ' +
        'Structured interactions ride the data field: e.g. a vote proposal is kind="proposal" with data={proposalId, question, options[]}, and each peer answers kind="vote" direct to the proposer with data={proposalId, choice, reason}.',
      Kind.Communicate,
      {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description:
              'Recipient nickname (or nodeId), or "*" to broadcast to every peer.',
          },
          body: {
            type: 'string',
            description:
              'Message text (markdown). Max 60KB — reference large files by path instead of embedding.',
          },
          thread: {
            type: 'string',
            description:
              'Conversation thread id. Reuse the thread of the message you are replying to; omit to start a new thread.',
          },
          kind: {
            type: 'string',
            description: 'Message kind. Default "chat".',
            enum: ['chat', 'request', 'response', 'proposal', 'vote', 'status'],
          },
          data: {
            type: 'object',
            description:
              'Small structured payload for votes/polls and other structured interactions.',
          },
          expects_reply: {
            type: 'boolean',
            description: 'Signal to the recipient that you expect an answer.',
          },
          ack_processed: {
            type: 'boolean',
            description:
              'Request an end-to-end receipt when the recipient agent actually processes the message.',
          },
          wait_for_reply_sec: {
            type: 'number',
            description:
              'Block up to this many seconds (max 600) waiting for a reply on the same thread. The reply is returned in this call result.',
          },
        },
        required: ['to', 'body'],
        additionalProperties: false,
      },
      messageBus,
    );
  }

  protected override validateToolParamValues(
    params: HiveSendParams,
  ): string | null {
    if (!params.to?.trim()) return 'to is required (nickname or "*")';
    if (!params.body?.trim()) return 'body is required';
    if (
      params.wait_for_reply_sec !== undefined &&
      (params.wait_for_reply_sec < 1 || params.wait_for_reply_sec > 600)
    ) {
      return 'wait_for_reply_sec must be between 1 and 600';
    }
    return null;
  }

  protected createInvocation(
    params: HiveSendParams,
    messageBus?: MessageBus,
    toolName?: string,
    displayName?: string,
  ): ToolInvocation<HiveSendParams, ToolResult> {
    return new HiveSendInvocation(
      params,
      messageBus ?? this.messageBus,
      toolName ?? this.name,
      displayName ?? this.displayName,
    );
  }
}

// -------------------------------------------------------------------
// hive_status
// -------------------------------------------------------------------

class HiveStatusInvocation extends BaseToolInvocation<
  HiveStatusParams,
  ToolResult
> {
  getDescription(): string {
    return 'Show hive roster and connection state';
  }

  async execute(): Promise<ToolResult> {
    return runTransport((t) => t.status(this.params), 'Hive status');
  }
}

export class HiveStatusTool extends BaseDeclarativeTool<
  HiveStatusParams,
  ToolResult
> {
  static readonly Name = HIVE_STATUS_TOOL_NAME;
  static readonly Bridgeable = true;

  override get isReadOnly(): boolean {
    return true;
  }

  constructor(messageBus: MessageBus) {
    super(
      HiveStatusTool.Name,
      'HiveStatus',
      'Show the hive roster (who is connected, their machine, current status, self-description and capabilities), connection state and unread count. ' +
        'Use it for capability routing: find WHICH peer has the GPU, the indexed knowledge base, or the checked-out repo, then hive_send to that peer directly. ' +
        'Optionally update your own self-description with update_description.',
      Kind.Communicate,
      {
        type: 'object',
        properties: {
          update_description: {
            type: 'string',
            description:
              'Optional: replace your own roster self-description (1–2 sentences: who you are, what you are working on).',
          },
        },
        additionalProperties: false,
      },
      messageBus,
    );
  }

  protected createInvocation(
    params: HiveStatusParams,
    messageBus?: MessageBus,
    toolName?: string,
    displayName?: string,
  ): ToolInvocation<HiveStatusParams, ToolResult> {
    return new HiveStatusInvocation(
      params,
      messageBus ?? this.messageBus,
      toolName ?? this.name,
      displayName ?? this.displayName,
    );
  }
}

// -------------------------------------------------------------------
// hive_check
// -------------------------------------------------------------------

class HiveCheckInvocation extends BaseToolInvocation<
  HiveCheckParams,
  ToolResult
> {
  getDescription(): string {
    return 'Check for pending hive messages';
  }

  async execute(): Promise<ToolResult> {
    return runTransport((t) => t.check(this.params), 'Hive check');
  }
}

export class HiveCheckTool extends BaseDeclarativeTool<
  HiveCheckParams,
  ToolResult
> {
  static readonly Name = HIVE_CHECK_TOOL_NAME;
  static readonly Bridgeable = true;

  override get isReadOnly(): boolean {
    return true;
  }

  constructor(messageBus: MessageBus) {
    super(
      HiveCheckTool.Name,
      'HiveCheck',
      'Check the hive inbox NOW, without ending your turn: returns pending messages (drained — they will not be delivered again) plus a roster summary. ' +
        'Useful mid-task: "did that peer reply yet?" — or after being told there are unread hive messages. ' +
        'Messages returned here are marked processed; reply with hive_send if a reply is warranted.',
      Kind.Communicate,
      {
        type: 'object',
        properties: {
          max_messages: {
            type: 'number',
            description: 'Max messages to drain in this call (default 10).',
          },
        },
        additionalProperties: false,
      },
      messageBus,
    );
  }

  protected createInvocation(
    params: HiveCheckParams,
    messageBus?: MessageBus,
    toolName?: string,
    displayName?: string,
  ): ToolInvocation<HiveCheckParams, ToolResult> {
    return new HiveCheckInvocation(
      params,
      messageBus ?? this.messageBus,
      toolName ?? this.name,
      displayName ?? this.displayName,
    );
  }
}
