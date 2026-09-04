/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryItem } from '../../../ui/types.js';
import type { PendingToolConfirmation } from '../../../ui/contexts/ToolConfirmationContext.js';
import {
  FakeSocket,
  createTestLogger,
} from '../../../test-utils/webTestSupport.js';
import { Broadcaster } from '../core/broadcaster.js';
import { ClientRegistry } from '../core/clientRegistry.js';
import { InboundRouter } from '../core/inboundRouter.js';
import type { WebFeatureContext } from '../core/types.js';
import { attachmentMetadataMap } from './chatAttachments.js';
import { ChatFeature, type ChatBridge } from './ChatFeature.js';

// The real core package cannot be loaded under plain ESM (pre-existing
// core→browser-agent→core cycle); only the enum is needed here.
vi.mock('@google/gemini-cli-core', () => ({
  ToolConfirmationOutcome: {
    ProceedOnce: 'proceed_once',
    ProceedAlways: 'proceed_always',
    ProceedAlwaysServer: 'proceed_always_server',
    ProceedAlwaysTool: 'proceed_always_tool',
    ModifyWithEditor: 'modify_with_editor',
    Cancel: 'cancel',
  },
}));

function createContext(): WebFeatureContext & {
  logger: ReturnType<typeof createTestLogger>;
} {
  const logger = createTestLogger();
  const clients = new ClientRegistry(50);
  return {
    workspaceRoot: process.cwd(),
    logger,
    clients,
    broadcaster: new Broadcaster(clients, logger),
    inbound: new InboundRouter(logger),
    http: { mount: () => {}, mountHost: () => {} },
    ws: { addEndpoint: () => {} },
  };
}

const item = (type: HistoryItem['type'], id: number): HistoryItem =>
  ({ id, type, text: `t${id}` }) as HistoryItem;

