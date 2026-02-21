/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_AGENT_SESSION: Sub-agent session manager
// Manages lifecycle of sub-agent sessions that use alternative LLM providers.
// Composes ProviderDrivers directly (NOT ProviderManager — no mirroring needed).

import { join } from 'path';
import { readdirSync, statSync, unlinkSync } from 'fs';
import type { ProviderDriver } from './types.js';
import { ProviderEventType } from './types.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { ToolExecutorServer } from './mcp-bridge/toolExecutorServer.js';

const DEBUG = false;
function dbg(..._args: unknown[]) {
  if (DEBUG) process.stderr.write(`[AGENT_SESSION] ${_args.map(String).join(' ')}\n`);
}

// -------------------------------------------------------------------
// Types
// -------------------------------------------------------------------

export type SessionMode = 'work' | 'consult';
export type SessionProviderType = 'claude-cli' | 'codex-cli' | 'auditaria-cli'; // AUDITARIA_AGENT_SESSION: added auditaria-cli

export interface AgentSession {
  id: string;
  provider: SessionProviderType;
  model?: string;
  mode: SessionMode;
  allowSubAgents: boolean;
  driver: ProviderDriver;
  busy: boolean;
  messageCount: number;
  createdAt: number;
  lastMessageAt: number;
}

export interface SessionInfo {
  id: string;
  provider: SessionProviderType;
  model?: string;
  mode: SessionMode;
  busy: boolean;
  messageCount: number;
  createdAt: number;
  lastMessageAt: number;
}

export interface CreateSessionOpts {
  provider: SessionProviderType;
  sessionId?: string;
  model?: string;
  mode?: SessionMode;
  allowSubAgents?: boolean;
  systemContext?: string;
}

// Tools always excluded from sub-agent MCP bridge
const ALWAYS_EXCLUDED_TOOLS = [
  'collaborative_writing',
  'browser_agent',
  'context_management',
  'memory',
];

// Additional tools excluded when mode is 'consult' (read-only)
const CONSULT_EXCLUDED_TOOLS = [
  'write_file',
  'edit',
  'shell',
];

// -------------------------------------------------------------------
// Stale prompt file cleanup
// -------------------------------------------------------------------

/** Delete sub-agent prompt files older than maxAgeDays from .auditaria/prompts/. */
function cleanupStalePromptFiles(cwd: string, maxAgeDays = 7): void {
  const dir = join(cwd, '.auditaria', 'prompts');
  try {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.prompt')) continue;
      const filePath = join(dir, file);
      try {
        if (statSync(filePath).mtime.getTime() < cutoff) {
          unlinkSync(filePath);
          dbg('cleaned up stale prompt file', filePath);
        }
      } catch { /* stat/unlink error — skip */ }
    }
  } catch { /* directory may not exist yet */ }
}

// -------------------------------------------------------------------
// AgentSessionManager
// -------------------------------------------------------------------

export class AgentSessionManager {
  private sessions = new Map<string, AgentSession>();
  private counters = new Map<string, number>(); // per-provider counter for auto IDs

  // ToolExecutorServer state — shared with ProviderManager if one exists
  private toolExecutorServer?: ToolExecutorServer;
  private bridgeScriptPath?: string;

  constructor(
    private readonly cwd: string,
    private readonly getMainProviderType: () => string,
    private readonly getProviderAvailability: () => { claude: boolean; codex: boolean; auditaria: boolean },
    private readonly toolRegistry?: ToolRegistry,
    private readonly buildExternalProviderContext?: () => string,
  ) {
    dbg('constructor', { cwd });
    cleanupStalePromptFiles(cwd);
  }

  // Allow external injection of an already-running ToolExecutorServer
  setToolBridgeInfo(server: ToolExecutorServer, scriptPath: string): void {
    this.toolExecutorServer = server;
    this.bridgeScriptPath = scriptPath;
  }

  // -------------------------------------------------------------------
  // createSession
  // -------------------------------------------------------------------

