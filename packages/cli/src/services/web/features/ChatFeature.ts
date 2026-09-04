/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import type { WebSocket } from 'ws';
import type { PartListUnion } from '@google/genai';
import {
  ToolConfirmationOutcome,
  type DiscoveredMCPTool,
  type MCPServerConfig,
  type ToolConfirmationPayload,
} from '@google/gemini-cli-core';
import type {
  ConsoleMessageItem,
  HistoryItem,
  ResponseBlock,
} from '../../../ui/types.js';
import type { FooterData } from '../../../ui/contexts/FooterContext.js';
import type { LoadingStateData } from '../../../ui/contexts/LoadingStateContext.js';
import type { PendingToolConfirmation } from '../../../ui/contexts/ToolConfirmationContext.js';
import type { SlashCommand } from '../../../ui/commands/types.js';
import type { TerminalCaptureData } from '../../../ui/contexts/TerminalCaptureContext.js';
import { WebFeature } from '../core/webFeature.js';
import type { WebFeatureContext } from '../core/types.js';
import { isRecord, readString, webSafeReplacer } from '../protocol.js';
import { buildQueryFromUserMessage } from './chatAttachments.js';

/**
 * Callbacks into the CLI session. The service owns one mutable instance and
 * exposes setters for it; the feature only ever reads it, so a handler
 * registered after the server started is picked up immediately.
 */
export interface ChatBridge {
  submitQuery?: (query: PartListUnion) => void;
  abort?: () => void;
  respondToConfirmation?: (
    callId: string,
    outcome: ToolConfirmationOutcome,
    payload?: ToolConfirmationPayload,
  ) => void;
  onTerminalInput?: (key: WebTerminalKeyInput) => void;
  onModelChangeRequest?: (request: ModelChangeRequest) => void;
}

export interface ModelChangeRequest {
  readonly selection: string;
  readonly reasoningEffort?: string;
}

/** Key descriptor the web client sends for CLI-captured dialogs. */
export interface WebTerminalKeyInput {
  readonly name?: string;
  readonly sequence?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

const KEY_STRING_FIELDS = ['name', 'sequence'] as const;
const KEY_FLAG_FIELDS = ['ctrl', 'meta', 'shift', 'alt'] as const;

function isTerminalKeyInput(value: unknown): value is WebTerminalKeyInput {
  if (!isRecord(value)) return false;
  const stringsOk = KEY_STRING_FIELDS.every((field) => {
    const v = value[field];
    return v === undefined || typeof v === 'string';
  });
  const flagsOk = KEY_FLAG_FIELDS.every((field) => {
    const v = value[field];
    return v === undefined || typeof v === 'boolean';
  });
  return stringsOk && flagsOk;
}

export interface CliActionState {
  readonly active: boolean;
  readonly reason: string;
  readonly title: string;
  readonly message: string;
}

/** Model selector menu as rendered by the web footer (built by the CLI). */
export interface WebModelMenuData {
  readonly groups: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly options?: ReadonlyArray<{
      readonly selection: string;
      readonly label: string;
    }>;
  }>;
}

export interface McpServerSnapshot {
  readonly name: string;
  readonly extensionName?: string;
  readonly description?: string;
  readonly status: string;
  readonly oauth?: MCPServerConfig['oauth'];
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description: string | undefined;
    readonly schema: DiscoveredMCPTool['schema'];
  }>;
}

export interface McpServersSnapshot {
  readonly servers: readonly McpServerSnapshot[];
  readonly blockedServers: ReadonlyArray<{
    name: string;
    extensionName: string;
  }>;
}

/** Web-client outcome strings → core enum. */
const CONFIRMATION_OUTCOMES: Readonly<Record<string, ToolConfirmationOutcome>> =
  {
    proceed_once: ToolConfirmationOutcome.ProceedOnce,
    proceed_always: ToolConfirmationOutcome.ProceedAlways,
    proceed_always_server: ToolConfirmationOutcome.ProceedAlwaysServer,
    proceed_always_tool: ToolConfirmationOutcome.ProceedAlwaysTool,
    modify_with_editor: ToolConfirmationOutcome.ModifyWithEditor,
    cancel: ToolConfirmationOutcome.Cancel,
  };

