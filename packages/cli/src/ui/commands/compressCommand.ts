/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { MessageType, type HistoryItemCompression } from '../types.js';
import { CommandKind, type SlashCommand } from './types.js';
import { getCompressionText } from '../components/messages/CompressionMessage.js';
import { getProviderCapabilities } from '@google/gemini-cli-core';

export const compressCommand: SlashCommand = {
  name: 'compress',
  altNames: ['summarize', 'compact'],
  description: 'Compresses the context by replacing it with a summary',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context) => {
    const { ui } = context;
    const capabilities = getProviderCapabilities(
      context.services.agentContext?.config?.getProviderConfig?.()?.type,
    );
    const provider =
      capabilities.contextOwner === 'provider' ? capabilities.name : undefined;
    if (ui.pendingItem) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Already compressing, wait for previous request to complete',
        },
        Date.now(),
      );
      return;
    }

    const pendingMessage: HistoryItemCompression = {
      type: MessageType.COMPRESSION,
      compression: {
        isPending: true,
        originalTokenCount: null,
        newTokenCount: null,
        compressionStatus: null,
        ...(provider ? { provider } : {}),
      },
    };

    if (provider)
      pendingMessage.compression.message = getCompressionText(
        pendingMessage.compression,
      );
    ui.setPendingItem(pendingMessage);

    void (async () => {
      try {
        const promptId = `compress-${Date.now()}`;
        const compressed =
          await context.services.agentContext?.geminiClient?.tryCompressChat(
            promptId,
            true,
          );
        if (compressed) {
          ui.addItem(
            {
              type: MessageType.COMPRESSION,
              compression: {
                isPending: false,
                originalTokenCount: compressed.originalTokenCount,
                newTokenCount: compressed.newTokenCount,
                compressionStatus: compressed.compressionStatus,
                ...(compressed.provider
                  ? { provider: compressed.provider }
                  : {}),
                ...(compressed.detail ? { detail: compressed.detail } : {}),
                ...(compressed.provider
                  ? {
                      message: getCompressionText({
                        ...compressed,
                        isPending: false,
                      }),
                    }
                  : {}),
              },
            } as HistoryItemCompression,
            Date.now(),
          );
        } else {
          ui.addItem(
            {
              type: MessageType.ERROR,
              text: 'Failed to compress chat history.',
            },
            Date.now(),
          );
        }
      } catch (e) {
        ui.addItem(
          {
            type: MessageType.ERROR,
            text: `Failed to compress chat history: ${
              e instanceof Error ? e.message : String(e)
            }`,
          },
          Date.now(),
        );
      } finally {
        ui.setPendingItem(null);
      }
    })();
  },
};
