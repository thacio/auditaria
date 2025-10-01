/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useMemo, useEffect, useState } from 'react';
import { type PartListUnion } from '@google/genai';
import process from 'node:process';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import type { Config } from '@thacio/auditaria-cli-core';
import {
  GitService,
  Logger,
  MCPDiscoveryState,
  MCPServerStatus,
  getMCPDiscoveryState,
  getMCPServerStatus,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_FLASH_MODEL,
  logSlashCommand,
  makeSlashCommandEvent,
  SlashCommandStatus,
  ToolConfirmationOutcome,
  Storage,
  t,
  IdeClient,
} from '@thacio/auditaria-cli-core';
import { useSessionStats } from '../contexts/SessionContext.js';
import type {
  Message,
  HistoryItemWithoutId,
  SlashCommandProcessorResult,
  HistoryItem,
} from '../types.js';
import { MessageType } from '../types.js';
// WEB_INTERFACE_START: Web commands hook import
import { useWebCommands } from './useWebCommands.js';
// WEB_INTERFACE_END
import type { LoadedSettings } from '../../config/settings.js';
import { type CommandContext, type SlashCommand } from '../commands/types.js';
import { CommandService } from '../../services/CommandService.js';
import { BuiltinCommandLoader } from '../../services/BuiltinCommandLoader.js';
import { FileCommandLoader } from '../../services/FileCommandLoader.js';
import { McpPromptLoader } from '../../services/McpPromptLoader.js';

interface SlashCommandProcessorActions {
  openAuthDialog: () => void;
  openThemeDialog: () => void;
  openEditorDialog: () => void;
  openLanguageDialog: () => void;
  openPrivacyNotice: () => void;
  openSettingsDialog: () => void;
  quit: (messages: HistoryItem[]) => void;
  setDebugMessage: (message: string) => void;
  toggleCorgiMode: () => void;
}

/**
 * Hook to define and process slash commands (e.g., /help, /clear).
 */
