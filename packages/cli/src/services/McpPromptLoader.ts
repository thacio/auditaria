/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Config,
  getErrorMessage,
  getMCPServerPrompts,
  t,
} from '@google/gemini-cli-core';
import {
  CommandContext,
  CommandKind,
  SlashCommand,
  SlashCommandActionReturn,
} from '../ui/commands/types.js';
import { ICommandLoader } from './types.js';
import { PromptArgument } from '@modelcontextprotocol/sdk/types.js';

/**
 * Discovers and loads executable slash commands from prompts exposed by
 * Model-Context-Protocol (MCP) servers.
 */
export class McpPromptLoader implements ICommandLoader {
  constructor(private readonly config: Config | null) {}

  /**
   * Loads all available prompts from all configured MCP servers and adapts
   * them into executable SlashCommand objects.
   *
   * @param _signal An AbortSignal (unused for this synchronous loader).
   * @returns A promise that resolves to an array of loaded SlashCommands.
   */
  loadCommands(_signal: AbortSignal): Promise<SlashCommand[]> {
    const promptCommands: SlashCommand[] = [];
    if (!this.config) {
      return Promise.resolve([]);
    }
    const mcpServers = this.config.getMcpServers() || {};
    for (const serverName in mcpServers) {
      const prompts = getMCPServerPrompts(this.config, serverName) || [];
      for (const prompt of prompts) {
        const commandName = `${prompt.name}`;
        const newPromptCommand: SlashCommand = {
          name: commandName,
          description: prompt.description || `Invoke prompt ${prompt.name}`,
          kind: CommandKind.MCP_PROMPT,
          subCommands: [
            {
              name: 'help',
              description: 'Show help for this prompt',
              kind: CommandKind.MCP_PROMPT,
              action: async (): Promise<SlashCommandActionReturn> => {
                if (!prompt.arguments || prompt.arguments.length === 0) {
                  return {
                    type: 'message',
                    messageType: 'info',
                    content: t('commands.mcp.prompts.no_arguments', 'Prompt "{promptName}" has no arguments.', { promptName: prompt.name }),
                  };
                }

                let helpMessage = t('commands.mcp.prompts.arguments_help_intro', 'Arguments for "{promptName}":', { promptName: prompt.name }) + '\n\n';
                if (prompt.arguments && prompt.arguments.length > 0) {
                  const positionalExample = prompt.arguments.map((_: any) => `"foo"`).join(' ');
                  const namedExample = prompt.arguments.map((arg: any) => `--${arg.name}="foo"`).join(' ');
                  helpMessage += t('commands.mcp.prompts.arguments_usage_note', 'You can provide arguments by name (e.g., --argName="value") or by position.', {}) + '\n\n';
                  helpMessage += t('commands.mcp.prompts.arguments_example', 'e.g., {promptName} {positionalExample} is equivalent to {promptName} {namedExample}', { promptName: prompt.name, positionalExample, namedExample }) + '\n\n';
                }
                for (const arg of prompt.arguments) {
                  helpMessage += `  --${arg.name}\n`;
                  if (arg.description) {
                    helpMessage += `    ${arg.description}\n`;
                  }
                  const requiredText = arg.required 
                    ? t('commands.mcp.prompts.argument_required_yes', 'yes', {})
                    : t('commands.mcp.prompts.argument_required_no', 'no', {});
                  helpMessage += `    (required: ${requiredText})\n\n`;
                }
                return {
                  type: 'message',
                  messageType: 'info',
                  content: helpMessage,
                };
              },
            },
          ],
          action: async (
            context: CommandContext,
            args: string,
          ): Promise<SlashCommandActionReturn> => {
            if (!this.config) {
              return {
                type: 'message',
                messageType: 'error',
                content: t('commands.mcp.prompts.config_not_loaded', 'Config not loaded.', {}),
              };
            }

            const promptInputs = this.parseArgs(args, prompt.arguments);
            if (promptInputs instanceof Error) {
              return {
                type: 'message',
                messageType: 'error',
                content: promptInputs.message,
              };
            }

            try {
              const mcpServers = this.config.getMcpServers() || {};
              const mcpServerConfig = mcpServers[serverName];
              if (!mcpServerConfig) {
                return {
                  type: 'message',
                  messageType: 'error',
                  content: t('commands.mcp.prompts.server_config_not_found', 'MCP server config not found for \'{serverName}\'.', { serverName }),
                };
              }
              const result = await prompt.invoke(promptInputs);

              if (result['error']) {
                return {
                  type: 'message',
                  messageType: 'error',
                  content: t('commands.mcp.prompts.invoke_error', 'Error invoking prompt: {error}', { error: String(result['error']) }),
                };
              }

              if (!result.messages?.[0]?.content?.['text']) {
                return {
                  type: 'message',
                  messageType: 'error',
                  content: t('commands.mcp.prompts.empty_response', 'Received an empty or invalid prompt response from the server.', {}),
                };
              }

              return {
                type: 'submit_prompt',
                content: JSON.stringify(result.messages[0].content.text),
              };
            } catch (error) {
              return {
                type: 'message',
                messageType: 'error',
                content: `Error: ${getErrorMessage(error)}`,
              };
            }
          },
          completion: async (_: CommandContext, partialArg: string) => {
            if (!prompt || !prompt.arguments) {
              return [];
            }

            const suggestions: string[] = [];
            const usedArgNames = new Set(
              (partialArg.match(/--([^=]+)/g) || []).map((s) => s.substring(2)),
            );

            for (const arg of prompt.arguments) {
              if (!usedArgNames.has(arg.name)) {
                suggestions.push(`--${arg.name}=""`);
              }
            }

            return suggestions;
          },
        };
        promptCommands.push(newPromptCommand);
      }
    }
    return Promise.resolve(promptCommands);
  }

