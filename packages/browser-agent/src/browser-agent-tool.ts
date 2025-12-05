/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolInvocation, ToolResult, Config } from '@google/gemini-cli-core';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  ToolErrorType,
} from '@google/gemini-cli-core';
import type { MessageBus } from '@google/gemini-cli-core';
import { BROWSER_AGENT_TOOL_NAME } from '@google/gemini-cli-core';
import type {
  BrowserAgentParams,
  BrowserAgentResult,
  BrowserStepDisplay,
  BrowserStepInfo,
  AgentStepCallback,
} from './types.js';
import { BrowserAgentError } from './errors.js';
import { CredentialBridge } from './credential-bridge.js';
import { SessionManager } from './session-manager.js';

/**
 * Description for the browser agent tool
 */
const BROWSER_AGENT_DESCRIPTION = `Controls browser sessions for web automation tasks. Supports multiple concurrent browser sessions.

## Session Management

You can run multiple browser sessions in parallel using the \`sessionId\` parameter:
- If no \`sessionId\` and no sessions exist → creates a "default" session
- If no \`sessionId\` and one session exists → uses that session
- If no \`sessionId\` and multiple sessions exist → ERROR (must specify)
- Use descriptive IDs like "admin", "site-a", "comparison" for clarity

## Actions

- \`start\`: Initialize a browser session. Optional - browser auto-starts when needed.
- \`navigate\`: Go to a specific URL. Requires the \`url\` parameter. Auto-starts browser if not running.
- \`act\`: Perform a single action on the page (click, type, etc.). Requires \`instruction\` parameter with natural language description of what to do.
- \`extract\`: Extract structured data from the page. Requires \`instruction\` describing what to extract. Optional \`schema\` defines the output structure (defaults to \`{ extraction: string }\` if not provided).
- \`observe\`: Get a list of possible actions on the current page. Requires \`instruction\` parameter.
- \`screenshot\`: Capture the current page as an image. Saves to temp directory by default. Options:
  - \`fullPage\`: Capture entire scrollable page (default: false, captures viewport only)
  - \`clip\`: Capture specific region \`{x, y, width, height}\`
  - \`selector\`: Capture a specific element by CSS/XPath selector
  - \`type\`: Image format 'png' or 'jpeg' (default: 'png')
  - \`quality\`: JPEG quality 0-100
  - \`mask\`: Array of CSS selectors to hide sensitive elements
  - \`path\`: Custom file path to save screenshot
  - \`returnBase64\`: Return base64 instead of saving to file (for web interface)
- \`agent_task\`: Run an autonomous multi-step task. Requires \`instruction\` and optional \`maxSteps\` (default: 20). Session is automatically closed after completion unless \`closeAfter: false\` is set.
- \`stop\`: Close a browser session. Use \`stopAll: true\` to close all sessions.

## Usage Examples

### Simple (single session)
1. \`{ action: "navigate", url: "https://example.com/products" }\`
2. \`{ action: "extract", instruction: "Get all product names and prices" }\`
3. \`{ action: "stop" }\`

### Autonomous task (auto-closes)
1. \`{ action: "agent_task", instruction: "Go to example.com and extract all product prices" }\`
(Session closes automatically after completion)

### Multi-session comparison
1. \`{ action: "navigate", sessionId: "site-a", url: "https://site-a.com" }\`
2. \`{ action: "navigate", sessionId: "site-b", url: "https://site-b.com" }\`
3. \`{ action: "extract", sessionId: "site-a", instruction: "Get prices" }\`
4. \`{ action: "extract", sessionId: "site-b", instruction: "Get prices" }\`
5. \`{ action: "stop", stopAll: true }\`

## Notes

- Browser sessions persist across tool calls until \`stop\` is called
- Maximum 5 concurrent sessions allowed
- Screenshots are saved to browser-session/screenshots/ directory
- The browser runs in headed (visible, minimized) mode by default with takeover support (headless: false)
`;

/**
 * JSON Schema for browser agent parameters
 */
