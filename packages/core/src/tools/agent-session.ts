/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_AGENT_SESSION: Tool for spawning and managing sub-agent sessions
// with alternative LLM providers. Follows the browser_agent pattern (action-based,
// session management, Bridgeable for MCP).

import type { Config } from '../config/config.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type { ToolInvocation, ToolResult } from './tools.js';
import { ToolErrorType } from './tool-error.js';
import { EXTERNAL_AGENT_SESSION_TOOL_NAME } from './tool-names.js';
import { CLAUDE_MODEL_IDS, CODEX_MODEL_IDS, AUDITARIA_MODEL_IDS } from '../providers/types.js';

// -------------------------------------------------------------------
// Types
// -------------------------------------------------------------------

const ACTIONS = ['create', 'send', 'list', 'get', 'kill'] as const;
type Action = (typeof ACTIONS)[number];

// All valid model values the LLM can choose from
const ALL_MODEL_IDS = [
  ...CLAUDE_MODEL_IDS.filter(id => id !== 'auto'),
  ...CODEX_MODEL_IDS.filter(id => id !== 'auto'),
  ...AUDITARIA_MODEL_IDS.filter(id => id !== 'auto'), // AUDITARIA_AGENT_SESSION
] as const;

interface ExternalAgentSessionParams {
  action: Action;
  provider?: string;
  session_id?: string;
  message?: string;
  model?: string;
  mode?: string;
  allow_sub_agents?: boolean;
  system_context?: string;
  // AUDITARIA_AGENT_SESSION: Pagination for 'get' action output
  output_offset?: number;
  output_limit?: number;
}

// -------------------------------------------------------------------
// Tool description
// -------------------------------------------------------------------

const DESCRIPTION = `Manage sessions with alternative LLM providers as external sub-agents. Each sub-agent runs in its own session with its own conversation context and access to Auditaria's tools (file ops, search, browser, etc.).

Available providers:
- "claude" — Claude Code CLI (opus, sonnet, haiku)
- "codex" — OpenAI Codex CLI (gpt-5.3-codex, gpt-5.2-codex, gpt-5.1-codex-mini)
- "auditaria" — Auditaria/Gemini CLI (gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite)

You can spawn any provider, including the same one you are running on.

Actions:
- create: Start a new sub-agent session. Returns the session ID.
- send: Send a message to an existing session. Returns the sub-agent's full response (blocks until done).
- list: Quick overview of all active sessions. Shows: id, provider, model, mode, busy status, message count, age, plus truncated role/context and initial prompt for each session. Use this to recall what sessions exist and what they're for.
- get: Deep inspect a single session. Shows: full custom system context, full initial prompt, and paginated output with line numbers. Works on busy sessions too — shows live streaming output so you can check progress without waiting. Output uses tail mode by default (last 50 lines); use output_offset/output_limit to navigate. Use output_offset=0 to read from the start.
- kill: Terminate a session and free its resources.

Permission modes (set on create):
- "work" (default): Full access — sub-agent can read, write, edit files, run commands, and use all available tools. Use when delegating actual work.
- "consult": Read-only — sub-agent can only read files, search, and analyze. Cannot modify files or run destructive commands. Use when you want opinions, analysis, or code review without changes.

Sub-agent spawning:
- By default, sub-agents cannot spawn their own sub-agents.
- Set allow_sub_agents=true to enable recursive sub-agent chains.

Sessions persist for multi-turn conversations. Use system_context on create to give the sub-agent specific instructions about its role or task.`;

// -------------------------------------------------------------------
// Tool class
// -------------------------------------------------------------------

export class ExternalAgentSessionTool extends BaseDeclarativeTool<ExternalAgentSessionParams, ToolResult> {
  static readonly Name = EXTERNAL_AGENT_SESSION_TOOL_NAME;
  static readonly Bridgeable = true; // auto-bridge to external providers via MCP