  async createSession(opts: CreateSessionOpts): Promise<SessionInfo> {
    const { provider, model, systemContext } = opts;
    const mode = opts.mode ?? 'work';
    const allowSubAgents = opts.allowSubAgents ?? false;
    const mainType = this.getMainProviderType();

    // Validate: provider is available
    const availability = this.getProviderAvailability();
    // AUDITARIA_AGENT_SESSION: Map provider type to availability key
    const providerKey = provider === 'claude-cli' ? 'claude' : provider === 'codex-cli' ? 'codex' : 'auditaria';
    if (!availability[providerKey]) {
      const cliName = provider === 'claude-cli' ? 'claude' : provider === 'codex-cli' ? 'codex' : 'auditaria';
      throw new Error(
        `Provider "${provider}" is not available. Make sure the "${cliName}" CLI is installed and on your PATH.`,
      );
    }

    // Generate session ID
    // AUDITARIA_AGENT_SESSION: Map provider type to prefix
    const prefix = provider === 'claude-cli' ? 'claude' : provider === 'codex-cli' ? 'codex' : 'auditaria';
    const sessionId = opts.sessionId ?? this.generateId(prefix);

    if (this.sessions.has(sessionId)) {
      throw new Error(`Session "${sessionId}" already exists. Use a different ID or kill the existing session.`);
    }

    // Ensure tool bridge is available (not needed for auditaria — tools are built-in)
    if (provider !== 'auditaria-cli') {
      await this.ensureToolExecutorServer();
    }

    // Build exclude list for MCP bridge
    const excludeTools: string[] = [...ALWAYS_EXCLUDED_TOOLS];
    if (!allowSubAgents) excludeTools.push('external_agent_session');
    if (mode === 'consult') excludeTools.push(...CONSULT_EXCLUDED_TOOLS);

    // Build system context for sub-agent
    const baseContext = this.buildExternalProviderContext?.() ?? '';
    const subAgentPrompt = buildSubAgentSystemPrompt({
      baseContext,
      sessionId,
      mainProviderName: mainType,
      mode,
      allowSubAgents,
      customSystemContext: systemContext,
      // AUDITARIA_AGENT_SESSION: Auditaria sub-agents have built-in tools (no MCP filtering),
      // so we pass tool restrictions via the system prompt.
      toolRestrictions: provider === 'auditaria-cli' ? excludeTools : undefined,
    });

    // Create driver
    let driver: ProviderDriver;

    switch (provider) {
      case 'claude-cli': {
        const { ClaudeCLIDriver } = await import('./claude/claudeCLIDriver.js');
        driver = new ClaudeCLIDriver({
          model,
          cwd: this.cwd,
          permissionMode: 'bypassPermissions',
          toolBridgePort: this.toolExecutorServer?.getPort() ?? undefined,
          toolBridgeScript: this.bridgeScriptPath,
          toolBridgeExclude: excludeTools.length > 0 ? excludeTools : undefined,
          promptFileId: sessionId,
        });
        break;
      }
      case 'codex-cli': {
        // Uses default ~/.codex/ config (API keys, .env). No config isolation —
        // the driver's injectMcpConfig/removeMcpConfig lifecycle handles MCP markers,
        // and sessions are busy-guarded against concurrent sends.
        const { CodexCLIDriver } = await import('./codex/codexCLIDriver.js');
        driver = new CodexCLIDriver({
          model,
          cwd: this.cwd,
          toolBridgePort: this.toolExecutorServer?.getPort() ?? undefined,
          toolBridgeScript: this.bridgeScriptPath,
          toolBridgeExclude: excludeTools.length > 0 ? excludeTools : undefined,
          sandboxMode: mode === 'consult' ? 'workspace-read-only' : 'danger-full-access',
          promptFileId: sessionId,
        });
        break;
      }
      // AUDITARIA_AGENT_SESSION_START: Auditaria (Gemini) sub-agent driver
      case 'auditaria-cli': {
        const { AuditariaCLIDriver } = await import('./auditaria/auditariaCLIDriver.js');
        driver = new AuditariaCLIDriver({
          model: model || 'gemini-2.5-pro',
          cwd: this.cwd,
          approvalMode: mode === 'consult' ? 'default' : 'yolo',
          promptFileId: sessionId,
        });
        break;
      }
      // AUDITARIA_AGENT_SESSION_END
      default:
        throw new Error(`Unknown provider type: ${provider}`);
    }

    const session: AgentSession = {
      id: sessionId,
      provider,
      model,
      mode,
      allowSubAgents,
      driver,
      busy: false,
      messageCount: 0,
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
    };

    this.sessions.set(sessionId, session);
    dbg('created session', { id: sessionId, provider, model, mode });

    // Store the system prompt — it will be passed on the first sendMessage call
    (session as AgentSession & { _systemContext?: string })._systemContext = subAgentPrompt;

    return this.toSessionInfo(session);
  }