const BROWSER_AGENT_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [
        'start',
        'navigate',
        'act',
        'extract',
        'screenshot',
        'observe',
        'agent_task',
        'stop',
      ],
      description: 'The browser action to perform',
    },
    sessionId: {
      type: 'string',
      description:
        'Optional session identifier for managing multiple browsers. ' +
        'Examples: "admin", "site-a", "compare-1". ' +
        'If omitted: auto-selects the only active session, or creates "default". ' +
        'Required when multiple sessions are active.',
    },
    stopAll: {
      type: 'boolean',
      description:
        'For stop action: close all active sessions instead of just one. Default: false',
    },
    url: {
      type: 'string',
      description: 'URL to navigate to (for navigate action)',
    },
    instruction: {
      type: 'string',
      description: 'Natural language instruction for the action',
    },
    schema: {
      type: 'object',
      description: 'JSON schema for extract action result structure',
    },
    fullPage: {
      type: 'boolean',
      description:
        'Capture entire scrollable page instead of just the viewport (default: false)',
    },
    clip: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate in CSS pixels' },
        y: { type: 'number', description: 'Y coordinate in CSS pixels' },
        width: { type: 'number', description: 'Width in CSS pixels' },
        height: { type: 'number', description: 'Height in CSS pixels' },
      },
      description:
        'Capture a specific region of the page. Cannot be used with fullPage',
    },
    selector: {
      type: 'string',
      description:
        'CSS selector or XPath to capture a specific element screenshot',
    },
    type: {
      type: 'string',
      enum: ['png', 'jpeg'],
      description: 'Image format (default: png)',
    },
    quality: {
      type: 'number',
      description: 'JPEG quality 0-100. Only used when type is jpeg',
    },
    mask: {
      type: 'array',
      items: { type: 'string' },
      description:
        'CSS selectors of elements to mask with colored overlay (for hiding sensitive data like passwords)',
    },
    maskColor: {
      type: 'string',
      description: 'CSS color for masked overlays (default: #FF00FF)',
    },
    animations: {
      type: 'string',
      enum: ['allow', 'disabled'],
      description:
        'Control CSS/Web animations. Use "disabled" to freeze animations before capture (default: allow)',
    },
    omitBackground: {
      type: 'boolean',
      description: 'Make page background transparent, PNG only (default: false)',
    },
    path: {
      type: 'string',
      description:
        'File path to save screenshot. If not provided, auto-generates in temp directory',
    },
    returnBase64: {
      type: 'boolean',
      description:
        'Return screenshot as base64 string instead of saving to file (for web interface). Default: false',
    },
    maxSteps: {
      type: 'number',
      description: 'Maximum steps for agent_task (default: 20)',
    },
    closeAfter: {
      type: 'boolean',
      description:
        'Close browser session after agent_task completes (default: true). Set to false to keep session open for further actions.',
    },
    model: {
      type: 'string',
      enum: [
        'google/gemini-2.0-flash',
        'google/gemini-2.5-flash',
        'google/gemini-2.5-pro',
      ],
      description: 'Model to use for browser agent (default: google/gemini-2.0-flash)',
    },
    headless: {
      type: 'boolean',
      description:
        'Run browser in headless mode without visible window (default: false = headed with takeover support). Set to true for invisible browser. Only applies to start action.',
    },
  },
  required: ['action'],
};

/**
 * Tool invocation for browser agent
 */
class BrowserAgentToolInvocation extends BaseToolInvocation<
  BrowserAgentParams,
  ToolResult