  // All actions are parallel-safe — sessions are isolated
  // CLI subprocesses, same-session sends guarded by busy flag, creates use unique IDs.
  override get isReadOnly(): boolean {
    return true;
  }

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      ExternalAgentSessionTool.Name,
      'ExternalAgentSession',
      DESCRIPTION,
      Kind.Other,
      {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The action to perform.',
            enum: [...ACTIONS],
          },
          provider: {
            type: 'string',
            description: 'The provider to use. Required for "create". Options: "claude" (Claude CLI), "codex" (Codex CLI), "auditaria" (Auditaria/Gemini CLI).',
            enum: ['claude', 'codex', 'auditaria'],
          },
          session_id: {
            type: 'string',
            description: 'Session ID. Auto-generated on create, required for send/get/kill.',
          },
          message: {
            type: 'string',
            description: 'The message to send to the sub-agent. Required for "send".',
          },
          model: {
            type: 'string',
            description:
              'Model for the sub-agent. Omit for auto (recommended). ' +
              'Claude models: opus, sonnet, haiku. ' +
              'Codex models: gpt-5.3-codex, gpt-5.2-codex, gpt-5.1-codex-mini. ' +
              'Gemini models: gemini-2.5-pro (default), gemini-2.5-flash, gemini-2.5-flash-lite.',
            enum: [...ALL_MODEL_IDS],
          },
          mode: {
            type: 'string',
            description: 'Permission mode for the session. "work" (default) for full access, "consult" for read-only.',
            enum: ['work', 'consult'],
          },
          allow_sub_agents: {
            type: 'boolean',
            description: 'Whether the sub-agent can spawn its own sub-agents. Default: false.',
          },
          system_context: {
            type: 'string',
            description: 'Custom system context/instructions for the sub-agent session.',
          },
          // AUDITARIA_AGENT_SESSION: Pagination params for 'get' action
          output_offset: {
            type: 'number',
            description: 'For "get" action only. Line offset (0-based) to start reading output from. When omitted, uses tail mode (shows last output_limit lines). When set, shows output_limit lines starting from this position.',
          },
          output_limit: {
            type: 'number',
            description: 'For "get" action only. Number of output lines to return. Default: 50.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      messageBus,
      true,  // canUpdateOutput — stream sub-agent responses
      false, // markdownOutput
    );
  }

  protected override validateToolParamValues(params: ExternalAgentSessionParams): string | null {
    if (!params.action || !ACTIONS.includes(params.action)) {
      return `action must be one of: ${ACTIONS.join(', ')}`;
    }

    if (params.action === 'create' && !params.provider) {
      return 'provider is required for "create" action. Options: "claude", "codex", "auditaria"';
    }

    if (params.action === 'send') {
      if (!params.session_id) return 'session_id is required for "send" action';
      if (!params.message) return 'message is required for "send" action';
    }

    if (params.action === 'get') {
      if (!params.session_id) return 'session_id is required for "get" action';
      if (params.output_offset !== undefined && params.output_offset < 0) return 'output_offset must be >= 0';
      if (params.output_limit !== undefined && params.output_limit < 1) return 'output_limit must be >= 1';
    }

    if (params.action === 'kill' && !params.session_id) {
      return 'session_id is required for "kill" action';
    }

    if (params.mode && params.mode !== 'work' && params.mode !== 'consult') {
      return 'mode must be "work" or "consult"';
    }

    // Validate model matches provider
    if (params.action === 'create' && params.model && params.provider) {
      const claudeModels = new Set<string>(CLAUDE_MODEL_IDS.filter(id => id !== 'auto'));
      const codexModels = new Set<string>(CODEX_MODEL_IDS.filter(id => id !== 'auto'));
      const auditariaModels = new Set<string>(AUDITARIA_MODEL_IDS.filter(id => id !== 'auto')); // AUDITARIA_AGENT_SESSION

      if (params.provider === 'claude' && !claudeModels.has(params.model)) {
        if (codexModels.has(params.model)) {
          return `Model "${params.model}" is a Codex model, but provider is "claude". Claude models: ${[...claudeModels].join(', ')}`;
        }
        if (auditariaModels.has(params.model)) {
          return `Model "${params.model}" is a Gemini model, but provider is "claude". Claude models: ${[...claudeModels].join(', ')}`;
        }
      }
      if (params.provider === 'codex' && !codexModels.has(params.model)) {
        if (claudeModels.has(params.model)) {
          return `Model "${params.model}" is a Claude model, but provider is "codex". Codex models: ${[...codexModels].join(', ')}`;
        }
        if (auditariaModels.has(params.model)) {
          return `Model "${params.model}" is a Gemini model, but provider is "codex". Codex models: ${[...codexModels].join(', ')}`;
        }
      }
      // AUDITARIA_AGENT_SESSION: Validate auditaria model
      if (params.provider === 'auditaria' && !auditariaModels.has(params.model)) {
        if (claudeModels.has(params.model)) {
          return `Model "${params.model}" is a Claude model, but provider is "auditaria". Gemini models: ${[...auditariaModels].join(', ')}`;
        }
        if (codexModels.has(params.model)) {
          return `Model "${params.model}" is a Codex model, but provider is "auditaria". Gemini models: ${[...auditariaModels].join(', ')}`;
        }
      }
    }

    return null;
  }

  protected createInvocation(
    params: ExternalAgentSessionParams,
    messageBus?: MessageBus,
    toolName?: string,
    displayName?: string,
  ): ToolInvocation<ExternalAgentSessionParams, ToolResult> {
    return new ExternalAgentSessionInvocation(
      this.config,
      params,
      messageBus ?? this.messageBus,
      toolName ?? this.name,
      displayName ?? this.displayName,
    );
  }
}

