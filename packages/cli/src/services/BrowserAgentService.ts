/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_BROWSER_AGENT_FEATURE: Browser Agent Service for Web Interface

import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'events';
import { Storage } from '@google/gemini-cli-core';
import type {
  BrowserAgentState,
  BrowserAgentStartOptions,
  BrowserAgentStepData,
  BrowserAgentResult,
  BrowserAgentStatusUpdate,
  BrowserAgentEvents,
} from './BrowserAgentTypes.js';

interface OAuthCredentials {
  access_token?: string;
  refresh_token?: string;
  client_id?: string;
  client_secret?: string;
  token_uri?: string;
  scopes?: string[];
}

/**
 * Service for managing browser agent Python process
 * Used by WebInterfaceService to handle browser agent requests from web clients
 */
export class BrowserAgentService extends EventEmitter {
  private state: BrowserAgentState = 'idle';
  private currentProcess: ChildProcess | null = null;
  private currentTask: string | null = null;
  private currentSessionPath: string | null = null;
  private steps: BrowserAgentStepData[] = [];
  private startTime: number = 0;
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    super();
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Get current state
   */
  getState(): BrowserAgentState {
    return this.state;
  }

  /**
   * Get current status for clients
   */
  getStatus(): BrowserAgentStatusUpdate {
    return {
      state: this.state,
      task: this.currentTask || undefined,
      currentStep: this.steps.length,
      sessionPath: this.currentSessionPath || undefined,
    };
  }

  /**
   * Check if browser agent is available (Python script exists)
   */
  isAvailable(): boolean {
    const agentScriptPath = path.join(this.workspaceRoot, 'browser-use', 'auditaria_agent.py');
    return fs.existsSync(agentScriptPath);
  }

