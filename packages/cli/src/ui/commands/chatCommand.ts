/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fsPromises from 'node:fs/promises';
import React from 'react';
import { Text } from 'ink';
import { Colors } from '../colors.js';
import {
  CommandContext,
  SlashCommand,
  MessageActionReturn,
  CommandKind,
  SlashCommandActionReturn,
} from './types.js';
import { decodeTagName, t } from '@thacio/auditaria-cli-core';
import path from 'node:path';
import { HistoryItemWithoutId, MessageType } from '../types.js';

interface ChatDetail {
  name: string;
  mtime: Date;
}

const getSavedChatTags = async (
  context: CommandContext,
  mtSortDesc: boolean,
): Promise<ChatDetail[]> => {
  const cfg = context.services.config;
  const geminiDir = cfg?.storage?.getProjectTempDir();
  if (!geminiDir) {
    return [];
  }
  try {
    const file_head = 'checkpoint-';
    const file_tail = '.json';
    const files = await fsPromises.readdir(geminiDir);
    const chatDetails: Array<{ name: string; mtime: Date }> = [];

    for (const file of files) {
      if (file.startsWith(file_head) && file.endsWith(file_tail)) {
        const filePath = path.join(geminiDir, file);
        const stats = await fsPromises.stat(filePath);
        const tagName = file.slice(file_head.length, -file_tail.length);
        chatDetails.push({
          name: decodeTagName(tagName),
          mtime: stats.mtime,
        });
      }
    }

    chatDetails.sort((a, b) =>
      mtSortDesc
        ? b.mtime.getTime() - a.mtime.getTime()
        : a.mtime.getTime() - b.mtime.getTime(),
    );

    return chatDetails;
  } catch (_err) {
    return [];
  }
};

const listCommand: SlashCommand = {
  name: 'list',
  get description() {
    return t('commands.chat.list.description', 'List saved conversation checkpoints');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context): Promise<MessageActionReturn> => {
    const chatDetails = await getSavedChatTags(context, false);
    if (chatDetails.length === 0) {
      return {
        type: 'message',
        messageType: 'info',
        content: t('commands.chat.list.no_checkpoints', 'No saved conversation checkpoints found.'),
      };
    }

    const maxNameLength = Math.max(
      ...chatDetails.map((chat) => chat.name.length),
    );

    let message = t('commands.chat.list.header', 'List of saved conversations:\n\n');
    for (const chat of chatDetails) {
      const paddedName = chat.name.padEnd(maxNameLength, ' ');
      const isoString = chat.mtime.toISOString();
      const match = isoString.match(/(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
      const formattedDate = match ? `${match[1]} ${match[2]}` : t('commands.chat.list.invalid_date', 'Invalid Date');
      message += `  - \u001b[36m${paddedName}\u001b[0m  \u001b[90m${t('commands.chat.list.saved_on', '(saved on {date})', { date: formattedDate })}\u001b[0m\n`;
    }
    message += `\n\u001b[90m${t('commands.chat.list.note', 'Note: Newest last, oldest first')}\u001b[0m`;
    return {
      type: 'message',
      messageType: 'info',
      content: message,
    };
  },
};

const saveCommand: SlashCommand = {
  name: 'save',
  get description() {
    return t('commands.chat.save.description', 'Save the current conversation as a checkpoint. Usage: /chat save <tag>');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<SlashCommandActionReturn | void> => {
    const tag = args.trim();
    if (!tag) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('commands.chat.save.missing_tag', 'Missing tag. Usage: /chat save <tag>'),
      };
    }

    const { logger, config } = context.services;
    await logger.initialize();

    if (!context.overwriteConfirmed) {
      const exists = await logger.checkpointExists(tag);
      if (exists) {
        return {
          type: 'confirm_action',
          prompt: React.createElement(
            Text,
            null,
            t('commands.chat.save.overwrite_confirmation_prefix', 'A checkpoint with the tag '),
            React.createElement(Text, { color: Colors.AccentPurple }, tag),
            t('commands.chat.save.overwrite_confirmation_suffix', ' already exists. Do you want to overwrite it?'),
          ),
          originalInvocation: {
            raw: context.invocation?.raw || `/chat save ${tag}`,
          },
        };
      }
    }

    const chat = await config?.getGeminiClient()?.getChat();
    if (!chat) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('commands.chat.save.no_client', 'No chat client available to save conversation.'),
      };
    }

    const history = chat.getHistory();
    if (history.length > 2) {
      await logger.saveCheckpoint(history, tag);
      return {
        type: 'message',
        messageType: 'info',
        content: t('commands.chat.save.saved', 'Conversation checkpoint saved with tag: {tag}.', { tag: decodeTagName(tag) }),
      };
    } else {
      return {
        type: 'message',
        messageType: 'info',
        content: t('commands.chat.save.no_conversation', 'No conversation found to save.'),
      };
    }
  },
};

