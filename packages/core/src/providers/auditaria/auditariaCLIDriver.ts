// AUDITARIA_AGENT_SESSION: CLI-based driver spawning auditaria subprocess as sub-agent.
// Parses stream-json (JSONL) output. Tools are built-in (no MCP bridge needed).

import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { ProviderDriver, ProviderEvent } from '../types.js';
import { ProviderEventType } from '../types.js';
import { killProcessGroup } from '../../utils/process-utils.js';
import type { AuditariaCLIDriverConfig } from './types.js';
import type { JsonStreamEvent } from '../../output/types.js';
import { JsonStreamEventType } from '../../output/types.js';

const DEBUG = false;
function dbg(...args: unknown[]) {
  if (DEBUG) console.log('[AUDITARIA_DRIVER]', ...args);
}

function shellQuote(p: string): string {
  return p.includes(' ') ? `"${p}"` : p;
}

function getShellOption(): boolean | string {
  return process.platform === 'win32' ? 'powershell.exe' : true;
}

export class AuditariaCLIDriver implements ProviderDriver {
  private sessionId: string | undefined;
  private activeProcess: ChildProcess | null = null;
  private currentPromptFilePath: string | null = null; // AUDITARIA_AGENT_SESSION: tracks prompt file for rename/cleanup

  constructor(private readonly config: AuditariaCLIDriverConfig) {
    dbg('constructor', { model: config.model, cwd: config.cwd, approvalMode: config.approvalMode });
  }

  async *sendMessage(
    prompt: string,
    signal: AbortSignal,
    systemContext?: string,
  ): AsyncGenerator<ProviderEvent> {
    const args = this.buildArgs();

    // Pass system context via file on every call (same pattern as Claude driver —
    // --append-system-prompt-file does NOT persist across --resume sessions).
    if (systemContext) {
      const filePath = this.writeSystemPromptFile(systemContext);
      args.push('--append-system-prompt-file', shellQuote(filePath));
    }

    dbg('sendMessage', { argsCount: args.length, promptLen: prompt.length, hasSystemContext: !!systemContext });

    const proc = spawn('auditaria', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.config.cwd,
      shell: getShellOption(),
      env: {
        ...process.env,
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
      },
    });
    this.activeProcess = proc;
    dbg('spawned', { pid: proc.pid });

    // Pipe prompt through stdin to avoid shell argument quoting issues.
    proc.stdin?.write(prompt);
    proc.stdin?.end();

    proc.on('error', (err) => {
      dbg('proc error event', err);
    });

    // Handle abort
    const abortHandler = () => {
      dbg('abort handler triggered');
      if (proc.pid) {
        killProcessGroup({ pid: proc.pid, escalate: true });
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
      await killProcessGroup({ pid: this.activeProcess.pid, escalate: true });
    }
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  resetSession(): void {
    this.sessionId = undefined;
  }

  dispose(): void {
    if (this.activeProcess?.pid) {
      killProcessGroup({ pid: this.activeProcess.pid, escalate: true });
    }
    this.activeProcess = null;
    // AUDITARIA_AGENT_SESSION: Clean up isolated prompt file for sub-agents
    if (this.currentPromptFilePath) {
      try { unlinkSync(this.currentPromptFilePath); } catch { /* ignore */ }
      this.currentPromptFilePath = null;
    }
  }

  private buildArgs(): string[] {
    const args = [
      '--output-format', 'stream-json',
      '--no-web',
    ];

    if (this.config.approvalMode === 'yolo') {
      args.push('--yolo');
    }

    if (this.config.model) {
      args.push('--model', this.config.model);
    }

    if (this.sessionId) {
      args.push('--resume', this.sessionId);
    }

    return args;
  }

  // AUDITARIA_AGENT_SESSION: Write system context to file.
  // When promptFileId is set (sub-agents), writes to .auditaria/prompts/{id}.prompt for isolation.
  // Once a real session ID is available, switches the filename to it (globally unique).
  // When not set, writes to .auditaria/.auditaria-subagent-prompt (unchanged behavior).
  private writeSystemPromptFile(content: string): string {
    if (!this.config.promptFileId) {
      // Fallback — unchanged behavior
      const dir = join(this.config.cwd, '.auditaria');
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, '.auditaria-subagent-prompt');
      writeFileSync(filePath, content, 'utf-8');
      dbg('wrote system prompt file', { path: filePath, length: content.length });
      return filePath;
    }

    // Sub-agent — use real session ID if available, otherwise short promptFileId
    const dir = join(this.config.cwd, '.auditaria', 'prompts');
    mkdirSync(dir, { recursive: true });
    const filename = `${this.sessionId ?? this.config.promptFileId}.prompt`;
    const filePath = join(dir, filename);

    // If session ID just became available, clean up old file with short ID
    if (this.sessionId && this.currentPromptFilePath && this.currentPromptFilePath !== filePath) {
      try { unlinkSync(this.currentPromptFilePath); } catch { /* ignore */ }
      dbg('renamed prompt file', { from: this.currentPromptFilePath, to: filePath });
    }

    writeFileSync(filePath, content, 'utf-8');
    this.currentPromptFilePath = filePath;
    dbg('wrote system prompt file', { path: filePath, length: content.length });
    return filePath;
  }

  private async *readStream(
    proc: ChildProcess,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    if (!proc.stdout) {
      dbg('NO stdout!');
      yield {
        type: ProviderEventType.Error,
        message: 'Auditaria CLI: no stdout stream available',
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

        let event: JsonStreamEvent;
        try {
          event = JSON.parse(line) as JsonStreamEvent;
        } catch {
          dbg('skipping non-JSON line:', line.slice(0, 80));
          continue;
        }

        dbg('parsed event type:', event.type);
        yield* this.processEvent(event);
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
          message: `Auditaria CLI exited with code ${exitCode}${stderrData ? `: ${stderrData.trim()}` : ''}`,
        };
      }

      yield { type: ProviderEventType.Finished };
    } finally {
      rl.close();
      dbg('readStream FINALLY');
    }
  }

  private *processEvent(
    event: JsonStreamEvent,
  ): Generator<ProviderEvent> {
    switch (event.type) {
      case JsonStreamEventType.INIT: {
        // Capture session ID for resume
        this.sessionId = event.session_id;
        dbg('init, session_id:', this.sessionId, 'model:', event.model);
        if (event.model) {
          yield {
            type: ProviderEventType.ModelInfo,
            model: event.model,
          };
        }
        break;
      }

      case JsonStreamEventType.MESSAGE: {
        // Only emit assistant messages as content
        if (event.role === 'assistant' && event.content) {
          yield {
            type: ProviderEventType.Content,
            text: event.content,
          };
        }
        break;
      }

      case JsonStreamEventType.TOOL_USE: {
        yield {
          type: ProviderEventType.ToolUse,
          toolName: event.tool_name,
          toolId: event.tool_id,
          input: event.parameters,
        };
        break;
      }

      case JsonStreamEventType.TOOL_RESULT: {
        yield {
          type: ProviderEventType.ToolResult,
          toolId: event.tool_id,
          output: event.output ?? event.error?.message ?? '',
          isError: event.status === 'error',
        };
        break;
      }

      case JsonStreamEventType.ERROR: {
        yield {
          type: ProviderEventType.Error,
          message: event.message,
        };
        break;
      }

      case JsonStreamEventType.RESULT: {
        // Final event with usage stats
        if (event.stats) {
          yield {
            type: ProviderEventType.Finished,
            usage: {
              inputTokens: event.stats.input_tokens,
              outputTokens: event.stats.output_tokens,
            },
          };
        }
        break;
      }
    }
  }
}