  // -------------------------------------------------------------------
  // sendMessage
  // -------------------------------------------------------------------

  async sendMessage(
    sessionId: string,
    message: string,
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      const active = this.listSessions().map(s => s.id).join(', ') || 'none';
      throw new Error(`Session "${sessionId}" not found. Active sessions: ${active}`);
    }

    if (session.busy) {
      throw new Error(
        `Session "${sessionId}" is busy processing a previous message. ` +
        `Wait for it to finish or kill and recreate the session.`,
      );
    }

    session.busy = true;
    try {
      // Pass system context on every call — some drivers (auditaria, claude) don't
      // persist --append-system-prompt-file across --resume sessions.
      const systemContext = (session as AgentSession & { _systemContext?: string })._systemContext;

      const responseText: string[] = [];
      const toolsUsed = new Map<string, number>();
      let lastUpdateTime = 0;

      // Stream events from driver
      const generator = session.driver.sendMessage(message, signal, systemContext);

      for await (const event of generator) {
        switch (event.type) {
          case ProviderEventType.Content: {
            responseText.push(event.text);
            // Throttle updateOutput to every 200ms
            const now = Date.now();
            if (updateOutput && now - lastUpdateTime > 200) {
              lastUpdateTime = now;
              updateOutput(JSON.stringify({
                type: 'agent_session_streaming',
                sessionId,
                partialText: responseText.join(''),
              }));
            }
            break;
          }
          case ProviderEventType.ToolUse: {
            const name = event.toolName;
            toolsUsed.set(name, (toolsUsed.get(name) ?? 0) + 1);
            if (updateOutput) {
              updateOutput(JSON.stringify({
                type: 'agent_session_tool',
                sessionId,
                toolName: name,
              }));
            }
            break;
          }
          case ProviderEventType.Error: {
            responseText.push(`\n\n[Error: ${event.message}]`);
            break;
          }
          // Thinking, ToolResult, Finished — we don't need to expose these
          default:
            break;
        }
      }

      session.messageCount++;
      session.lastMessageAt = Date.now();

      // Build final response
      let response = responseText.join('');

      // Append tool usage summary if any tools were used
      if (toolsUsed.size > 0) {
        const toolSummary = Array.from(toolsUsed.entries())
          .map(([name, count]) => `${name} (${count})`)
          .join(', ');
        response += `\n\n---\nTools used: ${toolSummary}`;
      }

      return response;
    } finally {
      session.busy = false;
    }
  }

  // -------------------------------------------------------------------
  // listSessions / killSession / disposeAll
  // -------------------------------------------------------------------

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(s => this.toSessionInfo(s));
  }

  killSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found.`);
    }

    session.driver.dispose();
    this.sessions.delete(sessionId);
    dbg('killed session', sessionId);
  }

  disposeAll(): void {
    for (const [id] of this.sessions) {
      try {
        this.killSession(id);
      } catch {
        dbg('error killing session during disposeAll', id);
      }
    }
    this.sessions.clear();
    dbg('disposed all sessions');
  }

  // -------------------------------------------------------------------
  // ToolExecutorServer management
  // -------------------------------------------------------------------

  private async ensureToolExecutorServer(): Promise<void> {
    if (this.toolExecutorServer) return;
    if (!this.toolRegistry) {
      dbg('no tool registry, skipping tool bridge');
      return;
    }

    // Resolve bridge script path
    if (!this.bridgeScriptPath) {
      try {
        const { fileURLToPath } = await import('node:url');
        const { dirname, join: pathJoin } = await import('node:path');
        const bundleDir = dirname(fileURLToPath(import.meta.url));
        this.bridgeScriptPath = pathJoin(bundleDir, 'mcp-bridge.js');
      } catch {
        dbg('could not resolve bridge script path');
        return;
      }
    }

    const server = new ToolExecutorServer(this.toolRegistry);
    try {
      await server.start();
      this.toolExecutorServer = server;
      dbg('tool executor server started', { port: server.getPort() });
    } catch (e) {
      dbg('failed to start tool executor server', e);
    }
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  private generateId(prefix: string): string {
    const count = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, count);
    return `${prefix}-${count}`;
  }

  private toSessionInfo(session: AgentSession): SessionInfo {
    return {
      id: session.id,
      provider: session.provider,
      model: session.model,
      mode: session.mode,
      busy: session.busy,
      messageCount: session.messageCount,
      createdAt: session.createdAt,
      lastMessageAt: session.lastMessageAt,
    };
  }
}

// -------------------------------------------------------------------
// Sub-agent system prompt builder
// -------------------------------------------------------------------

function buildSubAgentSystemPrompt(opts: {
  baseContext: string;
  sessionId: string;
  mainProviderName: string;
  mode: SessionMode;
  allowSubAgents: boolean;
  customSystemContext?: string;
  toolRestrictions?: string[]; // AUDITARIA_AGENT_SESSION: Tool names to restrict (for providers with built-in tools)
}): string {
  const { baseContext, sessionId, mainProviderName, mode, allowSubAgents, customSystemContext, toolRestrictions } = opts;

  const sections: string[] = [];

  if (baseContext) {
    sections.push(baseContext);
  }

  const permissionSection = mode === 'consult'
    ? `### Permissions: READ-ONLY