describe('ChatFeature', () => {
  let bridge: ChatBridge;
  let feature: ChatFeature;
  let ctx: ReturnType<typeof createContext>;
  let socket: FakeSocket;

  beforeEach(async () => {
    bridge = {
      submitQuery: vi.fn(),
      abort: vi.fn(),
      respondToConfirmation: vi.fn(),
      onTerminalInput: vi.fn(),
      onModelChangeRequest: vi.fn(),
    };
    feature = new ChatFeature(bridge);
    ctx = createContext();
    await feature.attach(ctx);
    socket = new FakeSocket();
    ctx.clients.add(socket.asWebSocket());
  });

  const dispatch = (message: Record<string, unknown>) =>
    ctx.inbound.dispatch(JSON.stringify(message), socket.asWebSocket());

  describe('inbound', () => {
    it('forwards plain text messages', () => {
      dispatch({ type: 'user_message', content: '  hello  ' });
      expect(bridge.submitQuery).toHaveBeenCalledWith('hello');
    });

    it('drops empty messages', () => {
      dispatch({ type: 'user_message', content: '   ' });
      dispatch({ type: 'user_message', attachments: [] });
      expect(bridge.submitQuery).not.toHaveBeenCalled();
    });

    it('turns attachments into parts and remembers their metadata', () => {
      dispatch({
        type: 'user_message',
        content: 'look',
        attachments: [
          {
            data: 'AAAA',
            mimeType: 'image/png',
            name: 'a.png',
            size: 3,
            type: 'image',
            thumbnail: 'thumb',
          },
          { name: 'no-data.png' },
        ],
      });
      const submitQuery = vi.mocked(bridge.submitQuery ?? vi.fn());
      expect(submitQuery).toHaveBeenCalledTimes(1);
      const parts = submitQuery.mock.calls[0][0] as Array<
        Record<string, unknown>
      >;
      expect(parts).toHaveLength(2);
      expect(parts[0]).toEqual({ text: 'look' });
      expect(parts[1]).toEqual({
        inlineData: { data: 'AAAA', mimeType: 'image/png' },
      });
      expect(attachmentMetadataMap.get(parts[1])).toEqual({
        type: 'image',
        mimeType: 'image/png',
        name: 'a.png',
        size: 3,
        thumbnail: 'thumb',
        icon: undefined,
        displaySize: undefined,
      });
    });

    it('maps confirmation outcomes and rejects unknown ones', () => {
      dispatch({
        type: 'tool_confirmation_response',
        callId: 'c1',
        outcome: 'proceed_always',
        payload: { newContent: 'x' },
      });
      expect(bridge.respondToConfirmation).toHaveBeenCalledWith(
        'c1',
        'proceed_always',
        { newContent: 'x' },
      );

      dispatch({
        type: 'tool_confirmation_response',
        callId: 'c2',
        outcome: 'explode',
      });
      expect(bridge.respondToConfirmation).toHaveBeenCalledTimes(1);
      expect(ctx.logger.error).toHaveBeenCalledWith(
        'Unknown confirmation outcome: explode',
      );
    });

    it('relays interrupts, terminal keys and model changes', () => {
      dispatch({ type: 'interrupt_request' });
      dispatch({ type: 'terminal_input', key: { sequence: '\r' } });
      dispatch({ type: 'terminal_input', key: '' });
      dispatch({ type: 'terminal_input', key: { sequence: 5 } });
      dispatch({
        type: 'set_model_request',
        selection: 'claude-code:opus',
        reasoningEffort: 'high',
      });
      dispatch({ type: 'set_model_request' });

      expect(bridge.abort).toHaveBeenCalledTimes(1);
      expect(bridge.onTerminalInput).toHaveBeenCalledTimes(1);
      expect(bridge.onTerminalInput).toHaveBeenCalledWith({ sequence: '\r' });
      expect(bridge.onModelChangeRequest).toHaveBeenCalledTimes(1);
      expect(bridge.onModelChangeRequest).toHaveBeenCalledWith({
        selection: 'claude-code:opus',
        reasoningEffort: 'high',
      });
    });
  });

  describe('broadcasts and snapshot', () => {
    it('sends the full session snapshot in the documented order', () => {
      feature.setCurrentHistory([item('user', 1)]);
      feature.broadcastSlashCommands([
        { name: 'help', description: '' } as never,
      ]);
      feature.broadcastModelMenuData({ groups: [] });
      feature.broadcastConsoleMessages([]);
      feature.broadcastCliActionRequired({
        active: true,
        reason: 'auth',
        title: 't',
        message: 'm',
      });
      feature.broadcastTerminalCapture({ content: 'x' } as never);
      feature.broadcastLoadingState({ isLoading: true } as never);
      feature.broadcastFooterData({ model: 'm' } as never);
      feature.broadcastInputHistory(['a']);
      feature.broadcastResponseState([{ kind: 'text' } as never]);
      feature.broadcastToolConfirmation({
        callId: 'c1',
      } as PendingToolConfirmation);

      const late = new FakeSocket();
      ctx.clients.add(late.asWebSocket());
      feature.sendInitialState(late.asWebSocket());

      expect(late.types).toEqual([
        'history_sync',
        'slash_commands',
        'model_menu_data',
        'mcp_servers',
        'console_messages',
        'cli_action_required',
        'terminal_capture',
        'loading_state',
        'footer_data',
        'input_history_sync',
        'response_state',
        'tool_confirmation',
      ]);
    });

    it('sends the minimal snapshot for an empty session', () => {
      const late = new FakeSocket();
      feature.sendInitialState(late.asWebSocket());
      expect(late.types).toEqual(['mcp_servers', 'console_messages']);
      expect(late.envelopes[0]['data']).toEqual({
        servers: [],
        blockedServers: [],
      });
    });

    it('finalizes the streaming state when an answer lands', () => {
      feature.broadcastResponseState([{ kind: 'text' } as never]);
      feature.broadcastHistoryItem(item('gemini', 2));
      const late = new FakeSocket();
      feature.sendInitialState(late.asWebSocket());
      expect(late.types).not.toContain('response_state');
      expect(socket.types).toEqual(['response_state', 'history_item']);
      expect(socket.envelopes[0]['ephemeral']).toBe(true);
      expect(socket.envelopes[1]['ephemeral']).toBeUndefined();
    });

    it('strips binary payloads from history items', () => {
      feature.broadcastHistoryItem({
        id: 3,
        type: 'user',
        parts: [{ inlineData: { data: 'AAAA', mimeType: 'image/png' } }],
      } as never);
      expect(socket.envelopes[0]['data']).toEqual({
        id: 3,
        type: 'user',
        parts: [{ text: 'Binary content provided.' }],
      });
    });

    it('tracks pending tool confirmations by call id', () => {
      feature.broadcastToolConfirmation({
        callId: 'c1',
      } as PendingToolConfirmation);
      feature.broadcastToolConfirmation({
        callId: 'c2',
      } as PendingToolConfirmation);
      expect(feature.getActiveToolConfirmationIds()).toEqual(['c1', 'c2']);
      feature.broadcastToolConfirmationRemoval('c1');
      expect(feature.getActiveToolConfirmationIds()).toEqual(['c2']);
      expect(socket.types).toEqual([
        'tool_confirmation',
        'tool_confirmation',
        'tool_confirmation_removal',
      ]);
    });

    it('clears the conversation and transient state', () => {
      feature.setCurrentHistory([item('user', 1)]);
      feature.broadcastLoadingState({ isLoading: true } as never);
      feature.broadcastToolConfirmation({
        callId: 'c1',
      } as PendingToolConfirmation);
      feature.broadcastClear();
      const late = new FakeSocket();
      feature.sendInitialState(late.asWebSocket());
      expect(late.types).toEqual(['mcp_servers', 'console_messages']);
      expect(socket.types.at(-1)).toBe('clear');
    });

    it('records state while detached and sends nothing', async () => {
      await feature.detach();
      feature.broadcastFooterData({ model: 'm' } as never);
      expect(socket.sent).toEqual([]);
      const fresh = createContext();
      await feature.attach(fresh);
      const late = new FakeSocket();
      feature.sendInitialState(late.asWebSocket());
      expect(late.types).toContain('footer_data');
    });

    it('summarizes MCP servers for the client', () => {
      feature.broadcastMCPServers(
        { srv: { description: 'd' } as never },
        [{ name: 'blocked', extensionName: 'ext' }],
        new Map([
          ['srv', [{ name: 'tool', description: 'td', schema: {} } as never]],
        ]),
        new Map([['srv', 'connected']]),
      );
      expect(socket.envelopes[0]['data']).toEqual({
        servers: [
          {
            name: 'srv',
            extensionName: undefined,
            description: 'd',
            status: 'connected',
            oauth: undefined,
            tools: [{ name: 'tool', description: 'td', schema: {} }],
          },
        ],
        blockedServers: [{ name: 'blocked', extensionName: 'ext' }],
      });
    });
  });
});