/** History item types after which the streaming response state is final. */
const FINALIZING_HISTORY_TYPES: ReadonlySet<HistoryItem['type']> = new Set<
  HistoryItem['type']
>(['gemini', 'gemini_content', 'tool_group']);

/**
 * Everything a late-joining client needs to render the session as the CLI
 * currently shows it. Persistent state (history, commands, servers, …) and
 * ephemeral state (spinner, streaming blocks, pending confirmations) are
 * both kept so a reconnect mid-turn paints correctly.
 */
class ChatSessionState {
  history: readonly HistoryItem[] = [];
  responseBlocks: ResponseBlock[] | null = null;
  loadingState: LoadingStateData | null = null;
  footerData: FooterData | null = null;
  inputHistory: readonly string[] = [];
  slashCommands: readonly SlashCommand[] = [];
  modelMenuData: WebModelMenuData | null = null;
  mcpServers: McpServersSnapshot = { servers: [], blockedServers: [] };
  consoleMessages: readonly ConsoleMessageItem[] = [];
  cliAction: CliActionState | null = null;
  terminalCapture: TerminalCaptureData | null = null;
  readonly toolConfirmations = new Map<string, PendingToolConfirmation>();

  /** `/clear` — drop the conversation and everything transient. */
  clear(): void {
    this.history = [];
    this.responseBlocks = null;
    this.loadingState = null;
    this.toolConfirmations.clear();
  }
}

/**
 * Mirrors the CLI chat session to web clients and forwards their input back:
 * user messages (with attachments), interrupts, tool confirmations, raw
 * terminal keystrokes for interactive dialogs, and model selection.
 */
export class ChatFeature extends WebFeature {
  readonly name = 'chat';
  private readonly state = new ChatSessionState();

  constructor(private readonly bridge: ChatBridge) {
    super();
  }

  protected onAttach(ctx: WebFeatureContext): void {
    const { inbound, logger } = ctx;

    inbound.on('user_message', (message) => {
      const submitQuery = this.bridge.submitQuery;
      if (!submitQuery) return;
      const text = readString(message, 'content')?.trim() ?? '';
      const query = buildQueryFromUserMessage(
        text,
        message['attachments'],
        logger,
      );
      if (query !== null) submitQuery(query);
    });

    inbound.on('interrupt_request', () => {
      this.bridge.abort?.();
    });

    inbound.on('tool_confirmation_response', (message) => {
      const callId = readString(message, 'callId');
      const outcomeName = readString(message, 'outcome');
      if (!callId || !outcomeName) return;
      const outcome = CONFIRMATION_OUTCOMES[outcomeName];
      if (outcome === undefined) {
        logger.error(`Unknown confirmation outcome: ${outcomeName}`);
        return;
      }
      // Client-supplied and forwarded opaquely; the CLI validates it per outcome.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const payload = message['payload'] as ToolConfirmationPayload | undefined;
      this.bridge.respondToConfirmation?.(callId, outcome, payload);
    });

    inbound.on('terminal_input', (message) => {
      const key = message['key'];
      if (isTerminalKeyInput(key)) this.bridge.onTerminalInput?.(key);
    });

    inbound.on('set_model_request', (message) => {
      const selection = readString(message, 'selection');
      if (!selection) return;
      this.bridge.onModelChangeRequest?.({
        selection,
        reasoningEffort: readString(message, 'reasoningEffort'),
      });
    });
  }

  override sendInitialState(ws: WebSocket): void {
    const s = this.state;
    const replacer = { replacer: webSafeReplacer };

    if (s.history.length > 0) {
      this.send(ws, 'history_sync', { history: s.history }, replacer);
    }
    if (s.slashCommands.length > 0) {
      this.send(ws, 'slash_commands', { commands: s.slashCommands });
    }
    if (s.modelMenuData) {
      this.send(ws, 'model_menu_data', s.modelMenuData);
    }
    // Always sent, even when empty, so the client can render the panels.
    this.send(ws, 'mcp_servers', s.mcpServers);
    this.send(ws, 'console_messages', s.consoleMessages);
    if (s.cliAction?.active) {
      this.send(ws, 'cli_action_required', s.cliAction);
    }
    if (s.terminalCapture?.content) {
      this.send(ws, 'terminal_capture', s.terminalCapture);
    }
    if (s.loadingState) {
      this.send(ws, 'loading_state', s.loadingState);
    }
    if (s.footerData) {
      this.send(ws, 'footer_data', s.footerData);
    }
    if (s.inputHistory.length > 0) {
      this.send(ws, 'input_history_sync', { history: s.inputHistory });
    }
    if (s.responseBlocks) {
      this.send(ws, 'response_state', s.responseBlocks, replacer);
    }
    for (const confirmation of s.toolConfirmations.values()) {
      this.send(ws, 'tool_confirmation', confirmation);
    }
  }