You are in CONSULT mode. You may ONLY read files, search, and analyze.
Do NOT create, modify, or delete any files. Do NOT run shell commands that modify state.
If you are asked to make changes, describe what you WOULD do instead of doing it.`
    : `### Permissions: FULL ACCESS
You have full access. You may read, write, and modify files, run shell commands, and use all available tools to complete your task.`;

  const subAgentSection = allowSubAgents
    ? `### Sub-Agent Spawning: ENABLED
You may spawn your own sub-agent sessions using the external_agent_session tool to delegate work.`
    : `### Sub-Agent Spawning: DISABLED
You cannot spawn your own sub-agents. Work with the tools available to you directly.`;

  let subAgentPrompt = `---

## External Agent Session Context

You are an external agent session in Auditaria, managed by the main ${mainProviderName} agent. Your session ID is "${sessionId}".

### Your Role
You are being called by another AI agent to help with a task. Your role is NOT limited to coding or auditing — you may be asked to serve in any capacity the main agent needs. This includes but is not limited to:
- **Code**: writing, reviewing, debugging, refactoring, architecture
- **Analysis**: research, critique, comparison, evaluation, brainstorming
- **Creative**: writing, design, ideation, role-playing, storytelling
- **Domain expertise**: any field — security, business, science, UX, legal, etc.

Adapt fully to whatever role or task is given to you. Be thorough but concise — the main agent will use your output to continue its work.

${permissionSection}

${subAgentSection}`;

  // AUDITARIA_AGENT_SESSION: For providers with built-in tools (e.g., auditaria-cli),
  // tool exclusion can't be done via MCP filtering. Instead, list restricted tools in the prompt.
  if (toolRestrictions && toolRestrictions.length > 0) {
    subAgentPrompt += `\n\n### Tool Restrictions\nYou MUST NOT use the following tools: ${toolRestrictions.join(', ')}. If asked to perform an action that requires one of these tools, explain that you cannot use it in this session.`;
  }

  if (customSystemContext) {
    subAgentPrompt += `\n\n### Additional Instructions\n${customSystemContext}`;
  }

  sections.push(subAgentPrompt);

  return sections.join('\n\n');
}
