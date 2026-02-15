// AUDITARIA_CLAUDE_PROVIDER: CLI-based driver spawning claude subprocess

import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ProviderDriver, ProviderEvent } from '../types.js';
import { ProviderEventType } from '../types.js';
import { killProcessGroup } from '../../utils/process-utils.js';
import { ClaudeSessionManager } from './claudeSessionManager.js';
import type {
  ClaudeStreamMessage,
  ClaudeAssistantMessage,
  ClaudeUserMessage,
  ClaudeResultMessage,
  ClaudeCompactBoundaryMessage,
  ClaudeDriverConfig,
} from './types.js';

const DEBUG = false; // AUDITARIA_CLAUDE_PROVIDER: Debug logging disabled
function dbg(...args: unknown[]) {
  if (DEBUG) console.log('[CLI_DRIVER]', ...args);
}

// AUDITARIA_CLAUDE_PROVIDER: Quote paths for shell invocation on Windows (unquoted spaces split args)
function shellQuote(p: string): string {
  return p.includes(' ') ? `"${p}"` : p;
}

function getShellOption(): boolean | string {
  return process.platform === 'win32' ? 'powershell.exe' : true;
}

export class ClaudeCLIDriver implements ProviderDriver {
  private sessionManager = new ClaudeSessionManager();
  private activeProcess: ChildProcess | null = null;
  private mcpConfigPath: string | null = null; // AUDITARIA_CLAUDE_PROVIDER: temp MCP config file
  private expectingCompactionSummary = false; // AUDITARIA_CLAUDE_PROVIDER: Set after compact_boundary, capture next user text as summary

  constructor(private readonly config: ClaudeDriverConfig) {
    dbg('constructor', { model: config.model, cwd: config.cwd, mcpServerCount: config.mcpServers ? Object.keys(config.mcpServers).length : 0 });
  }

