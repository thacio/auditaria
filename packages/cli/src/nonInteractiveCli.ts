/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Config,
  ToolCallRequestInfo,
  CompletedToolCall,
  UserFeedbackPayload,
} from '@thacio/auditaria-cli-core';
import { isSlashCommand } from './ui/utils/commandUtils.js';
import type { LoadedSettings } from './config/settings.js';
import {
  executeToolCall,
  shutdownTelemetry,
  isTelemetrySdkInitialized,
  GeminiEventType,
  FatalInputError,
  promptIdContext,
  OutputFormat,
  JsonFormatter,
  StreamJsonFormatter,
  JsonStreamEventType,
  uiTelemetryService,
  debugLogger,
  coreEvents,
  CoreEvent,
  t,
} from '@thacio/auditaria-cli-core';

import type { Content, Part } from '@google/genai';

import { handleSlashCommand } from './nonInteractiveCliCommands.js';
import { ConsolePatcher } from './ui/utils/ConsolePatcher.js';
import { handleAtCommand } from './ui/hooks/atCommandProcessor.js';
import {
  handleError,
  handleToolError,
  handleCancellationError,
  handleMaxTurnsExceededError,
} from './utils/errors.js';
import { TextOutput } from './ui/utils/textOutput.js';

interface RunNonInteractiveParams {
  config: Config;
  settings: LoadedSettings;
  input: string;
  prompt_id: string;
  hasDeprecatedPromptArg?: boolean;
}

