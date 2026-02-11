// AUDITARIA_CODEX_PROVIDER: CLI-based driver spawning codex subprocess

import { spawn, type ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { Readable } from 'stream';
import type { ProviderDriver, ProviderEvent } from '../types.js';
import { ProviderEventType } from '../types.js';
import { killProcessGroup } from '../../utils/process-utils.js';
import type {
  CodexStreamMessage,
  CodexItemEvent,
  CodexTurnEvent,
  CodexThreadEvent,
  CodexDriverConfig,
  CodexItem,
} from './types.js';

const DEBUG = false; // AUDITARIA_CODEX_PROVIDER: Debug logging disabled
function dbg(...args: unknown[]) {
  if (DEBUG) console.log('[CODEX_DRIVER]', ...args);
}

// AUDITARIA_CODEX_PROVIDER: Known non-fatal Codex CLI warnings to suppress from error display
const SUPPRESSED_WARNING_PATTERNS = [
  'Under-development features enabled',
  'suppress_unstable_features_warning',
];

// AUDITARIA_CODEX_PROVIDER: Coerce any value to string (Codex items may contain objects)
function toStr(val: unknown): string {
  if (typeof val === 'string') return val;
  if (val == null) return '';
  return JSON.stringify(val);
}

// AUDITARIA_CODEX_PROVIDER: Markers for MCP config injection in ~/.codex/config.toml
const MCP_MARKER_START = '# AUDITARIA_MCP_START';
const MCP_MARKER_END = '# AUDITARIA_MCP_END';

// AUDITARIA_CODEX_PROVIDER: Quote paths for shell:true on Windows (cmd.exe splits unquoted spaces)
function shellQuote(p: string): string {
  return p.includes(' ') ? `"${p}"` : p;
}

export class CodexCLIDriver implements ProviderDriver {
  private threadId: string | undefined;
  private activeProcess: ChildProcess | null = null;
  private expectingCompactionSummary = false;
  /** Track accumulated text length per item ID for delta computation */
  private lastEmittedLength = new Map<string, number>();
  /** Whether we've injected MCP config into ~/.codex/config.toml */
  private mcpConfigInjected = false;

  constructor(private readonly config: CodexDriverConfig) {
    dbg('constructor', { model: config.model, cwd: config.cwd });
  }

  async *sendMessage(
    prompt: string,
    signal: AbortSignal,
    systemContext?: string,
  ): AsyncGenerator<ProviderEvent> {
    // AUDITARIA_CODEX_PROVIDER: Inject MCP servers into ~/.codex/config.toml before spawning.
    // cmd.exe mangles -c flag values with TOML arrays (strips double quotes),
    // so we write to the config file directly where TOML syntax is preserved.
    this.injectMcpConfig();

    const args = this.buildArgs();

    // AUDITARIA_CODEX_PROVIDER: Write system context to instructions file, pass via -c flag
    if (systemContext) {
      const filePath = this.writeInstructionsFile(systemContext);
      args.push('-c', `model_instructions_file=${shellQuote(filePath)}`);
    }

    dbg('sendMessage', { argsCount: args.length, promptLen: prompt.length, hasSystemContext: !!systemContext });

    const proc = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.config.cwd,
      shell: true,
    });
    this.activeProcess = proc;
    dbg('spawned', { pid: proc.pid });

    // Pipe prompt through stdin (same Windows safety as Claude driver)
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
      this.lastEmittedLength.clear();
      dbg('sendMessage FINALLY');
    }
  }

  async interrupt(): Promise<void> {
    if (this.activeProcess?.pid) {
      await killProcessGroup({ pid: this.activeProcess.pid, escalate: true });
    }
  }

  getSessionId(): string | undefined {
    return this.threadId;
  }

  resetSession(): void {
    this.threadId = undefined;
    this.expectingCompactionSummary = false;
  }

  dispose(): void {
    if (this.activeProcess?.pid) {
      killProcessGroup({ pid: this.activeProcess.pid, escalate: true });
    }
    this.activeProcess = null;
    this.expectingCompactionSummary = false;
    this.lastEmittedLength.clear();
    this.removeMcpConfig(); // AUDITARIA_CODEX_PROVIDER: Clean up injected MCP config
  }

  private buildArgs(): string[] {
    const args: string[] = [];

    if (this.threadId) {
      // Resume: `codex exec resume [OPTIONS] <SESSION_ID>`
      // Prompt is piped via stdin (Codex reads from stdin when no PROMPT arg given).
      // AUDITARIA_CODEX_PROVIDER: Do not pass --sandbox/-s to resume. Some Codex builds
      // reject sandbox flags on `exec resume` even though they work on `exec`.
      args.push('exec', 'resume', '--json');
      if (this.config.model) {
        args.push('-m', this.config.model);
      }
      if (this.config.reasoningEffort) {
        args.push(
          '-c',
          `model_reasoning_effort=${this.config.reasoningEffort}`,
        );
      }
      args.push('--skip-git-repo-check', this.threadId);
    } else {
      // New session: Use danger-full-access for file operations
      // AUDITARIA_CODEX_PROVIDER: workspace-write (used by --full-auto) refuses file writes.
      // danger-full-access is required for Codex to create/edit/delete files.
      // Prompt is piped via stdin (Codex reads from stdin when no PROMPT arg given).
      args.push('exec', '--json');
      if (this.config.model) {
        args.push('-m', this.config.model);
      }
      if (this.config.reasoningEffort) {
        args.push(
          '-c',
          `model_reasoning_effort=${this.config.reasoningEffort}`,
        );
      }
      args.push('-s', 'danger-full-access', '--skip-git-repo-check');
    }

    return args;
  }

  // AUDITARIA_CODEX_PROVIDER: Write system context to .auditaria/.codex-instructions file.
  // Path is shellQuote'd when passed as arg to avoid cmd.exe splitting on spaces.
  private writeInstructionsFile(content: string): string {
    const dir = join(this.config.cwd, '.auditaria');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, '.codex-instructions');
    writeFileSync(filePath, content, 'utf-8');
    dbg('wrote instructions file', { path: filePath, length: content.length });
    return filePath;
  }

  // AUDITARIA_CODEX_PROVIDER: Inject MCP server config into ~/.codex/config.toml.
  // We write directly to the config file because cmd.exe (shell:true on Windows)
  // mangles double quotes in -c flag values, breaking TOML array syntax.
  // Uses markers so we can cleanly remove our block on dispose().
  private injectMcpConfig(): void {
    if (this.mcpConfigInjected) return; // Already injected

    const hasBridge = this.config.toolBridgePort && this.config.toolBridgeScript;
    const hasUserServers = this.config.mcpServers && Object.keys(this.config.mcpServers).length > 0;
    if (!hasBridge && !hasUserServers) return; // Nothing to inject

    const configPath = this.getCodexConfigPath();
    let existing = '';
    try {
      if (existsSync(configPath)) {
        existing = readFileSync(configPath, 'utf-8');
      }
    } catch {
      dbg('could not read existing config.toml');
    }

    // Strip any previous injection (stale from crashed session)
    const cleaned = existing.replace(
      new RegExp(`\\n?${MCP_MARKER_START}[\\s\\S]*?${MCP_MARKER_END}\\n?`, 'g'),
      '',
    );

    // Build two TOML blocks:
    // 1. Top-level keys (must come before any [section] in TOML) — prepended
    // 2. MCP [mcp_servers.*] sections — appended
    // Both wrapped with markers so cleanup can strip them cleanly.
    const topBlock = [
      MCP_MARKER_START,
      'tool_output_token_limit = 10000',
      MCP_MARKER_END,
    ].join('\n');

    const mcpLines: string[] = [];
    mcpLines.push(MCP_MARKER_START);

    if (hasBridge) {
      const nodePath = process.execPath.replace(/\\/g, '/');
      const bridgePath = this.config.toolBridgeScript!.replace(/\\/g, '/');
      mcpLines.push('[mcp_servers.auditaria-tools]');
      mcpLines.push(`command = "${nodePath}"`);
      mcpLines.push(`args = ["${bridgePath}", "--port", "${this.config.toolBridgePort}"]`);
    }

    const servers = this.config.mcpServers;
    for (const [name, server] of Object.entries(servers || {})) {
      if (server.command) {
        mcpLines.push(`[mcp_servers.${name}]`);
        mcpLines.push(`command = "${server.command.replace(/\\/g, '/')}"`);
        if (server.args?.length) {
          const argsToml = server.args.map(a => `"${a.replace(/\\/g, '/')}"`).join(', ');
          mcpLines.push(`args = [${argsToml}]`);
        }
      }
    }

    mcpLines.push(MCP_MARKER_END);

    // Ensure ~/.codex/ directory exists
    const configDir = join(homedir(), '.codex');
    mkdirSync(configDir, { recursive: true });

    // Prepend top-level keys, then user's config, then MCP sections at the end
    writeFileSync(configPath, topBlock + '\n' + cleaned + '\n' + mcpLines.join('\n') + '\n');
    this.mcpConfigInjected = true;
    dbg('injected MCP config into', configPath);
  }

  // AUDITARIA_CODEX_PROVIDER: Remove injected MCP config block from ~/.codex/config.toml
  private removeMcpConfig(): void {
    if (!this.mcpConfigInjected) return;

    try {
      const configPath = this.getCodexConfigPath();
      if (existsSync(configPath)) {
        const content = readFileSync(configPath, 'utf-8');
        const cleaned = content.replace(
          new RegExp(`\\n?${MCP_MARKER_START}[\\s\\S]*?${MCP_MARKER_END}\\n?`, 'g'),
          '',
        );
        writeFileSync(configPath, cleaned);
        dbg('removed MCP config from', configPath);
      }
    } catch {
      dbg('could not clean up MCP config');
    }
    this.mcpConfigInjected = false;
  }

  private getCodexConfigPath(): string {
    return join(homedir(), '.codex', 'config.toml');
  }

  private async *readStream(
    proc: ChildProcess,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    if (!proc.stdout) {
      dbg('NO stdout!');
      yield {
        type: ProviderEventType.Error,
        message: 'Codex CLI: no stdout stream available',
      };
      return;
    }
    dbg('readStream starting, stdout available');

    const rl = createInterface({ input: proc.stdout as Readable });
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

        let message: CodexStreamMessage;
        try {
          message = JSON.parse(line) as CodexStreamMessage;
        } catch {
          dbg('skipping non-JSON line:', line.slice(0, 80));
          continue;
        }

        dbg('parsed message type:', message.type);
        yield* this.processEvent(message);
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
        // AUDITARIA_CODEX_PROVIDER: Filter suppressed warnings from stderr before reporting
        const filteredStderr = stderrData
          .split('\n')
          .filter(line => !SUPPRESSED_WARNING_PATTERNS.some(p => line.includes(p)))
          .join('\n')
          .trim();
        yield {
          type: ProviderEventType.Error,
          message: `Codex CLI exited with code ${exitCode}${filteredStderr ? `: ${filteredStderr}` : ''}`,
        };
      }

      yield { type: ProviderEventType.Finished };
    } finally {
      rl.close();
      dbg('readStream FINALLY');
    }
  }

  private *processEvent(
    message: CodexStreamMessage,
  ): Generator<ProviderEvent> {
    // Thread started — capture thread_id for session resume
    if (message.type === 'thread.started') {
      const threadMsg = message as CodexThreadEvent;
      this.threadId = threadMsg.thread_id;
      dbg('thread started, id:', this.threadId);
      return;
    }

    // Turn lifecycle events
    if (message.type === 'turn.completed') {
      const turnMsg = message as CodexTurnEvent;
      dbg('turn completed', { usage: turnMsg.usage });

      // AUDITARIA_CODEX_PROVIDER: Read session JSONL for accurate per-turn token count.
      // The stdout turn.completed only has cumulative values. The session file has
      // last_token_usage with per-turn breakdown including reasoning_output_tokens.
      const contextTokensUsed = this.readSessionTokenUsage();

      if (turnMsg.usage) {
        yield {
          type: ProviderEventType.Finished,
          usage: {
            inputTokens: turnMsg.usage.input_tokens,
            outputTokens: turnMsg.usage.output_tokens,
          },
          contextTokensUsed,
        };
      } else {
        yield {
          type: ProviderEventType.Finished,
          contextTokensUsed,
        };
      }
      return;
    }

    if (message.type === 'turn.failed') {
      const turnMsg = message as CodexTurnEvent;
      dbg('turn failed', { error: turnMsg.error });
      yield {
        type: ProviderEventType.Error,
        message: turnMsg.error || 'Codex turn failed',
      };
      return;
    }

    if (message.type === 'turn.started') {
      return; // No-op, just informational
    }

    // Item lifecycle events
    if (message.type === 'item.started' || message.type === 'item.updated' || message.type === 'item.completed') {
      const itemMsg = message as CodexItemEvent;
      yield* this.processItemEvent(itemMsg);
      return;
    }

    dbg('unknown event type:', message.type);
  }

  private *processItemEvent(
    event: CodexItemEvent,
  ): Generator<ProviderEvent> {
    const item = event.item;
    if (!item) return;

    switch (item.type) {
      case 'agent_message':
        yield* this.processAgentMessage(event, item);
        break;
      case 'reasoning':
        yield* this.processReasoning(event, item);
        break;
      case 'command_execution':
        yield* this.processCommandExecution(event, item);
        break;
      case 'file_change':
        yield* this.processFileChange(event, item);
        break;
      case 'mcp_tool_call':
        yield* this.processMcpToolCall(event, item);
        break;
      case 'contextCompaction':
        yield* this.processContextCompaction(event);
        break;
      case 'error':
        if (event.type === 'item.completed' || event.type === 'item.started') {
          // AUDITARIA_CODEX_PROVIDER: Suppress known non-fatal warnings
          const isSuppressed = SUPPRESSED_WARNING_PATTERNS.some(p => item.message?.includes(p));
          if (!isSuppressed) {
            yield {
              type: ProviderEventType.Error,
              message: item.message,
            };
          } else {
            dbg('suppressed warning:', item.message?.slice(0, 80));
          }
        }
        break;
      // web_search, todo_list — no ProviderEvent mapping needed
    }
  }

  private *processAgentMessage(
    event: CodexItemEvent,
    item: CodexItem & { type: 'agent_message' },
  ): Generator<ProviderEvent> {
    // AUDITARIA_CODEX_PROVIDER: After compaction, check if this is a summary
    const text = toStr(item.text);
    if (this.expectingCompactionSummary && event.type === 'item.completed' && text) {
      this.expectingCompactionSummary = false;
      dbg('captured compaction summary', { length: text.length });
      yield {
        type: ProviderEventType.CompactionSummary,
        summary: text,
      };
      // Also emit as Content so the UI shows it
    }

    if (event.type === 'item.updated' || event.type === 'item.completed') {
      const delta = this.computeTextDelta(item.id, text);
      if (delta) {
        yield {
          type: ProviderEventType.Content,
          text: delta,
        };
      }
    }
  }

  private *processReasoning(
    event: CodexItemEvent,
    item: CodexItem & { type: 'reasoning' },
  ): Generator<ProviderEvent> {
    if (event.type === 'item.updated' || event.type === 'item.completed') {
      const text = toStr(item.text) || toStr(item.summary);
      const delta = this.computeTextDelta(item.id, text);
      if (delta) {
        yield {
          type: ProviderEventType.Thinking,
          text: delta,
        };
      }
    }
  }

  private *processCommandExecution(
    event: CodexItemEvent,
    item: CodexItem & { type: 'command_execution' },
  ): Generator<ProviderEvent> {
    if (event.type === 'item.started') {
      yield {
        type: ProviderEventType.ToolUse,
        toolName: 'command_execution',
        toolId: `codex-${item.id}`,
        input: {
          command: item.command,
          ...(item.cwd && { cwd: item.cwd }),
        },
      };
    } else if (event.type === 'item.completed') {
      const output = toStr(item.aggregated_output);
      const exitInfo = item.exit_code !== undefined ? ` (exit code: ${item.exit_code})` : '';
      yield {
        type: ProviderEventType.ToolResult,
        toolId: `codex-${item.id}`,
        output: output + exitInfo,
        isError: item.exit_code !== undefined && item.exit_code !== 0,
      };
    }
  }

  private *processFileChange(
    event: CodexItemEvent,
    item: CodexItem & { type: 'file_change' },
  ): Generator<ProviderEvent> {
    if (event.type === 'item.started') {
      const paths = item.changes?.map(c => c.path).join(', ') || 'unknown';
      yield {
        type: ProviderEventType.ToolUse,
        toolName: 'file_change',
        toolId: `codex-${item.id}`,
        input: { paths, changes: item.changes },
      };
    } else if (event.type === 'item.completed') {
      yield {
        type: ProviderEventType.ToolResult,
        toolId: `codex-${item.id}`,
        output: `File changes: ${item.status}`,
      };
    }
  }

  private *processMcpToolCall(
    event: CodexItemEvent,
    item: CodexItem & { type: 'mcp_tool_call' },
  ): Generator<ProviderEvent> {
    if (event.type === 'item.started') {
      yield {
        type: ProviderEventType.ToolUse,
        toolName: `mcp__${item.server}__${item.tool}`,
        toolId: `codex-${item.id}`,
        input: item.arguments || {},
      };
    } else if (event.type === 'item.completed') {
      yield {
        type: ProviderEventType.ToolResult,
        toolId: `codex-${item.id}`,
        output: toStr(item.result) || toStr(item.error) || `MCP tool ${item.tool}: ${item.status}`,
        isError: !!item.error,
      };
    }
  }

  private *processContextCompaction(
    event: CodexItemEvent,
  ): Generator<ProviderEvent> {
    if (event.type === 'item.completed') {
      dbg('contextCompaction detected');
      yield {
        type: ProviderEventType.Compacted,
        preTokens: 0, // Codex doesn't report pre-compaction tokens
        trigger: 'auto' as const,
      };
      this.expectingCompactionSummary = true;
    }
  }

  // AUDITARIA_CODEX_PROVIDER: Read session JSONL for accurate per-turn token usage.
  // Returns context_used = last_input + last_output - last_reasoning (tokens that
  // persist in context; reasoning is ephemeral and discarded between turns).
  private readSessionTokenUsage(): number | undefined {
    if (!this.threadId) return undefined;

    try {
      // Session files: ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl
      const sessionsDir = join(homedir(), '.codex', 'sessions');
      const sessionFile = this.findSessionFile(sessionsDir, this.threadId);
      if (!sessionFile) {
        dbg('session file not found for thread', this.threadId);
        return undefined;
      }

      const content = readFileSync(sessionFile, 'utf-8');
      // Find the last token_count event (most recent turn's data)
      let lastTokenCount: string | undefined;
      for (const line of content.split('\n')) {
        if (line.includes('"token_count"') && line.includes('last_token_usage')) {
          lastTokenCount = line;
        }
      }
      if (!lastTokenCount) return undefined;

      const parsed = JSON.parse(lastTokenCount);
      const last = parsed?.payload?.info?.last_token_usage;
      if (!last) return undefined;

      const input = last.input_tokens || 0;
      const output = last.output_tokens || 0;
      const contextUsed = input + output;
      dbg(`[SESSION_TOKENS] input=${input} + output=${output} = ${contextUsed} (output becomes next turn's input)`);
      return contextUsed;
    } catch (e) {
      dbg('failed to read session token usage', e);
      return undefined;
    }
  }

  // Find session JSONL file matching the thread ID in date-organized directory
  private findSessionFile(sessionsDir: string, threadId: string): string | undefined {
    if (!existsSync(sessionsDir)) return undefined;

    // Walk YYYY/MM/DD directories (most recent first for speed)
    try {
      const years = readdirSync(sessionsDir).sort().reverse();
      for (const year of years) {
        const yearPath = join(sessionsDir, year);
        const months = readdirSync(yearPath).sort().reverse();
        for (const month of months) {
          const monthPath = join(yearPath, month);
          const days = readdirSync(monthPath).sort().reverse();
          for (const day of days) {
            const dayPath = join(monthPath, day);
            const files = readdirSync(dayPath);
            const match = files.find(f => f.includes(threadId) && f.endsWith('.jsonl'));
            if (match) return join(dayPath, match);
          }
        }
      }
    } catch {
      dbg('error scanning sessions directory');
    }
    return undefined;
  }

  /**
   * Codex item.updated contains accumulated text, not deltas.
   * Track emitted length per item ID and yield only the new portion.
   */
  private computeTextDelta(itemId: string, text: string): string {
    if (!text) return '';
    const lastLen = this.lastEmittedLength.get(itemId) || 0;
    if (text.length <= lastLen) return '';
    const delta = text.slice(lastLen);
    this.lastEmittedLength.set(itemId, text.length);
    return delta;
  }
}