> {
  private readonly config: Config;

  constructor(
    config: Config,
    params: BrowserAgentParams,
    messageBus?: MessageBus,
    toolName?: string,
    toolDisplayName?: string,
  ) {
    super(params, messageBus, toolName, toolDisplayName);
    this.config = config;
  }

  getDescription(): string {
    const { action, url, instruction } = this.params;
    switch (action) {
      case 'start':
        return 'Starting browser session';
      case 'navigate':
        return `Navigate to ${url || 'URL'}`;
      case 'act':
        return `Browser action: ${instruction?.substring(0, 40) || 'action'}...`;
      case 'extract':
        return `Extract data: ${instruction?.substring(0, 40) || 'data'}...`;
      case 'screenshot':
        return 'Take screenshot';
      case 'observe':
        return `Observe: ${instruction?.substring(0, 40) || 'page'}...`;
      case 'agent_task':
        return `Browser task: ${instruction?.substring(0, 40) || 'task'}...`;
      case 'stop':
        return 'Closing browser session';
      default:
        return `Browser: ${action}`;
    }
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<ToolResult> {
    const sessionManager = SessionManager.getInstance();

    try {
      // Handle stop action specially
      if (this.params.action === 'stop') {
        if (this.params.stopAll) {
          const count = sessionManager.getSessionCount();
          await sessionManager.closeAllSessions();
          return {
            llmContent: `All browser sessions closed (${count} session${count !== 1 ? 's' : ''}).`,
            returnDisplay: `Closed ${count} session${count !== 1 ? 's' : ''}`,
          };
        }
        // Close specific or only session
        const sessionIds = sessionManager.getSessionIds();
        await sessionManager.closeSession(this.params.sessionId);
        const closedId = this.params.sessionId || (sessionIds.length === 1 ? sessionIds[0] : 'default');
        const remainingSessions = sessionManager.getSessionIds();
        return {
          llmContent: `Browser session "${closedId}" closed.` +
            (remainingSessions.length > 0 ? ` Active sessions: ${remainingSessions.join(', ')}` : ''),
          returnDisplay: `Session "${closedId}" closed`,
        };
      }

      // Get credentials from Auditaria's auth system
      const credentials = await CredentialBridge.getCredentials(this.config);

      // Build session config
      const sessionConfig = {
        sessionId: this.params.sessionId,
        model: this.params.model || 'google/gemini-2.0-flash' as const,
        headless: this.params.headless,
        verbose: false,
        // Spread credentials based on mode
        ...(credentials.mode === 'gemini' && { apiKey: credentials.apiKey }),
        ...(credentials.mode === 'vertexai' && {
          apiKey: credentials.apiKey,
          project: credentials.project,
          location: credentials.location,
        }),
        ...(credentials.mode === 'oauth-vertexai' && {
          authClient: credentials.authClient,
          project: credentials.project,
          location: credentials.location,
        }),
      };

      // Get or create session
      const adapter = await sessionManager.getOrCreateSession(sessionConfig);

      // Build step callback for live updates (agent_task only)
      const resolvedSessionId = this.params.sessionId ||
        (sessionManager.getSessionCount() === 1 ? sessionManager.getSessionIds()[0] : 'default');

      let onStepCallback: ((step: AgentStepCallback) => void) | undefined;
      const allSteps: BrowserStepInfo[] = [];

      // DEBUG: Log callback setup
      // console.log('[BrowserAgentTool] Setting up step callback:', {
      //   action: this.params.action,
      //   hasUpdateOutput: !!updateOutput,
      //   willCreateCallback: this.params.action === 'agent_task' && !!updateOutput,
      // });

      if (this.params.action === 'agent_task' && updateOutput) {
        onStepCallback = (step: AgentStepCallback) => {
          // DEBUG: Log received step
          // console.log('[BrowserAgentTool] onStepCallback received:', {
          //   stepNumber: step.stepNumber,
          //   actionsCount: step.actions?.length,
          //   actions: step.actions,
          //   message: step.message,
          //   completed: step.completed,
          //   currentUrl: step.currentUrl,
          // });

          // Convert Stagehand step to our display format
          const primaryAction = step.actions[0];
          const stepInfo: BrowserStepInfo = {
            stepNumber: step.stepNumber,
            action: primaryAction?.type || 'action',
            reasoning: step.message || primaryAction?.reasoning,
            status: step.completed ? 'completed' : 'executing',
          };

          // Add or update the step in our list
          const existingIndex = allSteps.findIndex(s => s.stepNumber === step.stepNumber);
          if (existingIndex >= 0) {
            allSteps[existingIndex] = stepInfo;
          } else {
            allSteps.push(stepInfo);
          }

          // Emit live update as JSON string (will be parsed by display layer)
          const displayUpdate: BrowserStepDisplay = {
            browserSteps: [...allSteps],
            currentUrl: step.currentUrl,
            status: step.completed ? 'completed' : 'running',
            sessionId: resolvedSessionId,
            action: this.params.action,
          };
          const jsonOutput = JSON.stringify(displayUpdate);
          // console.log('[BrowserAgentTool] Calling updateOutput with:', jsonOutput.substring(0, 200));
          updateOutput(jsonOutput);
        };
        // console.log('[BrowserAgentTool] Step callback created successfully');
      }

      // Execute with pause/resume support for agent_task
      let result: BrowserAgentResult;

      if (this.params.action === 'agent_task') {
        // For agent_task, track execution state and support abort
        const abortController = new AbortController();
        const linkedSignal = AbortSignal.any([signal, abortController.signal]);

        sessionManager.setRunning(resolvedSessionId, abortController);

        // Emit initial "running" status BEFORE execution starts
        // This is critical for AI SDK path where onStepFinish only fires AFTER steps complete
        // Without this, the web client never sees status='running' and won't create the stream viewer
        if (updateOutput) {
          const initialDisplay: BrowserStepDisplay = {
            browserSteps: [],
            currentUrl: undefined,
            status: 'running',
            sessionId: resolvedSessionId,
            action: this.params.action,
          };
          updateOutput(JSON.stringify(initialDisplay));
          // console.log('[BrowserAgentTool] Emitted initial running status for stream viewer');
        }

        try {
          result = await adapter.execute(
            this.params,
            linkedSignal,
            onStepCallback,
            resolvedSessionId, // Pass sessionId for pause control
          );
        } catch (error: any) {
          // Handle user-initiated stop
          if (error.message?.includes('stopped by user') || error.message?.includes('Agent stopped')) {
            result = {
              success: true, // Consider it a successful stop, not an error
              action: 'agent_task',
              message: '[Operation Cancelled] Reason: User cancelled the operation.',
              url: (await adapter.getPage())?.url() || undefined,
              steps: [], // Steps are tracked via onStepCallback
            };
            // console.log('[BrowserAgentTool] Agent stopped by user via UI');
          } else {
            // Re-throw other errors
            throw error;
          }
        } finally {
          sessionManager.setReady(resolvedSessionId);
        }
      } else {
        // For other actions, execute normally
        result = await adapter.execute(
          this.params,
          signal,
          onStepCallback,
          resolvedSessionId, // Pass sessionId
        );
      }

      // DEBUG: Log result received from adapter
      // console.log('[BrowserAgentTool] Result received from adapter:', {
      //   success: result.success,
      //   action: result.action,
      //   error: result.error,
      //   hasData: !!result.data,
      //   hasSteps: !!result.steps,
      //   url: result.url,
      // });

      // If result failed, log full error details
      if (!result.success) {
        console.error('[BrowserAgentTool] FAILED RESULT from adapter:');
        console.error('[BrowserAgentTool] Full result object:', JSON.stringify(result, null, 2));
      }

      // Add session info to result
      result.sessionId = resolvedSessionId;
      result.activeSessions = sessionManager.getSessionIds();

      // Auto-close session after agent_task completes (default: true)
      if (this.params.action === 'agent_task' && this.params.closeAfter !== false) {
        try {
          await sessionManager.closeSession(resolvedSessionId);
          // console.log(`[BrowserAgentTool] Session "${resolvedSessionId}" auto-closed after agent_task completed`);
          result.activeSessions = sessionManager.getSessionIds(); // Update active sessions list
        } catch (closeError) {
          console.warn(`[BrowserAgentTool] Failed to auto-close session "${resolvedSessionId}":`, closeError);
          // Don't fail the overall result if close fails
        }
      }

      // For agent_task, return browser steps as final display (keeps steps visible)
      if (this.params.action === 'agent_task' && allSteps.length > 0) {
        // Mark all steps as completed
        allSteps.forEach(step => { step.status = 'completed'; });
        const finalDisplay: BrowserStepDisplay = {
          browserSteps: allSteps,
          currentUrl: result.url,
          status: result.success ? 'completed' : 'error',
          sessionId: resolvedSessionId,
        };
        return {
          llmContent: this.formatForLLM(result),
          returnDisplay: JSON.stringify(finalDisplay),
        };
      }

      return {
        llmContent: this.formatForLLM(result),
        returnDisplay: this.formatForDisplay(result),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Include the specific BrowserAgentError type in the message for debugging
      const detailedMessage =
        error instanceof BrowserAgentError
          ? `[${error.type}] ${message}`
          : message;

      return {
        llmContent: `Browser agent error: ${detailedMessage}`,
        returnDisplay: `Error: ${message}`,
        error: {
          message: detailedMessage,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
  }

  private formatForLLM(result: BrowserAgentResult): string {
    if (!result.success) {
      return `Browser action failed: ${result.error || 'Unknown error'}`;
    }

    const parts: string[] = [];

    parts.push(`Action: ${result.action}`);
    if (result.sessionId) {
      parts.push(`Session: ${result.sessionId}`);
    }
    parts.push(`Success: ${result.success}`);

    // Include message field (e.g., cancellation messages)
    if (result.message) {
      parts.push(result.message);
    }

    // For agent_task, extract message from data.message
    if (result.action === 'agent_task' && result.data && typeof result.data === 'object' && 'message' in result.data && result.data.message) {
      parts.push(String(result.data.message));
    }

    if (result.url) {
      parts.push(`Current URL: ${result.url}`);
    }

    if (result.data !== undefined) {
      // For agent_task, we already extracted the message above, so skip data dump to avoid duplication
      if (result.action !== 'agent_task') {
        parts.push(`Data: ${JSON.stringify(result.data, null, 2)}`);
      }
    }

    if (result.screenshotPath) {
      parts.push(`Screenshot saved: ${result.screenshotPath}`);
    } else if (result.base64) {
      parts.push(`Screenshot captured (${result.screenshotType || 'png'}, base64 encoded, ${result.base64.length} chars)`);
    }

    if (result.steps && result.steps.length > 0) {
      parts.push(`Steps completed: ${result.steps.length}`);
      for (const step of result.steps) {
        parts.push(`  Step ${step.stepNumber}: ${step.action}`);
        if (step.reasoning) {
          parts.push(`    Reasoning: ${step.reasoning}`);
        }
      }
    }

    // Show active sessions if more than one
    if (result.activeSessions && result.activeSessions.length > 1) {
      parts.push(`Active sessions: ${result.activeSessions.join(', ')}`);
    }

    return parts.join('\n');
  }

  private formatForDisplay(result: BrowserAgentResult): string {
    if (!result.success) {
      return `Failed: ${result.error || 'Unknown error'}`;
    }

    switch (result.action) {
      case 'start':
        return 'Browser session started';
      case 'navigate':
        return `Navigated to ${result.url}`;
      case 'act':
        return `Action completed at ${result.url}`;
      case 'extract':
        return `Data extracted from ${result.url}`;
      case 'screenshot':
        if (result.screenshotPath) {
          return `Screenshot saved: ${result.screenshotPath}`;
        }
        return `Screenshot captured (${result.screenshotType || 'png'})`;
      case 'observe':
        return `Observed ${(result.data as unknown[])?.length || 0} possible actions`;
      case 'agent_task':
        return `Task completed in ${result.steps?.length || 0} steps`;
      case 'stop':
        return 'Browser session closed';
      default:
        return `${result.action} completed`;
    }
  }
}

/**
 * Browser Agent Tool for Auditaria
 *
 * Enables AI-driven browser automation using Stagehand.
 * Uses CredentialBridge to automatically use the same authentication as Auditaria.
 */
export class BrowserAgentTool extends BaseDeclarativeTool<
  BrowserAgentParams,
  ToolResult
> {
  static readonly Name = BROWSER_AGENT_TOOL_NAME;
  private readonly config: Config;

  constructor(config: Config, messageBus?: MessageBus) {
    super(
      BrowserAgentTool.Name,
      'BrowserAgent',
      BROWSER_AGENT_DESCRIPTION,
      Kind.Fetch, // Similar to web_fetch - retrieves external data
      BROWSER_AGENT_SCHEMA,
      true, // isOutputMarkdown
      true, // canUpdateOutput - AUDITARIA: Enable for live step updates
      messageBus,
    );
    this.config = config;
  }

  protected override validateToolParamValues(
    params: BrowserAgentParams,
  ): string | null {
    const { action, url, instruction, schema } = params;

    // Validate action-specific required parameters
    switch (action) {
      case 'navigate':
        if (!url || url.trim() === '') {
          return "The 'url' parameter is required for navigate action";
        }
        // Basic URL validation
        try {
          new URL(url);
        } catch {
          return `Invalid URL: ${url}`;
        }
        break;

      case 'act':
      case 'observe':
      case 'agent_task':
        if (!instruction || instruction.trim() === '') {
          return `The 'instruction' parameter is required for ${action} action`;
        }
        break;

      case 'extract':
        if (!instruction || instruction.trim() === '') {
          return "The 'instruction' parameter is required for extract action";
        }
        // Schema is optional - will use default { extraction: string } if not provided
        break;

      case 'start':
      case 'stop':
      case 'screenshot':
        // No additional validation needed
        break;

      default:
        return `Unknown action: ${action}`;
    }

    return null;
  }

  protected createInvocation(
    params: BrowserAgentParams,
    messageBus?: MessageBus,
    toolName?: string,
    displayName?: string,
  ): ToolInvocation<BrowserAgentParams, ToolResult> {
    return new BrowserAgentToolInvocation(
      this.config,
      params,
      messageBus,
      toolName,
      displayName,
    );
  }
}