// -------------------------------------------------------------------
// Invocation class
// -------------------------------------------------------------------

class ExternalAgentSessionInvocation extends BaseToolInvocation<ExternalAgentSessionParams, ToolResult> {
  constructor(
    private readonly config: Config,
    params: ExternalAgentSessionParams,
    messageBus: MessageBus,
    toolName?: string,
    displayName?: string,
  ) {
    super(params, messageBus, toolName, displayName);
  }

  getDescription(): string {
    const { action, session_id, provider } = this.params;
    switch (action) {
      case 'create':
        return `Create ${provider} sub-agent session`;
      case 'send':
        return `Send message to session ${session_id}`;
      case 'list':
        return 'List active external agent sessions';
      case 'get':
        return `Inspect session ${session_id}`;
      case 'kill':
        return `Kill session ${session_id}`;
      default:
        return `External agent session: ${action}`;
    }
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<ToolResult> {
    try {
      const manager = this.config.getAgentSessionManager();

      switch (this.params.action) {
        case 'create':
          return await this.executeCreate(manager);
        case 'send':
          return await this.executeSend(manager, signal, updateOutput);
        case 'list':
          return this.executeList(manager);
        case 'get':
          return this.executeGet(manager);
        case 'kill':
          return this.executeKill(manager);
        default:
          return {
            llmContent: `Unknown action: ${this.params.action}`,
            returnDisplay: `Unknown action: ${this.params.action}`,
            error: { message: `Unknown action: ${this.params.action}`, type: ToolErrorType.INVALID_TOOL_PARAMS },
          };
      }
    } catch (e) {
      const msg = e instanceof Error
        ? e.message
        : (typeof e === 'object' && e !== null ? JSON.stringify(e) : String(e));
      return {
        llmContent: `Error: ${msg}`,
        returnDisplay: `Error: ${msg}`,
        error: { message: msg, type: ToolErrorType.EXECUTION_FAILED },
      };
    }
  }

  private async executeCreate(manager: import('../providers/agent-session-manager.js').AgentSessionManager): Promise<ToolResult> {
    // Map short names to driver types
    const providerMap: Record<string, 'claude-cli' | 'codex-cli' | 'auditaria-cli'> = {
      claude: 'claude-cli',
      codex: 'codex-cli',
      auditaria: 'auditaria-cli', // AUDITARIA_AGENT_SESSION
    };

    const provider = providerMap[this.params.provider!];
    if (!provider) {
      return {
        llmContent: `Unknown provider "${this.params.provider}". Options: claude, codex, auditaria`,
        returnDisplay: `Unknown provider: ${this.params.provider}`,
        error: { message: `Unknown provider: ${this.params.provider}`, type: ToolErrorType.INVALID_TOOL_PARAMS },
      };
    }

    // Map 'auto' to undefined (let the CLI use its default)
    const model = this.params.model === 'auto' ? undefined : this.params.model;

    const info = await manager.createSession({
      provider,
      sessionId: this.params.session_id,
      model,
      mode: this.params.mode === 'consult' ? 'consult' : 'work',
      allowSubAgents: this.params.allow_sub_agents ?? false,
      systemContext: this.params.system_context,
    });

    const result = [
      `Sub-agent session created successfully.`,
      `- Session ID: ${info.id}`,
      `- Provider: ${info.provider}`,
      `- Model: ${info.model || 'auto'}`,
      `- Mode: ${info.mode}`,
      ``,
      `Use action "send" with session_id="${info.id}" to send messages to this sub-agent.`,
    ].join('\n');

    return {
      llmContent: result,
      returnDisplay: `Created session: ${info.id} (${info.provider})`,
    };
  }

  private async executeSend(
    manager: import('../providers/agent-session-manager.js').AgentSessionManager,
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<ToolResult> {
    const response = await manager.sendMessage(
      this.params.session_id!,
      this.params.message!,
      signal,
      updateOutput,
    );

    return {
      llmContent: response,
      returnDisplay: `Response from ${this.params.session_id} (${response.length} chars)`,
    };
  }

  private executeList(manager: import('../providers/agent-session-manager.js').AgentSessionManager): ToolResult {
    const sessions = manager.listSessions();

    if (sessions.length === 0) {
      return {
        llmContent: 'No active external agent sessions.',
        returnDisplay: 'No active sessions',
      };
    }

    const lines = sessions.map(s => {
      const age = Math.round((Date.now() - s.createdAt) / 1000);
      let line = `- ${s.id}: provider=${s.provider}, model=${s.model || 'auto'}, mode=${s.mode}, busy=${s.busy}, messages=${s.messageCount}, age=${age}s`;
      // AUDITARIA_AGENT_SESSION: Include truncated context/prompt so LLM can recall session purpose after compression
      if (s.customSystemContext) {
        const truncated = s.customSystemContext.length > 150
          ? s.customSystemContext.slice(0, 150) + '...'
          : s.customSystemContext;
        line += `\n  Role: ${truncated}`;
      }
      if (s.initialMessage) {
        const truncated = s.initialMessage.length > 150
          ? s.initialMessage.slice(0, 150) + '...'
          : s.initialMessage;
        line += `\n  Initial prompt: ${truncated}`;
      }
      if (s.hasOutput) {
        line += `\n  Has output: yes (use "get" action to inspect)`;
      }
      return line;
    });

    const result = `Active external agent sessions (${sessions.length}):\n${lines.join('\n')}`;
    return {
      llmContent: result,
      returnDisplay: `${sessions.length} active session(s)`,
    };
  }

  // AUDITARIA_AGENT_SESSION: Inspect session details with paginated output
  private executeGet(manager: import('../providers/agent-session-manager.js').AgentSessionManager): ToolResult {
    const detail = manager.getSessionDetail(this.params.session_id!);
    if (!detail) {
      return {
        llmContent: `Session "${this.params.session_id}" not found.`,
        returnDisplay: `Session not found: ${this.params.session_id}`,
        error: { message: `Session not found: ${this.params.session_id}`, type: ToolErrorType.EXECUTION_FAILED },
      };
    }

    const { info, output, outputSource, totalLines } = detail;
    const age = Math.round((Date.now() - info.createdAt) / 1000);
    const sections: string[] = [];

    // Session metadata
    sections.push(`Session: ${info.id}`);
    sections.push(`Provider: ${info.provider}, Model: ${info.model || 'auto'}, Mode: ${info.mode}`);
    sections.push(`Status: ${info.busy ? 'BUSY (processing)' : 'idle'}, Messages: ${info.messageCount}, Age: ${age}s`);

    // Custom system context (the user-settable part only)
    if (info.customSystemContext) {
      sections.push(`\nCustom System Context:\n${info.customSystemContext}`);
    }

    // Initial message (raw LLM prompt)
    if (info.initialMessage) {
      sections.push(`\nInitial Message:\n${info.initialMessage}`);
    }

    // Paginated output
    if (outputSource === 'none') {
      sections.push('\nOutput: (none yet)');
    } else {
      const lines = output.split('\n');
      const limit = this.params.output_limit ?? 50;

      let startLine: number;
      if (this.params.output_offset !== undefined) {
        // Explicit offset mode: start from given line
        startLine = Math.min(this.params.output_offset, Math.max(0, totalLines - 1));
      } else {
        // Tail mode (default): show last N lines
        startLine = Math.max(0, totalLines - limit);
      }
      const endLine = Math.min(startLine + limit, totalLines);
      const slice = lines.slice(startLine, endLine);

      const sourceLabel = outputSource === 'partialOutput' ? ' (streaming — agent is still working)' : '';
      sections.push(`\nOutput${sourceLabel} [lines ${startLine}-${endLine - 1} of ${totalLines} total]:`);
      // Number lines like Read tool for easy reference
      slice.forEach((line, i) => {
        sections.push(`${String(startLine + i).padStart(5)}  ${line}`);
      });

      if (endLine < totalLines) {
        sections.push(`\n... ${totalLines - endLine} more lines below. Use output_offset=${endLine} to continue.`);
      }
      if (startLine > 0 && this.params.output_offset !== undefined) {
        sections.push(`... ${startLine} lines above. Use output_offset=0 to see from beginning.`);
      }
    }

    return {
      llmContent: sections.join('\n'),
      returnDisplay: `Session ${info.id}: ${outputSource === 'partialOutput' ? 'streaming' : outputSource === 'lastResponse' ? `${totalLines} lines` : 'no output'}`,
    };
  }

  private executeKill(manager: import('../providers/agent-session-manager.js').AgentSessionManager): ToolResult {
    manager.killSession(this.params.session_id!);
    return {
      llmContent: `Session "${this.params.session_id}" has been terminated.`,
      returnDisplay: `Killed session: ${this.params.session_id}`,
    };
  }
}