  // ---------------------------------------------------------------------
  // CLI → web
  // ---------------------------------------------------------------------

  /** Replaces the history snapshot sent to late joiners (no broadcast). */
  setCurrentHistory(history: readonly HistoryItem[]): void {
    this.state.history = history;
  }

  broadcastHistoryItem(item: HistoryItem): void {
    if (FINALIZING_HISTORY_TYPES.has(item.type)) {
      this.state.responseBlocks = null;
    }
    this.broadcast('history_item', item, { replacer: webSafeReplacer });
  }

  broadcastResponseState(blocks: ResponseBlock[] | null): void {
    this.state.responseBlocks = blocks;
    this.broadcast('response_state', blocks, {
      ephemeral: true,
      replacer: webSafeReplacer,
    });
  }

  broadcastLoadingState(loadingState: LoadingStateData): void {
    this.state.loadingState = loadingState;
    this.broadcast('loading_state', loadingState, { ephemeral: true });
  }

  broadcastFooterData(footerData: FooterData): void {
    this.state.footerData = footerData;
    this.broadcast('footer_data', footerData);
  }

  broadcastInputHistory(history: readonly string[]): void {
    this.state.inputHistory = history;
    this.broadcast('input_history_sync', { history });
  }

  broadcastSlashCommands(commands: readonly SlashCommand[]): void {
    this.state.slashCommands = commands;
    this.broadcast('slash_commands', { commands });
  }

  broadcastModelMenuData(modelMenuData: WebModelMenuData): void {
    this.state.modelMenuData = modelMenuData;
    this.broadcast('model_menu_data', modelMenuData);
  }

  broadcastMCPServers(
    mcpServers: Record<string, MCPServerConfig>,
    blockedMcpServers: Array<{ name: string; extensionName: string }>,
    serverTools: Map<string, DiscoveredMCPTool[]>,
    serverStatuses: Map<string, string>,
  ): void {
    const servers = Object.entries(mcpServers).map(
      ([name, config]): McpServerSnapshot => ({
        name,
        extensionName: config.extension?.name,
        description: config.description,
        status: serverStatuses.get(name) ?? 'disconnected',
        oauth: config.oauth,
        tools: (serverTools.get(name) ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          schema: tool.schema,
        })),
      }),
    );
    this.state.mcpServers = { servers, blockedServers: blockedMcpServers };
    this.broadcast('mcp_servers', this.state.mcpServers);
  }

  broadcastConsoleMessages(messages: readonly ConsoleMessageItem[]): void {
    this.state.consoleMessages = messages;
    this.broadcast('console_messages', messages);
  }

  broadcastCliActionRequired(action: CliActionState): void {
    this.state.cliAction = action.active ? action : null;
    this.broadcast('cli_action_required', action);
  }

  broadcastTerminalCapture(data: TerminalCaptureData): void {
    this.state.terminalCapture = data.content ? data : null;
    this.broadcast('terminal_capture', data);
  }

  broadcastToolConfirmation(confirmation: PendingToolConfirmation): void {
    if (confirmation.callId) {
      this.state.toolConfirmations.set(confirmation.callId, confirmation);
    }
    this.broadcast('tool_confirmation', confirmation);
  }

  broadcastToolConfirmationRemoval(callId: string): void {
    this.state.toolConfirmations.delete(callId);
    this.broadcast('tool_confirmation_removal', { callId });
  }

  broadcastToolResult(callId: string, isOk: boolean, result: unknown): void {
    this.broadcast('tool_result', { callId, isOk, result });
  }

  broadcastClear(): void {
    this.state.clear();
    this.broadcast('clear', null);
  }

  /** Call ids of confirmations still awaiting a response. */
  getActiveToolConfirmationIds(): string[] {
    return Array.from(this.state.toolConfirmations.keys());
  }
}
