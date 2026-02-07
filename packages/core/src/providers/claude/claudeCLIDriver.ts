// AUDITARIA_CLAUDE_PROVIDER: CLI-based driver spawning claude subprocess

import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import type { ProviderDriver, ProviderEvent } from '../types.js';
import { ProviderEventType } from '../types.js';
import { ClaudeSessionManager } from './claudeSessionManager.js';
import type {
  ClaudeStreamMessage,
  ClaudeAssistantMessage,
  ClaudeUserMessage,
  ClaudeResultMessage,
  ClaudeDriverConfig,
} from './types.js';

const DEBUG = true; // TODO: remove after integration is stable
function dbg(...args: unknown[]) {
  if (DEBUG) console.log('[CLI_DRIVER]', ...args);
}

export class ClaudeCLIDriver implements ProviderDriver {
  private sessionManager = new ClaudeSessionManager();
  private activeProcess: ChildProcess | null = null;

  constructor(private readonly config: ClaudeDriverConfig) {
    dbg('constructor', { model: config.model, cwd: config.cwd });
  }

  async *sendMessage(
    prompt: string,
    signal: AbortSignal,
    systemContext?: string,
  ): AsyncGenerator<ProviderEvent> {
    const isFirstCall = !this.sessionManager.getSessionId();
    const args = this.buildArgs();
    dbg('sendMessage', { args, promptLen: prompt.length, hasSystemContext: !!systemContext, isFirstCall });

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.config.cwd,
      shell: true,
    });
    this.activeProcess = proc;
    dbg('spawned', { pid: proc.pid });

    // Pipe prompt through stdin to avoid Windows cmd.exe argument
    // quoting issues. System context is prepended on first call only
    // (resumed sessions already have it). We use --append-system-prompt
    // style approach but via stdin to bypass cmd.exe string mangling.
    if (isFirstCall && systemContext) {
      proc.stdin?.write(`<auditaria_system_context>\n${systemContext}\n</auditaria_system_context>\n\n${prompt}`);
    } else {
      proc.stdin?.write(prompt);
    }
    proc.stdin?.end();

    proc.on('error', (err) => {
      dbg('proc error event', err);
    });

    // Handle abort
    const abortHandler = () => {
      dbg('abort handler triggered');
      if (proc.pid) {
        proc.kill('SIGTERM');
      }
    };
    signal.addEventListener('abort', abortHandler, { once: true });

    try {
      yield* this.readStream(proc, signal);
    } catch (e) {
      dbg('sendMessage ERROR', e);
      throw e;
    } finally {
      signal.removeEventListener('abort', abortHandler);
      this.activeProcess = null;
      dbg('sendMessage FINALLY');
    }
  }

  async interrupt(): Promise<void> {
    if (this.activeProcess?.pid) {
      this.activeProcess.kill('SIGTERM');
    }
  }

  getSessionId(): string | undefined {
    return this.sessionManager.getSessionId();
  }

  dispose(): void {
    if (this.activeProcess?.pid) {
      this.activeProcess.kill('SIGTERM');
    }
    this.activeProcess = null;
  }

  private buildArgs(): string[] {
    // Prompt is piped through stdin, not passed as -p argument,
    // to avoid Windows cmd.exe shell quoting issues.
    const args = [
      '--output-format',
      'stream-json',
    ];

    if (this.config.model) {
      args.push('--model', this.config.model);
    }

    const sessionId = this.sessionManager.getSessionId();
    dbg('buildArgs sessionId:', sessionId || '(none - new session)');
    if (sessionId) {
      args.push('--resume', sessionId);
    }

    if (
      this.config.permissionMode &&
      this.config.permissionMode !== 'default'
    ) {
      args.push('--permission-mode', this.config.permissionMode);
    }

    return args;
  }

  private async *readStream(
    proc: ChildProcess,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    if (!proc.stdout) {
      dbg('NO stdout!');
      yield {
        type: ProviderEventType.Error,
        message: 'Claude CLI: no stdout stream available',
      };
      return;
    }
    dbg('readStream starting, stdout available');

    const rl = createInterface({ input: proc.stdout });
    const lines: string[] = [];
    let done = false;
    let resolveWait: (() => void) | null = null;

    rl.on('line', (line) => {
      dbg('raw line received', line.slice(0, 120));
      lines.push(line);
      resolveWait?.();
    });

    rl.on('close', () => {
      dbg('readline closed');
      done = true;
      resolveWait?.();
    });

    // Collect stderr for error reporting
    let stderrData = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      dbg('stderr:', text.trim());
      stderrData += text;
    });

    try {
      while (!done || lines.length > 0) {
        if (signal.aborted) {
          dbg('signal aborted in readStream loop');
          return;
        }

        if (lines.length === 0 && !done) {
          dbg('waiting for more lines...');
          await new Promise<void>((resolve) => {
            resolveWait = resolve;
          });
          continue;
        }

        const line = lines.shift();
        if (!line) continue;

        let message: ClaudeStreamMessage;
        try {
          message = JSON.parse(line) as ClaudeStreamMessage;
        } catch {
          dbg('skipping non-JSON line:', line.slice(0, 80));
          continue;
        }

        dbg('parsed message type:', message.type);
        yield* this.processMessage(message);
      }

      // Check exit code
      const exitCode = await new Promise<number | null>((resolve) => {
        if (proc.exitCode !== null) {
          resolve(proc.exitCode);
        } else {
          proc.on('exit', (code) => resolve(code));
        }
      });
      dbg('exit code:', exitCode);

      if (exitCode && exitCode !== 0) {
        yield {
          type: ProviderEventType.Error,
          message: `Claude CLI exited with code ${exitCode}${stderrData ? `: ${stderrData.trim()}` : ''}`,
        };
      }

      yield { type: ProviderEventType.Finished };
    } finally {
      rl.close();
      dbg('readStream FINALLY');
    }
  }

  private *processMessage(
    message: ClaudeStreamMessage,
  ): Generator<ProviderEvent> {
    // Capture session ID
    if (message.session_id) {
      this.sessionManager.setSessionId(message.session_id as string);
    }

    if (message.type === 'system') {
      dbg('system message, session_id:', message.session_id);
      return;
    }

    if (message.type === 'assistant') {
      yield* this.processAssistantMessage(
        message as ClaudeAssistantMessage,
      );
      return;
    }

    if (message.type === 'user') {
      yield* this.processUserMessage(message as ClaudeUserMessage);
      return;
    }

    if (message.type === 'result') {
      dbg('result message, subtype:', (message as ClaudeResultMessage).subtype);
      yield* this.processResultMessage(message as ClaudeResultMessage);
      return;
    }

    dbg('unknown message type:', message.type);
  }

  private *processAssistantMessage(
    message: ClaudeAssistantMessage,
  ): Generator<ProviderEvent> {
    const content = message.message?.content;
    if (!content || !Array.isArray(content)) {
      dbg('assistant message has no content array');
      return;
    }

    dbg('assistant message, blocks:', content.length, 'model:', message.message?.model);

    if (message.message?.model) {
      yield {
        type: ProviderEventType.ModelInfo,
        model: message.message.model,
      };
    }

    for (const block of content) {
      dbg('block type:', block.type);
      switch (block.type) {
        case 'text':
          if (block.text) {
            yield {
              type: ProviderEventType.Content,
              text: block.text,
            };
          }
          break;

        case 'thinking':
          if (block.thinking) {
            yield {
              type: ProviderEventType.Thinking,
              text: block.thinking,
            };
          }
          break;

        case 'tool_use':
          yield {
            type: ProviderEventType.ToolUse,
            toolName: block.name,
            toolId: block.id,
            input: block.input,
          };
          break;

        case 'tool_result':
          yield {
            type: ProviderEventType.ToolResult,
            toolId: block.tool_use_id,
            output: block.content,
            isError: block.is_error,
          };
          break;
      }
    }
  }

  private *processUserMessage(
    message: ClaudeUserMessage,
  ): Generator<ProviderEvent> {
    const content = message.message?.content;
    if (!content || !Array.isArray(content)) {
      dbg('user message has no content array');
      return;
    }

    dbg('user message, blocks:', content.length);

    for (const block of content) {
      if (block.type === 'tool_result') {
        dbg('user tool_result for:', block.tool_use_id, 'is_error:', block.is_error);
        yield {
          type: ProviderEventType.ToolResult,
          toolId: block.tool_use_id,
          output: block.content,
          isError: block.is_error,
        };
      }
    }
  }

  private *processResultMessage(
    message: ClaudeResultMessage,
  ): Generator<ProviderEvent> {
    if (!message.modelUsage) {
      dbg('result message has no modelUsage');
      return;
    }

    const modelKey = Object.keys(message.modelUsage)[0];
    const usage = message.modelUsage[modelKey];
    if (!usage) return;

    dbg('usage:', { input: usage.inputTokens, output: usage.outputTokens });

    yield {
      type: ProviderEventType.Finished,
      usage: {
        inputTokens:
          usage.cumulativeInputTokens ?? usage.inputTokens,
        outputTokens:
          usage.cumulativeOutputTokens ?? usage.outputTokens,
        cacheReadTokens:
          usage.cumulativeCacheReadInputTokens ??
          usage.cacheReadInputTokens,
        cacheCreationTokens:
          usage.cumulativeCacheCreationInputTokens ??
          usage.cacheCreationInputTokens,
      },
    };
  }
}
