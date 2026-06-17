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
import type { ExecuteOptions, ToolInvocation, ToolResult } from './tools.js';
import { ToolErrorType } from './tool-error.js';
import { EXTERNAL_AGENT_SESSION_TOOL_NAME } from './tool-names.js';
import {
  CLAUDE_MODEL_IDS,
  CODEX_MODEL_IDS,
  AGY_MODEL_IDS,
} from '../providers/types.js'; // AUDITARIA_AGY_PROVIDER: added AGY_MODEL_IDS
import {
  AUDITARIA_MODEL_IDS,
  VALID_GEMINI_MODELS,
  DEFAULT_GEMINI_MODEL,
} from '../config/models.js'; // AUDITARIA_AGENT_SESSION

// -------------------------------------------------------------------
// Types
// -------------------------------------------------------------------

const ACTIONS = [
  'create',
  'send',
  'list',
  'get',
  'kill',
  'resume',
  'discover',
] as const;
type Action = (typeof ACTIONS)[number];

// All valid model values the LLM can choose from. 'auto' is included once and
// means "use the provider's default" — for Claude this skips --model and lets
// Claude pick its 1M-context Opus when available.
const ALL_MODEL_IDS = [
  'auto',
  ...CLAUDE_MODEL_IDS.filter((id) => id !== 'auto'),
  ...CODEX_MODEL_IDS.filter((id) => id !== 'auto'),
  ...AGY_MODEL_IDS.filter((id) => id !== 'auto'), // AUDITARIA_AGY_PROVIDER
  ...AUDITARIA_MODEL_IDS.filter((id) => id !== 'auto'), // AUDITARIA_AGENT_SESSION
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
  // AUDITARIA_AGENT_SESSION: Resume a stored native CLI session.
  // Required for 'resume' action; optional on 'create' (acts as a resume).
  native_session_id?: string;
  // AUDITARIA_AGENT_SESSION: Discover filters
  query?: string;
  limit?: number;
  all_projects?: boolean;
}

// -------------------------------------------------------------------
// Tool description
// -------------------------------------------------------------------