  /**
   * Parses the `userArgs` string representing the prompt arguments (all the text
   * after the command) into a record matching the shape of the `promptArgs`.
   *
   * @param userArgs
   * @param promptArgs
   * @returns A record of the parsed arguments
   * @visibleForTesting
   */
  parseArgs(
    userArgs: string,
    promptArgs: PromptArgument[] | undefined,
  ): Record<string, unknown> | Error {
    const argValues: { [key: string]: string } = {};
    const promptInputs: Record<string, unknown> = {};

    // arg parsing: --key="value" or --key=value
    const namedArgRegex = /--([^=]+)=(?:"((?:\\.|[^"\\])*)"|([^ ]+))/g;
    let match;
    let lastIndex = 0;
    const positionalParts: string[] = [];

    while ((match = namedArgRegex.exec(userArgs)) !== null) {
      const key = match[1];
      // Extract the quoted or unquoted argument and remove escape chars.
      const value = (match[2] ?? match[3]).replace(/\\(.)/g, '$1');
      argValues[key] = value;
      // Capture text between matches as potential positional args
      if (match.index > lastIndex) {
        positionalParts.push(userArgs.substring(lastIndex, match.index));
      }
      lastIndex = namedArgRegex.lastIndex;
    }

    // Capture any remaining text after the last named arg
    if (lastIndex < userArgs.length) {
      positionalParts.push(userArgs.substring(lastIndex));
    }

    const positionalArgsString = positionalParts.join('').trim();
    // extracts either quoted strings or non-quoted sequences of non-space characters.
    const positionalArgRegex = /(?:"((?:\\.|[^"\\])*)"|([^ ]+))/g;
    const positionalArgs: string[] = [];
    while ((match = positionalArgRegex.exec(positionalArgsString)) !== null) {
      // Extract the quoted or unquoted argument and remove escape chars.
      positionalArgs.push((match[1] ?? match[2]).replace(/\\(.)/g, '$1'));
    }

    if (!promptArgs) {
      return promptInputs;
    }
    for (const arg of promptArgs) {
      if (argValues[arg.name]) {
        promptInputs[arg.name] = argValues[arg.name];
      }
    }

    const unfilledArgs = promptArgs.filter(
      (arg) => arg.required && !promptInputs[arg.name],
    );

    if (unfilledArgs.length === 1) {
      // If we have only one unfilled arg, we don't require quotes we just
      // join all the given arguments together as if they were quoted.
      promptInputs[unfilledArgs[0].name] = positionalArgs.join(' ');
    } else {
      const missingArgs: string[] = [];
      for (let i = 0; i < unfilledArgs.length; i++) {
        if (positionalArgs.length > i) {
          promptInputs[unfilledArgs[i].name] = positionalArgs[i];
        } else {
          missingArgs.push(unfilledArgs[i].name);
        }
      }
      if (missingArgs.length > 0) {
        const missingArgNames = missingArgs
          .map((name) => `--${name}`)
          .join(', ');
        return new Error(t('commands.mcp.prompts.missing_arguments', 'Missing required argument(s): {missingArgNames}', { missingArgNames }));
      }
    }

    return promptInputs;
  }
}