  async *sendMessage(
    prompt: string,
    signal: AbortSignal,
    systemContext?: string,
  ): AsyncGenerator<ProviderEvent> {
    const isFirstCall = !this.sessionManager.getSessionId();
    const args = this.buildArgs();

    // AUDITARIA_CLAUDE_PROVIDER: Pass system context via file on every call.
    // --append-system-prompt-file does NOT persist across --resume sessions.
    if (systemContext) {
      const filePath = this.writeSystemPromptFile(systemContext);
      args.push('--append-system-prompt-file', shellQuote(filePath));
    }

    dbg('sendMessage', { argsCount: args.length, promptLen: prompt.length, hasSystemContext: !!systemContext, isFirstCall });

    const proc = spawn('claude', args, {
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

    // Handle abort — use killProcessGroup for proper Windows process tree termination
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
    return this.sessionManager.getSessionId();
  }

  // AUDITARIA_CLAUDE_PROVIDER: Clear session so next call is "first call" (used by context_forget session reset)
  resetSession(): void {
    this.sessionManager.clearSession();
    this.expectingCompactionSummary = false;
  }

  dispose(): void {
    if (this.activeProcess?.pid) {
      killProcessGroup({ pid: this.activeProcess.pid, escalate: true });
    }
    this.activeProcess = null;
    this.expectingCompactionSummary = false;
    this.cleanupMcpConfig(); // AUDITARIA_CLAUDE_PROVIDER
  }

  private buildArgs(): string[] {
    // Prompt is piped through stdin, not passed as -p argument,
    // to avoid shell quoting issues.
    const args = [
      '--output-format',
      'stream-json',
      '--verbose',
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

    // AUDITARIA_CLAUDE_PROVIDER_START: MCP server passthrough
    const mcpPath = this.getOrWriteMcpConfig();
    if (mcpPath) {
      args.push('--mcp-config', shellQuote(mcpPath));
    }
    // AUDITARIA_CLAUDE_PROVIDER_END

    return args;
  }

  // AUDITARIA_CLAUDE_PROVIDER_START: MCP config file management
  private getOrWriteMcpConfig(): string | null {
    if (this.mcpConfigPath) return this.mcpConfigPath;

    // Convert user-configured MCP servers to Claude CLI's expected format
    const claudeMcpServers: Record<string, Record<string, unknown>> = {};
    const servers = this.config.mcpServers;
    for (const [name, server] of Object.entries(servers || {})) {
      if (server.command) {
        // stdio transport
        claudeMcpServers[name] = {
          type: 'stdio',
          command: server.command,
          args: server.args || [],
          ...(server.env && { env: server.env }),
          ...(server.cwd && { cwd: server.cwd }),
        };
      } else if (server.url || server.httpUrl) {
        // http/sse transport
        const url = server.url || server.httpUrl;
        const transportType = server.type || (server.httpUrl ? 'http' : 'sse');
        claudeMcpServers[name] = {
          type: transportType,
          url,
          ...(server.headers && { headers: server.headers }),
        };
      }
    }

    // AUDITARIA_CLAUDE_PROVIDER: Inject Auditaria tool bridge as an MCP server
    if (this.config.toolBridgePort && this.config.toolBridgeScript) {
      const bridgeArgs = [this.config.toolBridgeScript, '--port', String(this.config.toolBridgePort)];
      // AUDITARIA_AGENT_SESSION: Append --exclude flags for tool filtering
      for (const name of this.config.toolBridgeExclude ?? []) {
        bridgeArgs.push('--exclude', name);
      }
      claudeMcpServers['auditaria-tools'] = {
        type: 'stdio',
        command: process.execPath, // Use exact Node binary running Auditaria
        args: bridgeArgs,
      };
    }

    if (Object.keys(claudeMcpServers).length === 0) return null;

    const configObj = { mcpServers: claudeMcpServers };
    this.mcpConfigPath = join(tmpdir(), `auditaria-mcp-${process.pid}-${Date.now()}.json`);
    writeFileSync(this.mcpConfigPath, JSON.stringify(configObj, null, 2));
    dbg('wrote MCP config', { path: this.mcpConfigPath, serverCount: Object.keys(claudeMcpServers).length });
    return this.mcpConfigPath;
  }

  // AUDITARIA_CLAUDE_PROVIDER: Write system context to .auditaria/.system-prompt file.
  // Path is shellQuote'd when passed as arg to avoid cmd.exe splitting on spaces.
  private writeSystemPromptFile(content: string): string {
    const dir = join(this.config.cwd, '.auditaria');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, '.system-prompt');
    writeFileSync(filePath, content, 'utf-8');
    dbg('wrote system prompt file', { path: filePath, length: content.length });
    return filePath;
  }

  private cleanupMcpConfig(): void {
    if (this.mcpConfigPath) {
      try {
        unlinkSync(this.mcpConfigPath);
        dbg('cleaned up MCP config', this.mcpConfigPath);
      } catch {
        // File may already be gone
      }
      this.mcpConfigPath = null;
    }
  }
  // AUDITARIA_CLAUDE_PROVIDER_END

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
      // AUDITARIA_CLAUDE_PROVIDER: Detect context compaction boundary from Claude subprocess
      if ('subtype' in message && message.subtype === 'compact_boundary') {
        const metadata = (message as ClaudeCompactBoundaryMessage).compact_metadata;
        dbg('compact_boundary detected', { trigger: metadata?.trigger, preTokens: metadata?.pre_tokens });
        yield {
          type: ProviderEventType.Compacted,
          preTokens: metadata?.pre_tokens ?? 0,
          trigger: metadata?.trigger ?? 'auto',
        };
        this.expectingCompactionSummary = true;
      }
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

    // AUDITARIA_CLAUDE_PROVIDER: Capture compaction summary from post-compact user message
    if (this.expectingCompactionSummary) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          this.expectingCompactionSummary = false;
          dbg('captured compaction summary', { length: block.text.length });
          yield {
            type: ProviderEventType.CompactionSummary,
            summary: block.text,
          };
          break; // Only capture the first text block as summary
        }
      }
    }

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