const DESCRIPTION = `Manage sessions with alternative LLM providers as external sub-agents. Each sub-agent runs in its own session with its own conversation context and access to Auditaria's tools (file ops, search, browser, etc.).

Available providers:
- "claude" — Claude Code CLI (opus, sonnet, haiku)
- "codex" — OpenAI Codex CLI (gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex, gpt-5.2)
- "agy" — Google Antigravity CLI (${AGY_MODEL_IDS.filter((id) => id !== 'auto').join(', ')})
- "auditaria" — Auditaria/Gemini CLI (${AUDITARIA_MODEL_IDS.filter((id) => id !== 'auto').join(', ')})

IMAGE GENERATION & EDITING: Both "agy" and "codex" can generate AND edit images natively, and BOTH can save the result to a real file you can use afterward — just instruct the sub-agent to save into the workspace and report the absolute path.
- "agy" — Native "generate_image" tool. Saves a JPEG (~1024px) to disk and reports the path. Inputs: a text Prompt, an output filename (ImageName), and optionally UP TO 3 input images for editing/combining passed BY ABSOLUTE PATH (ImagePaths) — so reference-image edits are easy: give the sub-agent the file paths (e.g. "edit these images <abs paths> — change only Y"). High-fidelity single-attribute edits. No explicit size arg (describe orientation in the prompt). No API key needed — simplest path.
- "codex" — Native "image_gen" skill. Generates/edits and saves the asset into the workspace + reports the path (verified). Size by default is prompt-controlled ("wide landscape" → 1536×1024, "tall portrait" → 1024×1536, square ~1024²). For EXPLICIT or large sizes (up to 4K, e.g. 3840×2160), quality control, masks, or true transparency, Codex documents a CLI fallback (gpt-image-2 / gpt-image-1.5) that requires OPENAI_API_KEY (ask the user before using it). Can edit local image files (it loads them with view_image first) or reference images; built-in transparent-background via chroma-key removal.
Both work. Pick "agy" for the lightest path (no API key, file saved directly); pick "codex" when you need its extra control (explicit/4K sizes, masks, true transparency — those advanced options need OPENAI_API_KEY). Either way, tell the sub-agent to save the final image into the workspace and report the path.

You can spawn any provider, including the same one you are running on.

Actions:
- create: Start a new sub-agent session. Returns the session ID. Optionally pass native_session_id to resume an existing stored CLI session inside the new local session.
- send: Send a message to an existing session. Returns the sub-agent's full response. IMPORTANT: This blocks until the sub-agent finishes, which can take minutes. Prefer running send calls as background tasks so you can continue working. Use "get" to check on a busy session's progress without blocking.
- list: Quick overview of all active sessions. Shows: id, provider, model, mode, busy status, message count, age, plus truncated role/context and initial prompt for each session. Use this to recall what sessions exist and what they're for.
- get: Deep inspect a single session. Shows: full custom system context, full initial prompt, and paginated output with line numbers. Works on busy sessions too — shows live streaming output so you can check progress without waiting. Output uses tail mode by default (last 50 lines); use output_offset/output_limit to navigate. Use output_offset=0 to read from the start.
- kill: Terminate a session and free its resources.
- resume: Open a stored CLI session by its native session ID. Requires provider + native_session_id. Use discover first to find IDs. Works for Claude, Codex, and Copilot (not auditaria — Gemini sessions are not resumable).
- discover: List stored CLI sessions on disk for the current cwd, sorted newest-first. Returns native session IDs you can feed to resume. Optional filters: provider, query (substring of title/prompts), limit (default 20), all_projects (default false).

Permission modes (set on create):
- "work" (default): Full access — sub-agent can read, write, edit files, run commands, and use all available tools. Use when delegating actual work.
- "consult": Read-only — sub-agent can only read files, search, and analyze. Cannot modify files or run destructive commands. Use when you want opinions, analysis, or code review without changes.

Sub-agent spawning:
- By default, sub-agents cannot spawn their own sub-agents.
- Set allow_sub_agents=true to enable recursive sub-agent chains.

Sessions persist for multi-turn conversations. Use system_context on create to give the sub-agent specific instructions about its role or task.

IMPORTANT — Non-blocking usage pattern (recommended):
Calling "send" directly blocks the main thread and prevents parallel work.
Instead:
If are *Claude*:
1. create/list/get/kill — Call directly (they are instant).
2. send — Wrap inside a background Task tool call (run_in_background=true). Each background Task internally calls external_agent_session(action: "send"). This way multiple sub-agents run truly in parallel without blocking.
3. Use "get" to check progress on busy sessions at any time.`;

// -------------------------------------------------------------------
// Tool class
// -------------------------------------------------------------------

export class ExternalAgentSessionTool extends BaseDeclarativeTool<
  ExternalAgentSessionParams,
  ToolResult