export async function runNonInteractive({
  config,
  settings,
  input,
  prompt_id,
  hasDeprecatedPromptArg,
}: RunNonInteractiveParams): Promise<void> {
  return promptIdContext.run(prompt_id, async () => {
    const consolePatcher = new ConsolePatcher({
      stderr: true,
      debugMode: config.getDebugMode(),
    });
    const textOutput = new TextOutput();

    const handleUserFeedback = (payload: UserFeedbackPayload) => {
      const prefix = payload.severity.toUpperCase();
      process.stderr.write(`[${prefix}] ${payload.message}\n`);
      if (payload.error && config.getDebugMode()) {
        const errorToLog =
          payload.error instanceof Error
            ? payload.error.stack || payload.error.message
            : String(payload.error);
        process.stderr.write(`${errorToLog}\n`);
      }
    };

    const startTime = Date.now();
    const streamFormatter =
      config.getOutputFormat() === OutputFormat.STREAM_JSON
        ? new StreamJsonFormatter()
        : null;

    let errorToHandle: unknown | undefined;
    try {
      consolePatcher.patch();
      coreEvents.on(CoreEvent.UserFeedback, handleUserFeedback);
      coreEvents.drainFeedbackBacklog();

      // Handle EPIPE errors when the output is piped to a command that closes early.
      process.stdout.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPIPE') {
          // Exit gracefully if the pipe is closed.
          process.exit(0);
        }
      });

      const geminiClient = config.getGeminiClient();

      // Emit init event for streaming JSON
      if (streamFormatter) {
        streamFormatter.emitEvent({
          type: JsonStreamEventType.INIT,
          timestamp: new Date().toISOString(),
          session_id: config.getSessionId(),
          model: config.getModel(),
        });
      }

      const abortController = new AbortController();

      let query: Part[] | undefined;

      if (isSlashCommand(input)) {
        const slashCommandResult = await handleSlashCommand(
          input,
          abortController,
          config,
          settings,
        );
        // If a slash command is found and returns a prompt, use it.
        // Otherwise, slashCommandResult fall through to the default prompt
        // handling.
        if (slashCommandResult) {
          query = slashCommandResult as Part[];
        }
      }

      if (!query) {
        const { processedQuery, shouldProceed } = await handleAtCommand({
          query: input,
          config,
          addItem: (_item, _timestamp) => 0,
          onDebugMessage: () => {},
          messageId: Date.now(),
          signal: abortController.signal,
        });

        if (!shouldProceed || !processedQuery) {
          // An error occurred during @include processing (e.g., file not found).
          // The error message is already logged by handleAtCommand.
          throw new FatalInputError(
            'Exiting due to an error processing the @ command.',
          );
        }
        query = processedQuery as Part[];
      }

      // Emit user message event for streaming JSON
      if (streamFormatter) {
        streamFormatter.emitEvent({
          type: JsonStreamEventType.MESSAGE,
          timestamp: new Date().toISOString(),
          role: 'user',
          content: input,
        });
      }

      let currentMessages: Content[] = [{ role: 'user', parts: query }];

      let turnCount = 0;
      const deprecateText = t(
        'cli.deprecation.prompt_flag',
        'The --prompt (-p) flag has been deprecated and will be removed in a future version. Please use a positional argument for your prompt. See gemini --help for more information.\n',
      );
      if (hasDeprecatedPromptArg) {
        if (streamFormatter) {
          streamFormatter.emitEvent({
            type: JsonStreamEventType.MESSAGE,
            timestamp: new Date().toISOString(),
            role: 'assistant',
            content: deprecateText,
            delta: true,
          });
        } else {
          process.stderr.write(deprecateText);
        }
      }
      while (true) {
        turnCount++;
        if (
          config.getMaxSessionTurns() >= 0 &&
          turnCount > config.getMaxSessionTurns()
        ) {
          handleMaxTurnsExceededError(config);
        }
        const toolCallRequests: ToolCallRequestInfo[] = [];

        const responseStream = geminiClient.sendMessageStream(
          currentMessages[0]?.parts || [],
          abortController.signal,
          prompt_id,
        );

        let responseText = '';
        for await (const event of responseStream) {
          if (abortController.signal.aborted) {
            handleCancellationError(config);
          }

          if (event.type === GeminiEventType.Content) {
            if (streamFormatter) {
              streamFormatter.emitEvent({
                type: JsonStreamEventType.MESSAGE,
                timestamp: new Date().toISOString(),
                role: 'assistant',
                content: event.value,
                delta: true,
              });
            } else if (config.getOutputFormat() === OutputFormat.JSON) {
              responseText += event.value;
            } else {
              if (event.value) {
                textOutput.write(event.value);
              }
            }
          } else if (event.type === GeminiEventType.ToolCallRequest) {
            if (streamFormatter) {
              streamFormatter.emitEvent({
                type: JsonStreamEventType.TOOL_USE,
                timestamp: new Date().toISOString(),
                tool_name: event.value.name,
                tool_id: event.value.callId,
                parameters: event.value.args,
              });
            }
            toolCallRequests.push(event.value);
          } else if (event.type === GeminiEventType.LoopDetected) {
            if (streamFormatter) {
              streamFormatter.emitEvent({
                type: JsonStreamEventType.ERROR,
                timestamp: new Date().toISOString(),
                severity: 'warning',
                message: 'Loop detected, stopping execution',
              });
            }
          } else if (event.type === GeminiEventType.MaxSessionTurns) {
            if (streamFormatter) {
              streamFormatter.emitEvent({
                type: JsonStreamEventType.ERROR,
                timestamp: new Date().toISOString(),
                severity: 'error',
                message: 'Maximum session turns exceeded',
              });
            }
          } else if (event.type === GeminiEventType.Error) {
            throw event.value.error;
          }
        }

        if (toolCallRequests.length > 0) {
          textOutput.ensureTrailingNewline();
          const toolResponseParts: Part[] = [];
          const completedToolCalls: CompletedToolCall[] = [];

          for (const requestInfo of toolCallRequests) {
            const completedToolCall = await executeToolCall(
              config,
              requestInfo,
              abortController.signal,
            );
            const toolResponse = completedToolCall.response;

            completedToolCalls.push(completedToolCall);

            if (streamFormatter) {
              streamFormatter.emitEvent({
                type: JsonStreamEventType.TOOL_RESULT,
                timestamp: new Date().toISOString(),
                tool_id: requestInfo.callId,
                status: toolResponse.error ? 'error' : 'success',
                output:
                  typeof toolResponse.resultDisplay === 'string'
                    ? toolResponse.resultDisplay
                    : undefined,
                error: toolResponse.error
                  ? {
                      type: toolResponse.errorType || 'TOOL_EXECUTION_ERROR',
                      message: toolResponse.error.message,
                    }
                  : undefined,
              });
            }

            if (toolResponse.error) {
              handleToolError(
                requestInfo.name,
                toolResponse.error,
                config,
                toolResponse.errorType || 'TOOL_EXECUTION_ERROR',
                typeof toolResponse.resultDisplay === 'string'
                  ? toolResponse.resultDisplay
                  : undefined,
              );
            }

            if (toolResponse.responseParts) {
              toolResponseParts.push(...toolResponse.responseParts);
            }
          }

          // Record tool calls with full metadata before sending responses to Gemini
          try {
            const currentModel =
              geminiClient.getCurrentSequenceModel() ?? config.getModel();
            geminiClient
              .getChat()
              .recordCompletedToolCalls(currentModel, completedToolCalls);
          } catch (error) {
            debugLogger.error(
              `Error recording completed tool call information: ${error}`,
            );
          }

          currentMessages = [{ role: 'user', parts: toolResponseParts }];
        } else {
          // Emit final result event for streaming JSON
          if (streamFormatter) {
            const metrics = uiTelemetryService.getMetrics();
            const durationMs = Date.now() - startTime;
            streamFormatter.emitEvent({
              type: JsonStreamEventType.RESULT,
              timestamp: new Date().toISOString(),
              status: 'success',
              stats: streamFormatter.convertToStreamStats(metrics, durationMs),
            });
          } else if (config.getOutputFormat() === OutputFormat.JSON) {
            const formatter = new JsonFormatter();
            const stats = uiTelemetryService.getMetrics();
            textOutput.write(formatter.format(responseText, stats));
          } else {
            textOutput.ensureTrailingNewline(); // Ensure a final newline
          }
          return;
        }
      }
    } catch (error) {
      errorToHandle = error;
    } finally {
      consolePatcher.cleanup();
      coreEvents.off(CoreEvent.UserFeedback, handleUserFeedback);
      if (isTelemetrySdkInitialized()) {
        await shutdownTelemetry(config);
      }
    }

    if (errorToHandle) {
      handleError(errorToHandle, config);
    }
  });
}