const resumeCommand: SlashCommand = {
  name: 'resume',
  altNames: ['load'],
  get description() {
    return t('commands.chat.resume.description', 'Resume a conversation from a checkpoint. Usage: /chat resume <tag>');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context, args) => {
    const tag = args.trim();
    if (!tag) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('commands.chat.resume.missing_tag', 'Missing tag. Usage: /chat resume <tag>'),
      };
    }

    const { logger } = context.services;
    await logger.initialize();
    const conversation = await logger.loadCheckpoint(tag);

    if (conversation.length === 0) {
      return {
        type: 'message',
        messageType: 'info',
        content: t('commands.chat.resume.not_found', 'No saved checkpoint found with tag: {tag}.', { tag: decodeTagName(tag) }),
      };
    }

    const rolemap: { [key: string]: MessageType } = {
      user: MessageType.USER,
      model: MessageType.GEMINI,
    };

    const uiHistory: HistoryItemWithoutId[] = [];
    let hasSystemPrompt = false;
    let i = 0;

    for (const item of conversation) {
      i += 1;
      const text =
        item.parts
          ?.filter((m) => !!m.text)
          .map((m) => m.text)
          .join('') || '';
      if (!text) {
        continue;
      }
      if (i === 1 && text.match(/context for our chat/)) {
        hasSystemPrompt = true;
      }
      if (i > 2 || !hasSystemPrompt) {
        uiHistory.push({
          type: (item.role && rolemap[item.role]) || MessageType.GEMINI,
          text,
        } as HistoryItemWithoutId);
      }
    }
    return {
      type: 'load_history',
      history: uiHistory,
      clientHistory: conversation,
    };
  },
  completion: async (context, partialArg) => {
    const chatDetails = await getSavedChatTags(context, true);
    return chatDetails
      .map((chat) => chat.name)
      .filter((name) => name.startsWith(partialArg));
  },
};

const deleteCommand: SlashCommand = {
  name: 'delete',
  get description() {
    return t('commands.chat.delete.description', 'Delete a conversation checkpoint. Usage: /chat delete <tag>');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<MessageActionReturn> => {
    const tag = args.trim();
    if (!tag) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('commands.chat.delete.missing_tag', 'Missing tag. Usage: /chat delete <tag>'),
      };
    }

    const { logger } = context.services;
    await logger.initialize();
    const deleted = await logger.deleteCheckpoint(tag);

    if (deleted) {
      return {
        type: 'message',
        messageType: 'info',
        content: t('commands.chat.delete.deleted', "Conversation checkpoint '{tag}' has been deleted.", { tag: decodeTagName(tag) }),
      };
    } else {
      return {
        type: 'message',
        messageType: 'error',
        content: t('commands.chat.delete.not_found', "Error: No checkpoint found with tag '{tag}'.", { tag: decodeTagName(tag) }),
      };
    }
  },
  completion: async (context, partialArg) => {
    const chatDetails = await getSavedChatTags(context, true);
    return chatDetails
      .map((chat) => chat.name)
      .filter((name) => name.startsWith(partialArg));
  },
};

export const chatCommand: SlashCommand = {
  name: 'chat',
  get description() {
    return t('commands.chat.description', 'Manage conversation history. Usage: /chat <list|save|resume> <tag>');
  },
  kind: CommandKind.BUILT_IN,
  subCommands: [listCommand, saveCommand, resumeCommand, deleteCommand],
};