> {
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
            description:
              'The provider to use. Required for "create". Options: "claude" (Claude CLI), "codex" (Codex CLI), "agy" (Google Antigravity CLI), "auditaria" (Auditaria/Gemini CLI).',
            enum: ['claude', 'codex', 'agy', 'auditaria'],
          },
          session_id: {
            type: 'string',
            description:
              'Session ID. Auto-generated on create, required for send/get/kill.',
          },
          message: {
            type: 'string',
            description:
              'The message to send to the sub-agent. Required for "send".',
          },
          model: {
            type: 'string',
            description:
              'Model for the sub-agent. Use "auto" or omit to use the user\'s last-selected model in the underlying CLI — usually this is the preferred choice unless the user has instructed otherwise. ' +
              'Claude models: opus, sonnet, haiku, opus[1m], sonnet[1m] (the [1m] variants have a 1M-token context window — use for long sessions or large codebases). ' +
              'Codex models: gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex, gpt-5.2. ' +
              'Antigravity (agy) models: ' +
              AGY_MODEL_IDS.filter((id) => id !== 'auto').join(', ') +
              '. ' +
              'Gemini models: ' +
              AUDITARIA_MODEL_IDS.filter((id) => id !== 'auto').join(', ') +
              ' (default: ' +
              DEFAULT_GEMINI_MODEL +
              ').',
            enum: [...ALL_MODEL_IDS],
          },
          mode: {
            type: 'string',
            description:
              'Permission mode for the session. "work" (default) for full access, "consult" for read-only.',
            enum: ['work', 'consult'],
          },
          allow_sub_agents: {
            type: 'boolean',
            description:
              'Whether the sub-agent can spawn its own sub-agents. Default: false.',
          },
          system_context: {
            type: 'string',
            description:
              'Custom system context/instructions for the sub-agent session.',
          },
          // AUDITARIA_AGENT_SESSION: Pagination params for 'get' action
          output_offset: {
            type: 'number',
            description:
              'For "get" action only. Line offset (0-based) to start reading output from. When omitted, uses tail mode (shows last output_limit lines). When set, shows output_limit lines starting from this position.',
          },
          output_limit: {
            type: 'number',
            description:
              'For "get" action only. Number of output lines to return. Default: 50.',
          },
          // AUDITARIA_AGENT_SESSION: Resume / discover params
          native_session_id: {
            type: 'string',
            description:
              'Native CLI session ID (from "discover") to resume. Required for "resume" action; optional on "create" to immediately resume a stored session in the new local session.',
          },
          query: {
            type: 'string',
            description:
              'For "discover" action only. Case-insensitive substring filter applied to session title and prompts.',
          },
          limit: {
            type: 'number',
            description:
              'For "discover" action only. Maximum number of sessions returned. Default: 20.',
          },
          all_projects: {
            type: 'boolean',
            description:
              'For "discover" action only. When true, scan sessions across all project directories instead of just the current cwd. Default: false.',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      messageBus,
      true, // canUpdateOutput — stream sub-agent responses
      false, // markdownOutput
    );
  }

  protected override validateToolParamValues(
    params: ExternalAgentSessionParams,
  ): string | null {
    if (!params.action || !ACTIONS.includes(params.action)) {
      return `action must be one of: ${ACTIONS.join(', ')}`;
    }

    if (params.action === 'create' && !params.provider) {
      return 'provider is required for "create" action. Options: "claude", "codex", "agy", "auditaria"';
    }

    if (params.action === 'send') {
      if (!params.session_id) return 'session_id is required for "send" action';
      if (!params.message) return 'message is required for "send" action';
    }

    if (params.action === 'get') {
      if (!params.session_id) return 'session_id is required for "get" action';
      if (params.output_offset !== undefined && params.output_offset < 0)
        return 'output_offset must be >= 0';
      if (params.output_limit !== undefined && params.output_limit < 1)
        return 'output_limit must be >= 1';
    }

    if (params.action === 'kill' && !params.session_id) {
      return 'session_id is required for "kill" action';
    }

    // AUDITARIA_AGENT_SESSION: resume requires provider + native_session_id; auditaria cannot resume
    if (params.action === 'resume') {
      if (!params.provider)
        return 'provider is required for "resume" action. Options: "claude", "codex"';
      if (!params.native_session_id)
        return 'native_session_id is required for "resume" action. Use the "discover" action to find one.';
      if (params.provider === 'auditaria') {
        return 'provider "auditaria" cannot be resumed — Auditaria/Gemini sub-agent sessions do not support cross-restart resume.';
      }
    }

    // AUDITARIA_AGENT_SESSION: discover param sanity
    if (params.action === 'discover') {
      if (params.limit !== undefined && params.limit < 1)
        return 'limit must be >= 1';
      if (
        params.provider &&
        params.provider !== 'claude' &&
        params.provider !== 'codex'
      ) {
        return 'discover only supports provider="claude" or "codex" (or omit to scan both).';
      }
    }

    // AUDITARIA_AGENT_SESSION: native_session_id on create requires resumable provider
    if (
      params.action === 'create' &&
      params.native_session_id &&
      params.provider === 'auditaria'
    ) {
      return 'native_session_id is not supported for provider "auditaria" — Gemini sub-agent sessions are not resumable.';
    }

    if (params.mode && params.mode !== 'work' && params.mode !== 'consult') {
      return 'mode must be "work" or "consult"';
    }

    // Validate model matches provider
    if (params.action === 'create' && params.model && params.provider) {
      const claudeModels = new Set<string>(
        CLAUDE_MODEL_IDS.filter((id) => id !== 'auto'),
      );
      const codexModels = new Set<string>(
        CODEX_MODEL_IDS.filter((id) => id !== 'auto'),
      );
      const agyModels = new Set<string>(
        AGY_MODEL_IDS.filter((id) => id !== 'auto'),
      ); // AUDITARIA_AGY_PROVIDER
      const auditariaModels = VALID_GEMINI_MODELS; // AUDITARIA_AGENT_SESSION

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
      // AUDITARIA_AGY_PROVIDER: Validate agy model
      if (params.provider === 'agy' && !agyModels.has(params.model)) {
        if (claudeModels.has(params.model)) {
          return `Model "${params.model}" is a Claude model, but provider is "agy". Antigravity models: ${[...agyModels].join(', ')}`;
        }
        if (codexModels.has(params.model)) {
          return `Model "${params.model}" is a Codex model, but provider is "agy". Antigravity models: ${[...agyModels].join(', ')}`;
        }
        return `Model "${params.model}" is not a valid Antigravity model. Options: ${[...agyModels].join(', ')}`;
      }
      // AUDITARIA_AGENT_SESSION: Validate auditaria model
      if (
        params.provider === 'auditaria' &&
        !auditariaModels.has(params.model)
      ) {
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

class ExternalAgentSessionInvocation extends BaseToolInvocation<
  ExternalAgentSessionParams,
  ToolResult
> {
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
    const { action, session_id, provider, native_session_id } = this.params;
    switch (action) {
      case 'create':
        return native_session_id
          ? `Create ${provider} sub-agent (resume ${native_session_id})`
          : `Create ${provider} sub-agent session`;
      case 'send':
        return `Send message to session ${session_id}`;
      case 'list':
        return 'List active external agent sessions';
      case 'get':
        return `Inspect session ${session_id}`;
      case 'kill':
        return `Kill session ${session_id}`;
      case 'resume':
        return `Resume stored ${provider} session ${native_session_id}`;
      case 'discover':
        return `Discover stored CLI sessions${provider ? ` (${provider})` : ''}`;
      default:
        return `External agent session: ${action}`;
    }
  }

  async execute(options: ExecuteOptions): Promise<ToolResult> {
    const { abortSignal: signal, updateOutput } = options;
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
        case 'resume':
          return await this.executeResume(manager);
        case 'discover':
          return await this.executeDiscover(manager);
        default:
          return {
            llmContent: `Unknown action: ${this.params.action}`,
            returnDisplay: `Unknown action: ${this.params.action}`,
            error: {
              message: `Unknown action: ${this.params.action}`,
              type: ToolErrorType.INVALID_TOOL_PARAMS,
            },
          };
      }
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.message
          : typeof e === 'object' && e !== null
            ? JSON.stringify(e)
            : String(e);
      return {
        llmContent: `Error: ${msg}`,
        returnDisplay: `Error: ${msg}`,
        error: { message: msg, type: ToolErrorType.EXECUTION_FAILED },
      };
    }
  }

  private async executeCreate(
    manager: import('../providers/agent-session-manager.js').AgentSessionManager,
  ): Promise<ToolResult> {
    // Map short names to driver types
    const providerMap: Record<
      string,
      'claude-cli' | 'codex-cli' | 'agy-cli' | 'auditaria-cli'
    > = {
      claude: 'claude-cli',
      codex: 'codex-cli',
      agy: 'agy-cli', // AUDITARIA_AGY_PROVIDER
      auditaria: 'auditaria-cli', // AUDITARIA_AGENT_SESSION
    };

    const provider = providerMap[this.params.provider!];
    if (!provider) {
      return {
        llmContent: `Unknown provider "${this.params.provider}". Options: claude, codex, agy, auditaria`,
        returnDisplay: `Unknown provider: ${this.params.provider}`,
        error: {
          message: `Unknown provider: ${this.params.provider}`,
          type: ToolErrorType.INVALID_TOOL_PARAMS,
        },
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
      resumeNativeSessionId: this.params.native_session_id,
    });

    const resumed = !!this.params.native_session_id;
    const result = [
      resumed
        ? `Sub-agent session created and resumed stored session "${this.params.native_session_id}".`
        : `Sub-agent session created successfully.`,
      `- Session ID: ${info.id}`,
      `- Provider: ${info.provider}`,
      `- Model: ${info.model || 'auto'}`,
      `- Mode: ${info.mode}`,
      ``,
      `Use action "send" with session_id="${info.id}" to send messages to this sub-agent.`,
    ].join('\n');

    return {
      llmContent: result,
      returnDisplay: resumed
        ? `Resumed ${info.provider} session: ${info.id}`
        : `Created session: ${info.id} (${info.provider})`,
    };
  }

  // AUDITARIA_AGENT_SESSION: Resume a stored CLI session.
  // Thin wrapper around createSession that requires native_session_id.
  private async executeResume(
    manager: import('../providers/agent-session-manager.js').AgentSessionManager,
  ): Promise<ToolResult> {
    const providerMap: Record<string, 'claude-cli' | 'codex-cli'> = {
      claude: 'claude-cli',
      codex: 'codex-cli',
    };
    const provider = providerMap[this.params.provider!];
    if (!provider) {
      return {
        llmContent: `Cannot resume provider "${this.params.provider}". Options: claude, codex`,
        returnDisplay: `Cannot resume: ${this.params.provider}`,
        error: {
          message: `Cannot resume provider: ${this.params.provider}`,
          type: ToolErrorType.INVALID_TOOL_PARAMS,
        },
      };
    }

    const model = this.params.model === 'auto' ? undefined : this.params.model;
    const info = await manager.createSession({
      provider,
      sessionId: this.params.session_id,
      model,
      mode: this.params.mode === 'consult' ? 'consult' : 'work',
      allowSubAgents: this.params.allow_sub_agents ?? false,
      systemContext: this.params.system_context,
      resumeNativeSessionId: this.params.native_session_id!,
    });

    const result = [
      `Resumed stored ${info.provider} session.`,
      `- Native session: ${this.params.native_session_id}`,
      `- Local session ID: ${info.id}`,
      `- Model: ${info.model || 'auto'}`,
      `- Mode: ${info.mode}`,
      ``,
      `Use action "send" with session_id="${info.id}" to continue the conversation.`,
    ].join('\n');

    return {
      llmContent: result,
      returnDisplay: `Resumed ${info.provider} session: ${this.params.native_session_id}`,
    };
  }

  // AUDITARIA_AGENT_SESSION: List stored CLI sessions on disk so the LLM can pick one to resume.
  private async executeDiscover(
    manager: import('../providers/agent-session-manager.js').AgentSessionManager,
  ): Promise<ToolResult> {
    const providerFilter =
      this.params.provider === 'claude' || this.params.provider === 'codex'
        ? this.params.provider
        : undefined;
    const previews = await manager.discoverStoredSessions({
      provider: providerFilter,
      limit: this.params.limit,
      query: this.params.query,
      allProjects: this.params.all_projects ?? false,
    });

    if (previews.length === 0) {
      const where = this.params.all_projects
        ? 'across all projects'
        : 'in this directory';
      return {
        llmContent: `No stored CLI sessions found ${where}.`,
        returnDisplay: 'No stored sessions found',
      };
    }

    const lines = previews.map((p, i) => {
      const ageHours = Math.round((Date.now() - p.modifiedAt) / 3600_000);
      const ageLabel =
        ageHours < 24
          ? `${ageHours}h ago`
          : `${Math.round(ageHours / 24)}d ago`;
      const head = `[${i + 1}] ${p.provider} ${p.nativeSessionId}  (${ageLabel}${p.gitBranch ? `, branch=${p.gitBranch}` : ''})`;
      const titleLine = p.title
        ? `\n     title: ${truncate(p.title, 120)}`
        : '';
      const firstLine =
        p.firstPrompt && p.firstPrompt !== p.title
          ? `\n     first: ${truncate(p.firstPrompt, 120)}`
          : '';
      const lastLine =
        p.lastPrompt && p.lastPrompt !== p.firstPrompt
          ? `\n     last:  ${truncate(p.lastPrompt, 120)}`
          : '';
      return head + titleLine + firstLine + lastLine;
    });

    const result = [
      `Found ${previews.length} stored session(s):`,
      ...lines,
      ``,
      `Use action "resume" with provider + native_session_id to continue any of these.`,
    ].join('\n');

    return {
      llmContent: result,
      returnDisplay: `Found ${previews.length} stored session(s)`,
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

  private executeList(
    manager: import('../providers/agent-session-manager.js').AgentSessionManager,
  ): ToolResult {
    const sessions = manager.listSessions();

    if (sessions.length === 0) {
      return {
        llmContent: 'No active external agent sessions.',
        returnDisplay: 'No active sessions',
      };
    }

    const lines = sessions.map((s) => {
      const age = Math.round((Date.now() - s.createdAt) / 1000);
      let line = `- ${s.id}: provider=${s.provider}, model=${s.model || 'auto'}, mode=${s.mode}, busy=${s.busy}, messages=${s.messageCount}, age=${age}s`;
      // AUDITARIA_AGENT_SESSION: Include truncated context/prompt so LLM can recall session purpose after compression
      if (s.customSystemContext) {
        const truncated =
          s.customSystemContext.length > 150
            ? s.customSystemContext.slice(0, 150) + '...'
            : s.customSystemContext;
        line += `\n  Role: ${truncated}`;
      }
      if (s.initialMessage) {
        const truncated =
          s.initialMessage.length > 150
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
  private executeGet(
    manager: import('../providers/agent-session-manager.js').AgentSessionManager,
  ): ToolResult {
    const detail = manager.getSessionDetail(this.params.session_id!);
    if (!detail) {
      return {
        llmContent: `Session "${this.params.session_id}" not found.`,
        returnDisplay: `Session not found: ${this.params.session_id}`,
        error: {
          message: `Session not found: ${this.params.session_id}`,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }

    const { info, output, outputSource, totalLines } = detail;
    const age = Math.round((Date.now() - info.createdAt) / 1000);
    const sections: string[] = [];

    // Session metadata
    sections.push(`Session: ${info.id}`);
    sections.push(
      `Provider: ${info.provider}, Model: ${info.model || 'auto'}, Mode: ${info.mode}`,
    );
    sections.push(
      `Status: ${info.busy ? 'BUSY (processing)' : 'idle'}, Messages: ${info.messageCount}, Age: ${age}s`,
    );

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
        startLine = Math.min(
          this.params.output_offset,
          Math.max(0, totalLines - 1),
        );
      } else {
        // Tail mode (default): show last N lines
        startLine = Math.max(0, totalLines - limit);
      }
      const endLine = Math.min(startLine + limit, totalLines);
      const slice = lines.slice(startLine, endLine);

      const sourceLabel =
        outputSource === 'partialOutput'
          ? ' (streaming — agent is still working)'
          : '';
      sections.push(
        `\nOutput${sourceLabel} [lines ${startLine}-${endLine - 1} of ${totalLines} total]:`,
      );
      // Number lines like Read tool for easy reference
      slice.forEach((line, i) => {
        sections.push(`${String(startLine + i).padStart(5)}  ${line}`);
      });

      if (endLine < totalLines) {
        sections.push(
          `\n... ${totalLines - endLine} more lines below. Use output_offset=${endLine} to continue.`,
        );
      }
      if (startLine > 0 && this.params.output_offset !== undefined) {
        sections.push(
          `... ${startLine} lines above. Use output_offset=0 to see from beginning.`,
        );
      }
    }

    return {
      llmContent: sections.join('\n'),
      returnDisplay: `Session ${info.id}: ${outputSource === 'partialOutput' ? 'streaming' : outputSource === 'lastResponse' ? `${totalLines} lines` : 'no output'}`,
    };
  }

  private executeKill(
    manager: import('../providers/agent-session-manager.js').AgentSessionManager,
  ): ToolResult {
    manager.killSession(this.params.session_id!);
    return {
      llmContent: `Session "${this.params.session_id}" has been terminated.`,
      returnDisplay: `Killed session: ${this.params.session_id}`,
    };
  }
}

// AUDITARIA_AGENT_SESSION: One-line preview truncation for discover output.
function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}
