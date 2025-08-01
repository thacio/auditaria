/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { HistoryItemCompression, MessageType } from '../types.js';
import { CommandKind, SlashCommand } from './types.js';
import { t } from '@thacio/auditaria-cli-core';

export const compressCommand: SlashCommand = {
  name: 'compress',
  altNames: ['summarize'],
  get description() {
    return t('commands.compress.description', 'Compresses the context by replacing it with a summary.');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context) => {
    const { ui } = context;
    if (ui.pendingItem) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('commands.compress.already_compressing', 'Already compressing, wait for previous request to complete'),
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
      },
    };

    try {
      ui.setPendingItem(pendingMessage);
      const promptId = `compress-${Date.now()}`;
      const compressed = await context.services.config
        ?.getGeminiClient()
        ?.tryCompressChat(promptId, true);
      if (compressed) {
        ui.addItem(
          {
            type: MessageType.COMPRESSION,
            compression: {
              isPending: false,
              originalTokenCount: compressed.originalTokenCount,
              newTokenCount: compressed.newTokenCount,
            },
          } as HistoryItemCompression,
          Date.now(),
        );
      } else {
        ui.addItem(
          {
            type: MessageType.ERROR,
            text: t('commands.compress.failed', 'Failed to compress chat history.'),
          },
          Date.now(),
        );
      }
    } catch (e) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('commands.compress.failed_error', 'Failed to compress chat history: {error}', { error: e instanceof Error ? e.message : String(e) }),
        },
        Date.now(),
      );
    } finally {
      ui.setPendingItem(null);
    }
  },
};