export const useSlashCommandProcessor = (
  config: Config | null,
  settings: LoadedSettings,
  addItem: UseHistoryManagerReturn['addItem'],
  clearItems: UseHistoryManagerReturn['clearItems'],
  loadHistory: UseHistoryManagerReturn['loadHistory'],
  refreshStatic: () => void,
  toggleVimEnabled: () => Promise<boolean>,
  setIsProcessing: (isProcessing: boolean) => void,
  setGeminiMdFileCount: (count: number) => void,
  actions: SlashCommandProcessorActions,
) => {
  const session = useSessionStats();
  // WEB_INTERFACE_START: Web commands handlers
  const { handleWebStart, handleWebStop, handleWebStatus } = useWebCommands();
  // WEB_INTERFACE_END
  const [commands, setCommands] = useState<readonly SlashCommand[]>([]);
  const [reloadTrigger, setReloadTrigger] = useState(0);

  const reloadCommands = useCallback(() => {
    setReloadTrigger((v) => v + 1);
  }, []);
  const [shellConfirmationRequest, setShellConfirmationRequest] =
    useState<null | {
      commands: string[];
      onConfirm: (
        outcome: ToolConfirmationOutcome,
        approvedCommands?: string[],
      ) => void;
    }>(null);
  const [confirmationRequest, setConfirmationRequest] = useState<null | {
    prompt: React.ReactNode;
    onConfirm: (confirmed: boolean) => void;
  }>(null);

  const [sessionShellAllowlist, setSessionShellAllowlist] = useState(
    new Set<string>(),
  );
  const gitService = useMemo(() => {
    if (!config?.getProjectRoot()) {
      return;
    }
    return new GitService(config.getProjectRoot(), config.storage);
  }, [config]);

  const logger = useMemo(() => {
    const l = new Logger(
      config?.getSessionId() || '',
      config?.storage ?? new Storage(process.cwd()),
    );
    // The logger's initialize is async, but we can create the instance
    // synchronously. Commands that use it will await its initialization.
    return l;
  }, [config]);

  const [pendingCompressionItem, setPendingCompressionItem] =
    useState<HistoryItemWithoutId | null>(null);

  const pendingHistoryItems = useMemo(() => {
    const items: HistoryItemWithoutId[] = [];
    if (pendingCompressionItem != null) {
      items.push(pendingCompressionItem);
    }
    return items;
  }, [pendingCompressionItem]);

  const addMessage = useCallback(
    (message: Message) => {
      // Convert Message to HistoryItemWithoutId
      let historyItemContent: HistoryItemWithoutId;
      if (message.type === MessageType.ABOUT) {
        historyItemContent = {
          type: 'about',
          cliVersion: message.cliVersion,
          osVersion: message.osVersion,
          sandboxEnv: message.sandboxEnv,
          modelVersion: message.modelVersion,
          selectedAuthType: message.selectedAuthType,
          gcpProject: message.gcpProject,
          ideClient: message.ideClient,
        };
      } else if (message.type === MessageType.HELP) {
        historyItemContent = {
          type: 'help',
          timestamp: message.timestamp,
        };
      } else if (message.type === MessageType.STATS) {
        historyItemContent = {
          type: 'stats',
          duration: message.duration,
        };
      } else if (message.type === MessageType.MODEL_STATS) {
        historyItemContent = {
          type: 'model_stats',
        };
      } else if (message.type === MessageType.TOOL_STATS) {
        historyItemContent = {
          type: 'tool_stats',
        };
      } else if (message.type === MessageType.QUIT) {
        historyItemContent = {
          type: 'quit',
          duration: message.duration,
        };
      } else if (message.type === MessageType.COMPRESSION) {
        historyItemContent = {
          type: 'compression',
          compression: message.compression,
        };
      } else {
        historyItemContent = {
          type: message.type,
          text: message.content,
        };
      }
      addItem(historyItemContent, message.timestamp.getTime());
    },
    [addItem],
  );
  const commandContext = useMemo(
    (): CommandContext => ({
      services: {
        config,
        settings,
        git: gitService,
        logger,
      },
      ui: {
        addItem,
        clear: () => {
          clearItems();
          console.clear();
          refreshStatic();
        },
        loadHistory,
        setDebugMessage: actions.setDebugMessage,
        pendingItem: pendingCompressionItem,
        setPendingItem: setPendingCompressionItem,
        toggleCorgiMode: actions.toggleCorgiMode,
        toggleVimEnabled,
        setGeminiMdFileCount,
        reloadCommands,
      },
      session: {
        stats: session.stats,
        sessionShellAllowlist,
      },
      // WEB_INTERFACE_START: Web interface command context
      web: {
        start: handleWebStart,
        stop: handleWebStop,
        status: handleWebStatus,
      },
      // WEB_INTERFACE_END
    }),
    [
      config,
      settings,
      gitService,
      logger,
      loadHistory,
      addItem,
      clearItems,
      refreshStatic,
      session.stats,
      actions,
      pendingCompressionItem,
      setPendingCompressionItem,
      toggleVimEnabled,
      sessionShellAllowlist,
      setGeminiMdFileCount,
      reloadCommands,
      // WEB_INTERFACE_START
      handleWebStart,
      handleWebStop,
      handleWebStatus,
      // WEB_INTERFACE_END
    ],
  );

  useEffect(() => {
    if (!config) {
      return;
    }

    const listener = () => {
      reloadCommands();
    };

    (async () => {
      const ideClient = await IdeClient.getInstance();
      ideClient.addStatusChangeListener(listener);
    })();

    return () => {
      (async () => {
        const ideClient = await IdeClient.getInstance();
        ideClient.removeStatusChangeListener(listener);
      })();
    };
  }, [config, reloadCommands]);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      const loaders = [
        new McpPromptLoader(config),
        new BuiltinCommandLoader(config),
        new FileCommandLoader(config),
      ];
      const commandService = await CommandService.create(
        loaders,
        controller.signal,
      );
      setCommands(commandService.getCommands());
    };

    load();

    return () => {
      controller.abort();
    };
  }, [config, reloadTrigger]);

  const handleSlashCommand = useCallback(
    async (
      rawQuery: PartListUnion,
      oneTimeShellAllowlist?: Set<string>,
      overwriteConfirmed?: boolean,
    ): Promise<SlashCommandProcessorResult | false> => {
      if (typeof rawQuery !== 'string') {
        return false;
      }

      const trimmed = rawQuery.trim();
      if (!trimmed.startsWith('/') && !trimmed.startsWith('?')) {
        return false;
      }

      setIsProcessing(true);

      const userMessageTimestamp = Date.now();
      addItem({ type: MessageType.USER, text: trimmed }, userMessageTimestamp);

      const parts = trimmed.substring(1).trim().split(/\s+/);
      const commandPath = parts.filter((p) => p); // The parts of the command, e.g., ['memory', 'add']

      let currentCommands = commands;
      let commandToExecute: SlashCommand | undefined;
      let pathIndex = 0;
      let hasError = false;
      const canonicalPath: string[] = [];

      for (const part of commandPath) {
        // TODO: For better performance and architectural clarity, this two-pass
        // search could be replaced. A more optimal approach would be to
        // pre-compute a single lookup map in `CommandService.ts` that resolves
        // all name and alias conflicts during the initial loading phase. The
        // processor would then perform a single, fast lookup on that map.

        // First pass: check for an exact match on the primary command name.
        let foundCommand = currentCommands.find((cmd) => cmd.name === part);

        // Second pass: if no primary name matches, check for an alias.
        if (!foundCommand) {
          foundCommand = currentCommands.find((cmd) =>
            cmd.altNames?.includes(part),
          );
        }

        if (foundCommand) {
          commandToExecute = foundCommand;
          canonicalPath.push(foundCommand.name);
          pathIndex++;
          if (foundCommand.subCommands) {
            currentCommands = foundCommand.subCommands;
          } else {
            break;
          }
        } else {
          break;
        }
      }

      const resolvedCommandPath = canonicalPath;
      const subcommand =
        resolvedCommandPath.length > 1
          ? resolvedCommandPath.slice(1).join(' ')
          : undefined;

      try {
        if (commandToExecute) {
          const args = parts.slice(pathIndex).join(' ');

          if (commandToExecute.action) {
            const fullCommandContext: CommandContext = {
              ...commandContext,
              invocation: {
                raw: trimmed,
                name: commandToExecute.name,
                args,
              },
              overwriteConfirmed,
            };

            // If a one-time list is provided for a "Proceed" action, temporarily
            // augment the session allowlist for this single execution.
            if (oneTimeShellAllowlist && oneTimeShellAllowlist.size > 0) {
              fullCommandContext.session = {
                ...fullCommandContext.session,
                sessionShellAllowlist: new Set([
                  ...fullCommandContext.session.sessionShellAllowlist,
                  ...oneTimeShellAllowlist,
                ]),
              };
            }
            const result = await commandToExecute.action(
              fullCommandContext,
              args,
            );

            if (result) {
              switch (result.type) {
                case 'tool':
                  return {
                    type: 'schedule_tool',
                    toolName: result.toolName,
                    toolArgs: result.toolArgs,
                  };
                case 'message':
                  addItem(
                    {
                      type:
                        result.messageType === 'error'
                          ? MessageType.ERROR
                          : MessageType.INFO,
                      text: result.content,
                    },
                    Date.now(),
                  );
                  return { type: 'handled' };
                case 'dialog':
                  // WEB_INTERFACE_START: Pre-start terminal capture for immediate-render dialogs
                  // Some dialogs render immediately upon state change, so we need to start
                  // capturing BEFORE the dialog opens to catch the initial render
                  const needsPreCapture = ['auth', 'theme', 'editor'].includes(result.dialog);
                  if (needsPreCapture && (global as any).__preStartTerminalCapture) {
                    (global as any).__preStartTerminalCapture();
                  }
                  // WEB_INTERFACE_END

                  switch (result.dialog) {
                    case 'auth':
                      actions.openAuthDialog();
                      return { type: 'handled' };
                    case 'theme':
                      actions.openThemeDialog();
                      return { type: 'handled' };
                    case 'editor':
                      actions.openEditorDialog();
                      return { type: 'handled' };
                    case 'language':
                      actions.openLanguageDialog();
                      return { type: 'handled' };
                    case 'privacy':
                      actions.openPrivacyNotice();
                      return { type: 'handled' };
                    case 'settings':
                      actions.openSettingsDialog();
                      return { type: 'handled' };
                    case 'help':
                      return { type: 'handled' };
                    default: {
                      const unhandled: never = result.dialog;
                      throw new Error(
                        `Unhandled slash command result: ${unhandled}`,
                      );
                    }
                  }
                case 'load_history': {
                  config
                    ?.getGeminiClient()
                    ?.setHistory(result.clientHistory, { stripThoughts: true });
                  fullCommandContext.ui.clear();
                  result.history.forEach((item, index) => {
                    fullCommandContext.ui.addItem(item, index);
                  });
                  return { type: 'handled' };
                }
                case 'quit':
                  actions.quit(result.messages);
                  return { type: 'handled' };

                case 'submit_prompt':
                  return {
                    type: 'submit_prompt',
                    content: result.content,
                  };
                case 'confirm_shell_commands': {
                  const { outcome, approvedCommands } = await new Promise<{
                    outcome: ToolConfirmationOutcome;
                    approvedCommands?: string[];
                  }>((resolve) => {
                    setShellConfirmationRequest({
                      commands: result.commandsToConfirm,
                      onConfirm: (
                        resolvedOutcome,
                        resolvedApprovedCommands,
                      ) => {
                        setShellConfirmationRequest(null); // Close the dialog
                        resolve({
                          outcome: resolvedOutcome,
                          approvedCommands: resolvedApprovedCommands,
                        });
                      },
                    });
                  });

                  if (
                    outcome === ToolConfirmationOutcome.Cancel ||
                    !approvedCommands ||
                    approvedCommands.length === 0
                  ) {
                    return { type: 'handled' };
                  }

                  if (outcome === ToolConfirmationOutcome.ProceedAlways) {
                    setSessionShellAllowlist(
                      (prev) => new Set([...prev, ...approvedCommands]),
                    );
                  }

                  return await handleSlashCommand(
                    result.originalInvocation.raw,
                    // Pass the approved commands as a one-time grant for this execution.
                    new Set(approvedCommands),
                  );
                }
                case 'confirm_action': {
                  const { confirmed } = await new Promise<{
                    confirmed: boolean;
                  }>((resolve) => {
                    setConfirmationRequest({
                      prompt: result.prompt,
                      onConfirm: (resolvedConfirmed) => {
                        setConfirmationRequest(null);
                        resolve({ confirmed: resolvedConfirmed });
                      },
                    });
                  });

                  if (!confirmed) {
                    addItem(
                      {
                        type: MessageType.INFO,
                        text: t('general.operation_cancelled', 'Operation cancelled.'),
                      },
                      Date.now(),
                    );
                    return { type: 'handled' };
                  }

                  return await handleSlashCommand(
                    result.originalInvocation.raw,
                    undefined,
                    true,
                  );
                }
                default: {
                  const unhandled: never = result;
                  throw new Error(
                    `Unhandled slash command result: ${unhandled}`,
                  );
                }
              }
            }

            return { type: 'handled' };
          } else if (commandToExecute.subCommands) {
            const helpText = `Command '/${commandToExecute.name}' requires a subcommand. Available:\n${commandToExecute.subCommands
              .map((sc) => `  - ${sc.name}: ${sc.description || ''}`)
              .join('\n')}`;
            addMessage({
              type: MessageType.INFO,
              content: helpText,
              timestamp: new Date(),
            });
            return { type: 'handled' };
          }
        }

        addMessage({
          type: MessageType.ERROR,
          content: t('errors.unknown_command', 'Unknown command: {command}', { command: trimmed }),
          timestamp: new Date(),
        });

        return { type: 'handled' };
      } catch (e: unknown) {
        hasError = true;
        if (config) {
          const event = makeSlashCommandEvent({
            command: resolvedCommandPath[0],
            subcommand,
            status: SlashCommandStatus.ERROR,
          });
          logSlashCommand(config, event);
        }
        addItem(
          {
            type: MessageType.ERROR,
            text: e instanceof Error ? e.message : String(e),
          },
          Date.now(),
        );
        return { type: 'handled' };
      } finally {
        if (config && resolvedCommandPath[0] && !hasError) {
          const event = makeSlashCommandEvent({
            command: resolvedCommandPath[0],
            subcommand,
            status: SlashCommandStatus.SUCCESS,
          });
          logSlashCommand(config, event);
        }
        setIsProcessing(false);
      }
    },
    [
      config,
      addItem,
      actions,
      commands,
      commandContext,
      addMessage,
      setShellConfirmationRequest,
      setSessionShellAllowlist,
      setIsProcessing,
      setConfirmationRequest,
    ],
  );

  return {
    handleSlashCommand,
    slashCommands: commands,
    pendingHistoryItems,
    commandContext,
    shellConfirmationRequest,
    confirmationRequest,
  };
};