  /**
   * Start a browser agent task
   */
  async start(options: BrowserAgentStartOptions): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'completed' && this.state !== 'error' && this.state !== 'stopped') {
      throw new Error(`Cannot start: browser agent is currently ${this.state}`);
    }

    // Reset state
    this.steps = [];
    this.currentTask = options.task;
    this.currentSessionPath = null;
    this.startTime = Date.now();

    // Find the browser-use directory
    const browserUsePath = path.join(this.workspaceRoot, 'browser-use');
    const agentScriptPath = path.join(browserUsePath, 'auditaria_agent.py');

    if (!fs.existsSync(agentScriptPath)) {
      this.setState('error');
      this.emitError('Browser agent script not found. Please ensure browser-use is set up correctly.');
      return;
    }

    // Get credentials
    const credentials = await this.getCredentials();
    if (!credentials) {
      this.setState('error');
      this.emitError('No valid credentials found. Please authenticate with Google first.');
      return;
    }

    this.setState('starting');

    // Build input payload
    const inputPayload = {
      task: options.task,
      headless: options.headless !== false,
      model: options.model || 'gemini-2.0-flash',
      credentials: credentials.type === 'oauth' ? credentials.data : null,
      api_key: credentials.type === 'api_key' ? credentials.data : null,
      include_screenshots: options.screenshotMode !== 'none',
      max_steps: options.maxSteps || 50,
    };

    // Spawn Python process
    const env = {
      ...process.env,
      PYTHONUTF8: '1',
    };

    const spawnArgs = ['run', 'python', agentScriptPath, '--stdin'];

    try {
      this.currentProcess = spawn('uv', spawnArgs, {
        cwd: browserUsePath,
        env,
        shell: process.platform === 'win32',
        windowsHide: true,
      });

      // Send input via stdin
      this.currentProcess.stdin?.write(JSON.stringify(inputPayload) + '\n');

      // Handle stdout - parse JSON lines
      let lineBuffer = '';
      this.currentProcess.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        lineBuffer += text;

        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          this.handleJsonLine(line, options.screenshotMode || 'none');
        }
      });

      // Handle stderr
      this.currentProcess.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        // Log stderr but don't treat as error unless process fails
        console.error('[BrowserAgent stderr]', text);
      });

      // Handle process exit
      this.currentProcess.on('close', (code) => {
        this.handleProcessExit(code);
      });

      this.currentProcess.on('error', (error) => {
        this.setState('error');
        this.emitError(`Failed to start browser agent: ${error.message}`);
        this.currentProcess = null;
      });

    } catch (error: any) {
      this.setState('error');
      this.emitError(`Failed to spawn browser agent: ${error.message}`);
    }
  }

  /**
   * Stop the current browser agent task
   */
  stop(): void {
    if (!this.currentProcess || this.state === 'idle' || this.state === 'stopped') {
      return;
    }

    // Send STOP command via stdin
    try {
      if (!this.currentProcess.stdin?.destroyed) {
        this.currentProcess.stdin?.write('STOP\n');
        this.currentProcess.stdin?.end();
      }
    } catch {
      // Stdin might already be closed
    }

    // Give it a moment to stop gracefully, then force kill
    setTimeout(() => {
      if (this.currentProcess && !this.currentProcess.killed) {
        this.currentProcess.kill('SIGTERM');
      }
    }, 2000);

    this.setState('stopped');
  }

  /**
   * Pause the current task (Phase 7)
   */
  pause(): void {
    // TODO: Implement pause functionality
    console.log('Pause not yet implemented');
  }

  /**
   * Resume a paused task (Phase 7)
   */
  resume(): void {
    // TODO: Implement resume functionality
    console.log('Resume not yet implemented');
  }

  /**
   * Handle a JSON line from stdout
   */
  private handleJsonLine(line: string, screenshotMode: string): void {
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
        title?: string;
        timestamp?: string;
        actions?: Array<{ [key: string]: unknown }>;
        screenshot?: string;
        thumbnail?: string;
        partial_result?: string;
        task?: string;
        headless?: boolean;
        max_steps?: number;
        success?: boolean;
      };

      switch (event.type) {
        case 'start':
          this.setState('running');
          break;

        case 'step': {
          const stepNum = event.step || this.steps.length + 1;

          // Extract action description
          let actionDesc: string | null = null;
          if (event.actions && event.actions.length > 0) {
            const actionKeys = Object.keys(event.actions[0]);
            actionDesc = actionKeys[0] || null;
          }

          // Save screenshot if needed
          let screenshotPath: string | null = null;
          if (this.currentSessionPath && event.screenshot) {
            const shouldSave =
              screenshotMode === 'all' ||
              (screenshotMode === 'final' && event.actions?.some((a) => 'done' in a));
            if (shouldSave) {
              screenshotPath = this.saveScreenshot(stepNum, event.screenshot);
            }
          }

          const stepData: BrowserAgentStepData = {
            step: stepNum,
            timestamp: event.timestamp || new Date().toISOString(),
            url: event.url || null,
            title: event.title || null,
            goal: event.goal || null,
            action: actionDesc,
            evaluation: event.eval || null,
            screenshotPath,
            screenshot: event.screenshot,
            thumbnail: event.thumbnail,
          };

          this.steps.push(stepData);
          this.emit('step', stepData);
          break;
        }

        case 'done': {
          const result: BrowserAgentResult = {
            success: event.success !== false,
            result: event.result || null,
            sessionPath: this.currentSessionPath,
            steps: this.steps,
            totalSteps: this.steps.length,
            durationMs: Date.now() - this.startTime,
            stopped: false,
            stopReason: null,
          };

          // Save session metadata
          if (this.currentSessionPath) {
            this.saveSessionMetadata(result);
          }

          this.setState('completed');
          this.emit('done', result);
          break;
        }

        case 'stopping':
          // Agent is gracefully stopping
          break;

        case 'stopped': {
          const result: BrowserAgentResult = {
            success: false,
            result: event.partial_result || null,
            sessionPath: this.currentSessionPath,
            steps: this.steps,
            totalSteps: this.steps.length,
            durationMs: Date.now() - this.startTime,
            stopped: true,
            stopReason: event.message || 'User requested stop',
          };

          if (this.currentSessionPath) {
            this.saveSessionMetadata(result);
          }

          this.setState('stopped');
          this.emit('done', result);
          break;
        }

        case 'error':
          this.emitError(event.message || 'Unknown error');
          break;

        case 'info':
          // Create session folder on first info message if capturing screenshots
          if (!this.currentSessionPath && event.message?.includes('Using')) {
            this.currentSessionPath = this.createSessionFolder();
          }
          break;
      }
    } catch {
      // Not a JSON line, ignore
    }
  }

  /**
   * Handle process exit
   */
  private handleProcessExit(code: number | null): void {
    this.currentProcess = null;

    if (this.state === 'running' || this.state === 'starting') {
      if (code !== 0) {
        this.setState('error');
        this.emitError(`Browser agent exited with code ${code}`);
      }
    }
  }

  /**
   * Set state and emit state change event
   */
  private setState(newState: BrowserAgentState): void {
    this.state = newState;
    this.emit('state-change', this.getStatus());
  }

  /**
   * Emit an error event
   */
  private emitError(message: string): void {
    this.emit('error', { message });
  }

  /**
   * Create a session folder for screenshots and metadata
   */
  private createSessionFolder(): string {
    const baseFolder = 'browser-sessions';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const taskHash = this.hashString(this.currentTask || '').slice(0, 8);
    const sessionName = `${timestamp}_${taskHash}`;
    const sessionPath = path.join(this.workspaceRoot, baseFolder, sessionName);

    fs.mkdirSync(sessionPath, { recursive: true });
    return sessionPath;
  }

  /**
   * Save a screenshot to the session folder
   */
  private saveScreenshot(stepNum: number, base64Data: string): string {
    if (!this.currentSessionPath) return '';

    const filename = `step-${String(stepNum).padStart(2, '0')}.png`;
    const filePath = path.join(this.currentSessionPath, filename);

    try {
      const buffer = Buffer.from(base64Data, 'base64');
      fs.writeFileSync(filePath, buffer);
      return filePath;
    } catch {
      return '';
    }
  }

  /**
   * Save session metadata as JSON
   */
  private saveSessionMetadata(result: BrowserAgentResult): void {
    if (!this.currentSessionPath) return;

    const metadataPath = path.join(this.currentSessionPath, 'session.json');
    const metadata = {
      task: this.currentTask,
      createdAt: new Date().toISOString(),
      ...result,
    };

    try {
      // Remove screenshot data from steps before saving (too large)
      const cleanSteps = result.steps.map(step => ({
        ...step,
        screenshot: undefined,
        thumbnail: undefined,
      }));

      fs.writeFileSync(metadataPath, JSON.stringify({ ...metadata, steps: cleanSteps }, null, 2));
    } catch {
      // Ignore save errors
    }
  }

  /**
   * Simple hash function for session folder names
   */
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Get credentials for the browser agent
   * Reuses logic from browser-agent.ts tool
   */
  private async getCredentials(): Promise<{
    type: 'oauth' | 'api_key';
    data: string | OAuthCredentials;
  } | null> {
    // Try OAuth credentials first
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

    // Fallback to environment API keys
    const apiKey =
      process.env['GEMINI_API_KEY'] || process.env['GOOGLE_API_KEY'];
    if (apiKey) {
      return { type: 'api_key', data: apiKey };
    }

    return null;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    if (this.currentProcess) {
      this.stop();
    }
  }
}
