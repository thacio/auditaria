/**
 * AUDITARIA_BROWSER_AGENT_FEATURE: Browser Agent Tool
 *
 * This tool allows Auditaria to use a browser automation agent (browser-use)
 * to perform web tasks. It bridges Auditaria's OAuth credentials to the
 * Python browser-use library.
 *
 * Phase 1: Basic CLI Tool - Simple execution with text result
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import { AuthType } from '../core/contentGenerator.js';
import { ToolErrorType } from './tool-error.js';
import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { BROWSER_AGENT_TOOL_NAME } from './tool-names.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';

export interface BrowserAgentToolParams {
  task: string;
  headless?: boolean;
  model?: string;
}

interface OAuthCredentials {
  access_token?: string;
  refresh_token?: string;
  client_id?: string;
  client_secret?: string;
  token_uri?: string;
  scopes?: string[];
}

export class BrowserAgentToolInvocation extends BaseToolInvocation<
  BrowserAgentToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: BrowserAgentToolParams,
    messageBus?: MessageBus,
  ) {
    super(params, messageBus);
  }

  getDescription(): string {
    const headless = this.params.headless !== false ? 'headless' : 'visible';
    return `Browser agent task (${headless}): ${this.params.task.substring(0, 100)}${this.params.task.length > 100 ? '...' : ''}`;
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<ToolResult> {
    if (signal.aborted) {
      return {
        llmContent: 'Browser agent task was cancelled before it could start.',
        returnDisplay: 'Task cancelled.',
      };
    }

    // Find the browser-use directory relative to project root
    const projectRoot = this.config.getTargetDir();
    const browserUsePath = path.join(projectRoot, 'browser-use');
    const agentScriptPath = path.join(browserUsePath, 'auditaria_agent.py');

    // Check if the agent script exists
    if (!fs.existsSync(agentScriptPath)) {
      return {
        llmContent: `Browser agent script not found at ${agentScriptPath}. Please ensure browser-use is set up correctly.`,
        returnDisplay: 'Browser agent not available.',
        error: {
          message: 'Browser agent script not found',
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }

    // Get credentials
    const credentials = await this.getCredentials();
    if (!credentials) {
      return {
        llmContent:
          'No valid credentials found. Please authenticate with Google first using OAuth or provide an API key.',
        returnDisplay: 'No credentials available.',
        error: {
          message: 'No credentials found',
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }

    // Spawn the process - pass all data via stdin to avoid shell escaping issues
    const env = {
      ...process.env,
      PYTHONUTF8: '1', // Handle Unicode on Windows
    };

    // Build input payload to pass via stdin (avoids all shell escaping issues)
    const inputPayload = {
      task: this.params.task,
      headless: this.params.headless !== false,
      model: this.params.model || 'gemini-2.0-flash',
      credentials: credentials.type === 'oauth' ? credentials.data : null,
      api_key: credentials.type === 'api_key' ? credentials.data : null,
    };

    // Spawn with minimal args - data comes via stdin
    const spawnArgs = ['run', 'python', agentScriptPath, '--stdin'];
    const child = spawn('uv', spawnArgs, {
      cwd: browserUsePath,
      env,
      shell: process.platform === 'win32', // Shell needed on Windows to find uv
      windowsHide: true,
    });

    // Send input via stdin (with newline - Python reads first line as config)
    // Keep stdin open for subsequent commands (like STOP)
    child.stdin.write(JSON.stringify(inputPayload) + '\n');

    let stdout = '';
    let stderr = '';
    let lineBuffer = '';
    let lastStep = 0;
    let finalResult: string | null = null;
    let totalSteps = 0;
    let wasStopped = false;

    // Handle stdout - parse JSON lines for progress
    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      lineBuffer += text;

      // Process complete JSON lines
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const event = JSON.parse(line) as {
            type: string;
            step?: number;
            goal?: string;
            eval?: string;
            result?: string;
            total_steps?: number;
            message?: string;
            url?: string;
          };

          // Update progress based on event type
          if (updateOutput) {
            switch (event.type) {
              case 'start':
                updateOutput('Browser agent starting...');
                break;
              case 'step':
                lastStep = event.step || lastStep + 1;
                const stepInfo = event.goal
                  ? `Step ${lastStep}: ${event.goal}`
                  : `Step ${lastStep}`;
                updateOutput(stepInfo);
                break;
              case 'done':
                finalResult = event.result || null;
                totalSteps = event.total_steps || lastStep;
                updateOutput(`Completed in ${totalSteps} steps`);
                break;
              case 'stopping':
                updateOutput('Stopping...');
                break;
              case 'stopped':
                wasStopped = true;
                finalResult = (event as { partial_result?: string }).partial_result || null;
                totalSteps = event.total_steps || lastStep;
                updateOutput(`Stopped after ${totalSteps} steps`);
                break;
              case 'error':
                updateOutput(`Error: ${event.message}`);
                break;
              case 'info':
                // Don't show info messages in progress
                break;
            }
          }
        } catch {
          // Not a JSON line, might be browser-use's own logging
          // Ignore non-JSON output
        }
      }
    });

    // Handle stderr
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    // Handle abort - send STOP command for graceful shutdown
    const abortHandler = () => {
      // Try graceful stop first by sending STOP command via stdin
      try {
        if (!child.stdin.destroyed) {
          child.stdin.write('STOP\n');
          child.stdin.end();
        }
      } catch {
        // Stdin might already be closed, ignore
      }

      // Give the agent a moment to stop gracefully, then force kill
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGTERM');
        }
      }, 2000);
    };
    signal.addEventListener('abort', abortHandler, { once: true });

    // Wait for completion
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('close', (code) => {
        signal.removeEventListener('abort', abortHandler);
        // Close stdin if still open
        if (!child.stdin.destroyed) {
          try {
            child.stdin.end();
          } catch {
            // Ignore errors
          }
        }
        resolve(code);
      });
      child.on('error', () => {
        signal.removeEventListener('abort', abortHandler);
        resolve(null);
      });
    });

    // Parse result - check for graceful stop first
    if (wasStopped) {
      const result = finalResult || this.extractFinalResult(stdout);
      const stepsInfo = totalSteps > 0 ? ` after ${totalSteps} steps` : '';
      return {
        llmContent: `Browser agent was stopped by user request${stepsInfo}.\n\nTask: ${this.params.task}\n\nPartial result:\n${result || 'No result before stop.'}`,
        returnDisplay: result || 'Task stopped.',
      };
    }

    if (signal.aborted) {
      return {
        llmContent: `Browser agent task was cancelled. Partial output:\n${stdout}`,
        returnDisplay: 'Task cancelled.',
      };
    }

    if (exitCode !== 0) {
      const errorMessage = stderr || 'Unknown error';
      return {
        llmContent: `Browser agent task failed with exit code ${exitCode}.\nError: ${errorMessage}\nOutput: ${stdout}`,
        returnDisplay: `Task failed: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }

    // Use parsed result from JSON events, or fall back to extraction
    const result = finalResult || this.extractFinalResult(stdout);
    const stepsInfo = totalSteps > 0 ? ` (${totalSteps} steps)` : '';

    return {
      llmContent: `Browser agent completed successfully${stepsInfo}.\n\nTask: ${this.params.task}\n\nResult:\n${result || 'Task completed.'}`,
      returnDisplay: result || 'Task completed.',
    };
  }

  private async getCredentials(): Promise<{
    type: 'oauth' | 'api_key';
    data: string | OAuthCredentials;
  } | null> {
    // Get the CLI's current auth type to stay in sync
    const contentGeneratorConfig = this.config.getContentGeneratorConfig();
    const authType = contentGeneratorConfig?.authType;

    // If CLI is using API key (Gemini or Vertex AI), use the same API key
    if (
      authType === AuthType.USE_GEMINI ||
      authType === AuthType.USE_VERTEX_AI
    ) {
      const apiKey =
        contentGeneratorConfig?.apiKey ||
        process.env['GEMINI_API_KEY'] ||
        process.env['GOOGLE_API_KEY'];
      if (apiKey) {
        return { type: 'api_key', data: apiKey };
      }
    }

    // If CLI is using OAuth (LOGIN_WITH_GOOGLE), use OAuth credentials
    if (authType === AuthType.LOGIN_WITH_GOOGLE) {
      const oauthPath = Storage.getOAuthCredsPath();
      if (fs.existsSync(oauthPath)) {
        try {
          const content = fs.readFileSync(oauthPath, 'utf-8');
          const creds = JSON.parse(content) as OAuthCredentials;
          if (creds.access_token) {
            return { type: 'oauth', data: creds };
          }
        } catch {
          // OAuth file couldn't be read
        }
      }
    }

    // Fallback: try OAuth credentials first, then API key
    // (for cases where authType is not set or is COMPUTE_ADC)
    const oauthPath = Storage.getOAuthCredsPath();
    if (fs.existsSync(oauthPath)) {
      try {
        const content = fs.readFileSync(oauthPath, 'utf-8');
        const creds = JSON.parse(content) as OAuthCredentials;
        if (creds.access_token) {
          return { type: 'oauth', data: creds };
        }
      } catch {
        // Continue to API key fallback
      }
    }

    // Final fallback: environment API keys
    const apiKey =
      process.env['GEMINI_API_KEY'] || process.env['GOOGLE_API_KEY'];
    if (apiKey) {
      return { type: 'api_key', data: apiKey };
    }

    return null;
  }

  private extractFinalResult(output: string): string {
    // Look for "Final result:" in the output
    const match = output.match(/Final result:\s*(.+?)(?:\n|$)/s);
    if (match) {
      return match[1].trim();
    }

    // Look for the last non-empty line that contains useful content
    const lines = output.split('\n').filter((line) => line.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      // Skip common noise lines
      if (
        line.startsWith('===') ||
        line.startsWith('Starting') ||
        line.startsWith('Using')
      ) {
        continue;
      }
      if (line.length > 10) {
        return line;
      }
    }

    return '';
  }
}

export class BrowserAgentTool extends BaseDeclarativeTool<
  BrowserAgentToolParams,
  ToolResult
> {
  static readonly Name = BROWSER_AGENT_TOOL_NAME;

  constructor(
    private readonly config: Config,
    messageBus?: MessageBus,
  ) {
    super(
      BrowserAgentTool.Name,
      'Browser Agent',
      `Use a browser automation agent to perform web tasks. The agent can navigate websites, interact with elements, fill forms, extract information, and more.

This tool launches a browser (headless by default) and uses an AI agent to complete the given task autonomously.

Use cases:
- Search for information on websites
- Navigate to specific pages and extract data
- Fill out forms and interact with web applications
- Take screenshots of web pages
- Perform multi-step web workflows

The agent uses your authenticated Google credentials to access web content.

IMPORTANT: Only use this tool when the user explicitly asks you to use a browser or needs real-time web interaction. For simple information retrieval, prefer the google_web_search tool.`,
      Kind.Execute,
      {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description:
              'The task for the browser agent to perform. Be specific and detailed about what you want the agent to do.',
          },
          headless: {
            type: 'boolean',
            description:
              'Whether to run the browser in headless mode (invisible). Defaults to true. Set to false to show the browser window.',
          },
          model: {
            type: 'string',
            description:
              'The model to use for the browser agent. Defaults to gemini-2.0-flash.',
          },
        },
        required: ['task'],
      },
      false, // isOutputMarkdown
      true, // canUpdateOutput
      messageBus,
    );
  }

  protected override validateToolParamValues(
    params: BrowserAgentToolParams,
  ): string | null {
    if (!params.task || !params.task.trim()) {
      return 'Task cannot be empty.';
    }
    return null;
  }

  protected createInvocation(
    params: BrowserAgentToolParams,
    messageBus?: MessageBus,
  ): ToolInvocation<BrowserAgentToolParams, ToolResult> {
    return new BrowserAgentToolInvocation(this.config, params, messageBus);
  }
}
