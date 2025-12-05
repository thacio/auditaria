/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// NOTE: Stagehand is imported dynamically to avoid crashing the main process on startup.
// The @browserbasehq/stagehand package does heavy initialization on import that
// is incompatible with worker threads used by the CLI.
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type {
  StagehandConfig,
  BrowserAgentResult,
  BrowserAgentParams,
  ExtractResult,
  NavigateResult,
  ActResult,
  ObserveResult,
  ObservableAction,
  ScreenshotResult,
  ScreenshotOptions,
  JsonSchema,
  AgentStep,
  AgentTaskResult,
  AgentStepCallback,
} from './types.js';
// Import SessionManager for pause/resume control
import { SessionManager, SessionState } from './session-manager.js';
import { logger } from './logger.js';

// Type for the dynamically imported Stagehand class
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StagehandInstance = any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ZodModule = any;

/**
 * Stagehand agent result type (from agent.execute())
 */
interface StagehandAgentResult {
  success: boolean;
  message: string;
  actions: StagehandAgentAction[];
  completed: boolean;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens?: number;
    cached_input_tokens?: number;
    inference_time_ms: number;
  };
}

/**
 * Stagehand agent action type (individual steps in agent execution)
 */
interface StagehandAgentAction {
  type: string;
  reasoning?: string;
  action?: string;
  pageUrl?: string;
  pageText?: string;
  timestamp?: number;
  taskCompleted?: boolean;
  [key: string]: unknown;
}

// Cached Zod module
let zodModule: ZodModule | null = null;

/**
 * Load Zod module dynamically
 */
async function loadZod(paths: string[]): Promise<ZodModule> {
  if (zodModule) return zodModule;

  for (const basePath of paths) {
    try {
      const require = createRequire(basePath);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      zodModule = require('zod');
      return zodModule;
    } catch {
      continue;
    }
  }

  throw new Error('Could not load zod module');
}

/**
 * Create default extraction schema - used when no schema provided or schema is empty
 * This matches Stagehand's default behavior
 */
function createDefaultExtractionSchema(z: ZodModule): unknown {
  return z.object({
    extraction: z.string().describe('The extracted content from the page'),
  });
}

/**
 * Check if a JSON Schema is empty/minimal (no useful properties)
 */
function isEmptySchema(schema: JsonSchema | undefined): boolean {
  if (!schema) return true;
  if (!schema.type) return true;
  if (schema.type === 'object' && (!schema.properties || Object.keys(schema.properties).length === 0)) {
    return true;
  }
  return false;
}

/**
 * Convert a JSON Schema to a Zod schema
 * This allows the AI to send JSON Schema and we convert it for Stagehand
 */
function jsonSchemaToZod(z: ZodModule, schema: JsonSchema): unknown {
  if (!schema || !schema.type) {
    // Use default extraction schema if no schema provided
    return createDefaultExtractionSchema(z);
  }

  switch (schema.type) {
    case 'string': {
      let zodString = z.string();
      if (schema.description) {
        zodString = zodString.describe(schema.description);
      }
      if (schema.enum) {
        return z.enum(schema.enum as [string, ...string[]]);
      }
      return zodString;
    }

    case 'number':
    case 'integer': {
      let zodNumber = z.number();
      if (schema.description) {
        zodNumber = zodNumber.describe(schema.description);
      }
      return zodNumber;
    }

    case 'boolean': {
      let zodBoolean = z.boolean();
      if (schema.description) {
        zodBoolean = zodBoolean.describe(schema.description);
      }
      return zodBoolean;
    }

    case 'array':
      if (schema.items) {
        return z.array(jsonSchemaToZod(z, schema.items));
      }
      return z.array(z.string()); // Default to array of strings

    case 'object':
      if (schema.properties && Object.keys(schema.properties).length > 0) {
        const shape: Record<string, unknown> = {};
        const required = schema.required || [];

        for (const [key, propSchema] of Object.entries(schema.properties)) {
          const zodType = jsonSchemaToZod(z, propSchema);
          // Make optional if not in required array
          shape[key] = required.includes(key) ? zodType : (zodType as any).optional();
        }

        return z.object(shape);
      }
      // Empty object schema - use default extraction
      return createDefaultExtractionSchema(z);

    default:
      return createDefaultExtractionSchema(z);
  }
}

/**
 * Stagehand Action type (matches their return from observe)
 */
interface StagehandAction {
  selector: string;
  description: string;
  method?: string;
  arguments?: string[];
}

/**
 * Adapter for Stagehand v3 browser automation
 *
 * This class provides an abstraction over Stagehand to allow
 * for potential future provider changes and consistent error handling.
 *
 * IMPORTANT: Stagehand is loaded dynamically on first use to avoid
 * crashing the CLI worker thread on startup.
 */
export class StagehandAdapter {
  private stagehand: StagehandInstance | null = null;
  private config: StagehandConfig;
  private isInitialized = false;
  private resolutionPaths: string[] = [];

  constructor(config: StagehandConfig) {
    this.config = config;
  }

  /**
   * Get resolution paths for dynamic module loading
   */
  private getResolutionPaths(): string[] {
    if (this.resolutionPaths.length > 0) {
      return this.resolutionPaths;
    }

    this.resolutionPaths = [
      // 1. Try from bundle location (global install - node_modules is sibling to bundle/)
      // __dirname is set by esbuild banner to the bundle directory
      typeof __dirname !== 'undefined'
        ? `file://${__dirname}/../package.json`
        : null,
      // 2. Try from CLI package (when running from project root)
      `file://${process.cwd()}/packages/cli/package.json`,
      // 3. Try from browser-agent package (local dev fallback)
      `file://${process.cwd()}/packages/browser-agent/package.json`,
    ].filter(Boolean) as string[];

    return this.resolutionPaths;
  }

  /**
   * Load Stagehand module from available locations
   * Tries multiple paths to support both global install and local development
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async loadStagehand(): Promise<{ Stagehand: any }> {
    const paths = this.getResolutionPaths();

    for (const basePath of paths) {
      try {
        const require = createRequire(basePath);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const stagehand = require('@browserbasehq/stagehand');
        return stagehand;
      } catch {
        // Try next path
        continue;
      }
    }

    throw new Error(
      'Could not load @browserbasehq/stagehand. ' +
        'Make sure it is installed: npm install @browserbasehq/stagehand',
    );
  }

  /**
   * Get Windows display scale factor from registry
   * Reads DPI from registry and converts to scale factor (DPI / 96)
   * Returns scale factor (e.g., 1.0, 1.25, 1.5, 1.67, 2.0) or undefined on non-Windows
   */
  private async getWindowsScaleFactor(): Promise<number | undefined> {
    if (process.platform !== 'win32') {
      return undefined; // Let Chrome handle DPI automatically on macOS/Linux
    }

    try {
      const { execSync } = await import('child_process');

      // Try LogPixels first (custom scaling), then AppliedDPI (standard scaling)
      const result = execSync(
        'reg query "HKEY_CURRENT_USER\\Control Panel\\Desktop" /v LogPixels 2>nul || ' +
          'reg query "HKEY_CURRENT_USER\\Control Panel\\Desktop\\WindowMetrics" /v AppliedDPI 2>nul',
        { encoding: 'utf8', timeout: 5000 },
      );

      // Parse: "    LogPixels    REG_DWORD    0x78"
      const match = result.match(/REG_DWORD\s+0x([0-9a-fA-F]+)/);
      if (match) {
        const dpi = parseInt(match[1], 16);
        const scaleFactor = dpi / 96;
        logger.debug(
          `[StagehandAdapter] Detected Windows DPI: ${dpi} (scale factor: ${scaleFactor.toFixed(2)})`,
        );
        return scaleFactor;
      }
    } catch {
      logger.warn('[StagehandAdapter] Could not read Windows DPI from registry');
    }

    return undefined;
  }

  /**
   * Get the Playwright Chromium executable path
   * This ensures Stagehand uses the bundled Chromium instead of searching for system Chrome
   * @returns The path to Chromium executable, or undefined to let chrome-launcher auto-detect
   */
  private async getChromiumExecutablePath(): Promise<string | undefined> {
    try {
      // Dynamically import playwright to get its bundled Chromium path
      const paths = this.getResolutionPaths();

      for (const basePath of paths) {
        try {
          const require = createRequire(basePath);
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const playwright = require('playwright');
          const execPath = playwright.chromium.executablePath();

          // Verify the executable exists
          const fs = await import('fs');
          if (fs.existsSync(execPath)) {
            logger.debug(`[StagehandAdapter] Using Playwright Chromium: ${execPath}`);
            return execPath;
          } else {
            logger.warn(`[StagehandAdapter] Playwright Chromium not found at: ${execPath}`);
            logger.warn('[StagehandAdapter] Run "npx playwright install chromium" to install it');
          }
          break; // Found playwright module, don't try other paths
        } catch {
          continue; // Try next path
        }
      }
    } catch (error) {
      logger.debug('[StagehandAdapter] Could not get Playwright Chromium path:', error);
    }

    // Fall back to chrome-launcher auto-detection (system Chrome)
    logger.debug('[StagehandAdapter] Falling back to system Chrome detection');
    return undefined;
  }

  /**
   * Initialize the Stagehand instance and browser
   * This dynamically imports Stagehand to avoid startup crashes.
   *
   * Supports three auth modes:
   * 1. OAuth mode: authClient + project (uses Vertex AI with OAuth)
   * 2. Vertex AI mode: apiKey + project + location
   * 3. Gemini API mode: apiKey only (standard Gemini API)
   */
  async init(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    // Load Stagehand dynamically - try multiple resolution paths
    // 1. Global install: resolve from bundle directory (node_modules is sibling to bundle/)
    // 2. Local dev: resolve from browser-agent package
    const { Stagehand } = await this.loadStagehand();

    // Get system DPI scale factor for proper viewport rendering
    const deviceScaleFactor = await this.getWindowsScaleFactor();

    // Get Playwright's Chromium path (auto-installed via @playwright/browser-chromium)
    // COMMENTED OUT: Let chrome-launcher auto-detect system Chrome instead of using Playwright's Chrome for Testing
    // const chromiumPath = await this.getChromiumExecutablePath();

    // Build clientOptions based on what credentials we have
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientOptions: any = {};

    if (this.config.authClient && this.config.project) {
      // OAuth mode - use Vertex AI with OAuth client
      // The modified GoogleClient in Stagehand will handle this
      clientOptions.authClient = this.config.authClient;
      clientOptions.project = this.config.project;
      clientOptions.location = this.config.location || 'us-central1';
    } else if (this.config.project && this.config.apiKey) {
      // Vertex AI mode with API key
      clientOptions.apiKey = this.config.apiKey;
      clientOptions.project = this.config.project;
      clientOptions.location = this.config.location || 'us-central1';
      clientOptions.vertexai = true;
    } else if (this.config.apiKey) {
      // Standard Gemini API with API key
      clientOptions.apiKey = this.config.apiKey;
    }

    // Note: headless must be in localBrowserLaunchOptions per Stagehand v3 docs
    // See: https://docs.stagehand.dev/v3/configuration/browser

    // Determine the correct model name format
    // For OAuth mode, use short model name (e.g., "gemini-2.0-flash") to bypass AI SDK
    // and use our patched GoogleClient which supports OAuth via @google/genai
    // The AI SDK path (@ai-sdk/google) only supports API keys, not OAuth
    let modelName: string = this.config.model;
    if (clientOptions.authClient && this.config.model.startsWith('google/')) {
      // Convert "google/gemini-2.0-flash" to "gemini-2.0-flash" for OAuth mode
      modelName = this.config.model.replace('google/', '');
    }

    // Build the model config properly
    // Stagehand's resolveModelConfiguration extracts modelName and puts everything else in clientOptions
    // So we need to put authClient, project, location at the TOP level, not nested in clientOptions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const modelConfig: any = {
      modelName: modelName,
      ...clientOptions, // Spread authClient, project, location, apiKey at top level
    };

    this.stagehand = new Stagehand({
      env: 'LOCAL',
      model: modelConfig,
      localBrowserLaunchOptions: {
        headless: this.config.headless ?? false,  // Default to headed mode (with takeover support)
        // COMMENTED OUT: Let chrome-launcher auto-detect system Chrome
        // ...(chromiumPath && { executablePath: chromiumPath }),
        ...(deviceScaleFactor !== undefined && { deviceScaleFactor }),  // Only set on Windows
        args: [
          '--start-minimized',                         // Start browser minimized to avoid flash
          '--disable-backgrounding-occluded-windows',  // Keep rendering when window is covered
          '--disable-renderer-backgrounding',          // Prevent renderer throttling
          '--disable-background-timer-throttling',     // Prevent timer throttling
          '--disable-ipc-flooding-protection',         // Allow high-frequency IPC for streaming
        ],
      },
      verbose: 0,           // Only show errors (0=errors, 1=info, 2=debug)
      disablePino: true,    // Disable pino logger to reduce noise
      enableCaching: false,
    } as any);

    await this.stagehand.init();
    this.isInitialized = true;

    // If browser is headed (not headless), minimize it immediately
    // This keeps the browser hidden during normal operation until user clicks "Take Over"
    if (!this.config.headless) {
      logger.debug('[StagehandAdapter] Browser started in headed mode - minimizing window...');
      try {
        await this.minimizeWindow();
      } catch (error) {
        logger.warn('[StagehandAdapter] Could not minimize window on startup:', error);
        // Don't fail initialization if minimization fails
      }
    }
  }

  /**
   * Ensure Stagehand is initialized before operations
   * Auto-initializes if not already started
   */
  private async ensureInitialized(): Promise<StagehandInstance> {
    if (!this.stagehand || !this.isInitialized) {
      await this.init();
    }
    return this.stagehand;
  }

  /**
   * Get the current page (v3 API: via context.pages())
   * Note: Use getPage() for async access with auto-init
   */
  async getPage() {
    const stagehand = await this.ensureInitialized();
    return stagehand.context.pages()[0];
  }

  /**
   * Minimize browser window via CDP
   * Only works for headed browsers (headless: false)
   * Used to keep browser hidden during normal operation
   */
  async minimizeWindow(): Promise<void> {
    if (this.config.headless) {
      logger.debug('[StagehandAdapter] Cannot minimize headless browser - skipping');
      return;
    }

    const page = await this.getPage();

    try {
      // Get window ID via CDP
      const { windowId } = await (page as any).sendCDP('Browser.getWindowForTarget');

      // Minimize window
      await (page as any).sendCDP('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'minimized' }
      });

      logger.debug('[StagehandAdapter] Browser window minimized');
    } catch (error) {
      logger.error('[StagehandAdapter] Failed to minimize window:', error);
      throw error;
    }
  }

  /**
   * Show browser window via CDP (bring to front)
   * Only works for headed browsers (headless: false)
   * Used during takeover to make browser visible
   */
  async showWindow(): Promise<void> {
    if (this.config.headless) {
      logger.debug('[StagehandAdapter] Cannot show headless browser - skipping');
      return;
    }

    const page = await this.getPage();

    try {
      // Get window ID via CDP
      const { windowId } = await (page as any).sendCDP('Browser.getWindowForTarget');

      // Show window (normal state)
      await (page as any).sendCDP('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'normal' }
      });

      // Bring window to front (focus it) via CDP - more reliable than Playwright's bringToFront
      await (page as any).sendCDP('Page.bringToFront');

      logger.debug('[StagehandAdapter] Browser window shown and brought to front');
    } catch (error) {
      logger.error('[StagehandAdapter] Failed to show window:', error);
      throw error;
    }
  }

  /**
   * Navigate to a URL (auto-starts browser if needed)
   */
  async navigate(url: string): Promise<NavigateResult> {
    const stagehand = await this.ensureInitialized();
    const page = stagehand.context.pages()[0];

    await page.goto(url, { waitUntil: 'load' });

    return {
      success: true,
      url: page.url(),
      title: await page.title(),
    };
  }

  /**
   * Perform a single atomic action (auto-starts browser if needed)
   */
  async act(instruction: string): Promise<ActResult> {
    try {
      const stagehand = await this.ensureInitialized();
      await stagehand.act(instruction);
      const url = stagehand.context.pages()[0].url();

      return {
        success: true,
        url,
        action: instruction,
      };
    } catch (error) {
      logger.error('[StagehandAdapter] Error in act():', error instanceof Error ? error.message : String(error));
      throw error; // Re-throw so it's caught by the main execute() error handler
    }
  }

  /**
   * Extract structured data from the page (auto-starts browser if needed)
   * @param instruction - What to extract from the page
   * @param schema - JSON Schema defining the expected output structure (optional - uses default if empty)
   */
  async extract<T>(
    instruction: string,
    schema?: JsonSchema,
  ): Promise<ExtractResult<T>> {
    const stagehand = await this.ensureInitialized();

    // Load Zod module
    const z = await loadZod(this.getResolutionPaths());

    // Convert JSON Schema to Zod schema (uses default if schema is empty/minimal)
    const zodSchema = isEmptySchema(schema)
      ? createDefaultExtractionSchema(z)
      : jsonSchemaToZod(z, schema!);

    // Call Stagehand extract
    const data = await stagehand.extract(instruction, zodSchema);

    return {
      success: true,
      data,
      url: stagehand.context.pages()[0].url(),
    };
  }

  /**
   * Observe possible actions on the page (auto-starts browser if needed)
   * Returns a list of actions with selectors, descriptions, methods, and arguments
   * that can be used to perform actions on the page.
   */
  async observe(instruction: string): Promise<ObserveResult> {
    const stagehand = await this.ensureInitialized();

    // Stagehand observe returns Action[] with selector, description, method?, arguments?
    const actions: StagehandAction[] = await stagehand.observe(instruction);

    // Map Stagehand actions to our ObservableAction format (exclude selector - not useful for LLM)
    const possibleActions: ObservableAction[] = actions.map((action) => ({
      description: action.description || '',
      method: action.method,
      arguments: action.arguments,
    }));

    return {
      success: true,
      url: stagehand.context.pages()[0].url(),
      possibleActions,
    };
  }

  /**
   * Take a screenshot of the current page (auto-starts browser if needed)
   * Supports viewport, fullPage, clip, and element screenshots
   * @see https://docs.stagehand.dev/v3/references/page
   */
  async screenshot(options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    const stagehand = await this.ensureInitialized();
    const page = stagehand.context.pages()[0];

    const imageType = options.type || 'png';

    // Build Playwright-compatible screenshot options
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const playwrightOptions: any = {
      type: imageType,
      fullPage: options.fullPage ?? false,
    };

    // Add optional parameters if provided
    if (options.quality !== undefined && imageType === 'jpeg') {
      playwrightOptions.quality = options.quality;
    }
    if (options.clip) {
      playwrightOptions.clip = options.clip;
      // clip and fullPage are mutually exclusive
      playwrightOptions.fullPage = false;
    }
    if (options.scale) {
      playwrightOptions.scale = options.scale;
    }
    if (options.animations) {
      playwrightOptions.animations = options.animations;
    }
    if (options.caret) {
      playwrightOptions.caret = options.caret;
    }
    if (options.omitBackground) {
      playwrightOptions.omitBackground = options.omitBackground;
    }
    if (options.timeout) {
      playwrightOptions.timeout = options.timeout;
    }
    if (options.style) {
      playwrightOptions.style = options.style;
    }
    if (options.maskColor) {
      playwrightOptions.maskColor = options.maskColor;
    }

    // Handle mask selectors - convert string[] to Locator[]
    if (options.mask && options.mask.length > 0) {
      playwrightOptions.mask = options.mask.map((selector) =>
        page.locator(selector),
      );
    }

    // Determine save path:
    // - If returnBase64 is true, don't save to file
    // - If path is provided, use that
    // - Otherwise, auto-generate in temp dir
    let savePath: string | undefined;
    if (!options.returnBase64) {
      if (options.path) {
        savePath = options.path;
      } else {
        // Auto-generate filename in browser-session/screenshots directory
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const ext = imageType === 'jpeg' ? 'jpg' : 'png';
        const screenshotDir = path.join(process.cwd(), 'browser-session', 'screenshots');
        // Ensure directory exists
        const fs = await import('node:fs');
        if (!fs.existsSync(screenshotDir)) {
          fs.mkdirSync(screenshotDir, { recursive: true });
        }
        savePath = path.join(screenshotDir, `screenshot-${timestamp}.${ext}`);
      }
      playwrightOptions.path = savePath;
    }

    let buffer: Buffer;

    // Element screenshot (using selector) vs page screenshot
    if (options.selector) {
      // Stagehand's locator doesn't have screenshot(), so we:
      // 1. Get element's bounding box via evaluate
      // 2. Use page.screenshot with clip
      const boundingBox = await page.evaluate((selector: string) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x + window.scrollX,
          y: rect.y + window.scrollY,
          width: rect.width,
          height: rect.height,
        };
      }, options.selector);

      if (!boundingBox) {
        throw new Error(`Element not found: ${options.selector}`);
      }

      // Use clip for element screenshot
      playwrightOptions.clip = boundingBox;
      playwrightOptions.fullPage = false;
      buffer = await page.screenshot(playwrightOptions);
    } else {
      buffer = await page.screenshot(playwrightOptions);
    }

    // Build result
    const result: ScreenshotResult = {
      success: true,
      url: page.url(),
      type: imageType,
    };

    if (savePath) {
      result.screenshotPath = savePath;
    } else {
      // returnBase64 was true
      result.base64 = buffer.toString('base64');
    }

    return result;
  }

  /**
   * Execute an autonomous multi-step browser task
   * Uses Stagehand's agent API for intelligent task completion
   *
   * @param instruction - Natural language task description
   * @param maxSteps - Maximum steps before stopping (default: 20)
   * @param signal - Optional AbortSignal for cancellation
   * @param onStep - Callback for live step updates
   * @param sessionId -  Session ID for pause/resume control
   */
  async executeAgentTask(
    instruction: string,
    maxSteps: number = 20,
    signal?: AbortSignal,
    onStep?: (step: AgentStepCallback) => void,
    sessionId?: string,
  ): Promise<AgentTaskResult> {
    try {
      const stagehand = await this.ensureInitialized();

      // Check for pre-abort
      if (signal?.aborted) {
        return {
          success: false,
          message: 'Task was cancelled before execution',
          steps: [],
          completed: false,
        };
      }

      // Create agent with same model configuration as adapter
      // Build the same modelConfig that was used to initialize Stagehand
      const clientOptions: any = {};

      if (this.config.authClient && this.config.project) {
        // OAuth mode
        clientOptions.authClient = this.config.authClient;
        clientOptions.project = this.config.project;
        clientOptions.location = this.config.location || 'us-central1';
      } else if (this.config.project && this.config.apiKey) {
        // Vertex AI mode with API key
        clientOptions.apiKey = this.config.apiKey;
        clientOptions.project = this.config.project;
        clientOptions.location = this.config.location || 'us-central1';
        clientOptions.vertexai = true;
      } else if (this.config.apiKey) {
        // Standard Gemini API with API key
        clientOptions.apiKey = this.config.apiKey;
      }

      let modelName: string = this.config.model;
      if (clientOptions.authClient && this.config.model.startsWith('google/')) {
        modelName = this.config.model.replace('google/', '');
      }

      const modelConfig: any = {
        modelName: modelName,
        ...clientOptions,
      };

      const agent = stagehand.agent({
        model: modelConfig,
      });

      // Create checkPauseState callback for pause/resume control
      const sessionManager = SessionManager.getInstance();
      const checkPauseState = sessionId
        ? async () => {
            const shouldStop = await sessionManager.checkPauseState(sessionId);
            if (shouldStop) {
              throw new Error('Agent stopped by user');
            }
          }
        : undefined;

      // Execute the task with step callback
      // Pass onStep through to Stagehand for live updates
      const result: StagehandAgentResult = await agent.execute({
        instruction,
        maxSteps: maxSteps || 20,
        onStep,
        checkPauseState, // Pass pause checker for step-boundary checks
      });

      // Execution complete - result is returned below

      // Check if user cancelled execution
      // If session is in STOPPING state, treat as successful cancellation
      if (sessionId) {
        const sessionManager = SessionManager.getInstance();
        const sessionState = sessionManager.getSessionState(sessionId);
        if (sessionState === SessionState.STOPPING) {
          logger.debug('[StagehandAdapter] User cancelled execution via STOP button');
          return {
            success: true,
            message: '[Operation Cancelled] Reason: User cancelled the operation.',
            steps: [],
            completed: false,
          };
        }
      }

      // Map Stagehand result to our format
      return this.mapAgentResult(result);
    } catch (error) {
      logger.error('[StagehandAdapter] Error in executeAgentTask:', error);
      logger.error('[StagehandAdapter] Error stack:', error instanceof Error ? error.stack : 'No stack trace');

      // Handle user-initiated stop as successful cancellation
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('stopped by user') || errorMessage.includes('Agent stopped')) {
        return {
          success: true, // Treat stop as successful cancellation, not error
          message: '[Operation Cancelled] Reason: User cancelled the operation.',
          steps: [],
          completed: false,
        };
      }

      return {
        success: false,
        message: errorMessage,
        steps: [],
        completed: false,
      };
    }
  }

  /**
   * Map Stagehand AgentResult to our AgentTaskResult
   */
  private mapAgentResult(result: StagehandAgentResult): AgentTaskResult {
    // Map actions to steps with step numbers
    const steps: AgentStep[] = result.actions.map((action, index) => ({
      stepNumber: index + 1,
      action: action.type || 'unknown',
      reasoning: action.reasoning,
      result: this.formatActionResult(action),
    }));

    return {
      success: result.success,
      message: result.message,
      steps,
      completed: result.completed,
      usage: result.usage
        ? {
            input_tokens: result.usage.input_tokens || 0,
            output_tokens: result.usage.output_tokens || 0,
            inference_time_ms: result.usage.inference_time_ms || 0,
          }
        : undefined,
    };
  }

  /**
   * Format action-specific fields into a readable result string
   */
  private formatActionResult(action: StagehandAgentAction): string {
    const parts: string[] = [];

    if (action.action) {
      parts.push(`Action: ${action.action}`);
    }
    if (action.pageUrl) {
      parts.push(`URL: ${action.pageUrl}`);
    }
    if (action.pageText) {
      // Truncate long page text
      const text =
        action.pageText.length > 200
          ? action.pageText.substring(0, 200) + '...'
          : action.pageText;
      parts.push(`Page: ${text}`);
    }
    if (action.taskCompleted !== undefined) {
      parts.push(`Completed: ${action.taskCompleted}`);
    }

    return parts.join(' | ') || 'completed';
  }

  /**
   * Execute a browser agent action
   * @param onStep - Optional callback for live step updates (agent_task only)
   * @param sessionId - Session ID for pause/resume control (agent_task only)
   */
  async execute(
    params: BrowserAgentParams,
    _signal?: AbortSignal,
    onStep?: (step: AgentStepCallback) => void,
    sessionId?: string,
  ): Promise<BrowserAgentResult> {
    try {
      switch (params.action) {
        case 'start':
          await this.init();
          return {
            success: true,
            action: 'start',
            url: this.stagehand?.context.pages()[0]?.url(),
          };

        case 'navigate':
          if (!params.url) {
            return {
              success: false,
              action: 'navigate',
              error: 'URL is required for navigate action',
            };
          }
          const navResult = await this.navigate(params.url);
          return {
            success: true,
            action: 'navigate',
            url: navResult.url,
          };

        case 'act':
          if (!params.instruction) {
            return {
              success: false,
              action: 'act',
              error: 'Instruction is required for act action',
            };
          }
          const actResult = await this.act(params.instruction);
          return {
            success: true,
            action: 'act',
            url: actResult.url,
          };

        case 'extract':
          if (!params.instruction) {
            return {
              success: false,
              action: 'extract',
              error: 'Instruction is required for extract action',
            };
          }
          // Schema is optional - will use default extraction schema if not provided
          const extractResult = await this.extract(
            params.instruction,
            params.schema,
          );
          return {
            success: true,
            action: 'extract',
            url: extractResult.url,
            data: extractResult.data,
          };

        case 'observe':
          if (!params.instruction) {
            return {
              success: false,
              action: 'observe',
              error: 'Instruction is required for observe action',
            };
          }
          const observeResult = await this.observe(params.instruction);
          return {
            success: true,
            action: 'observe',
            url: observeResult.url,
            data: observeResult.possibleActions,
          };

        case 'screenshot':
          const screenshotResult = await this.screenshot({
            fullPage: params.fullPage,
            clip: params.clip,
            selector: params.selector,
            type: params.type,
            quality: params.quality,
            mask: params.mask,
            maskColor: params.maskColor,
            animations: params.animations,
            omitBackground: params.omitBackground,
            path: params.path,
            returnBase64: params.returnBase64,
          });
          return {
            success: true,
            action: 'screenshot',
            url: screenshotResult.url,
            screenshotPath: screenshotResult.screenshotPath,
            base64: screenshotResult.base64,
            screenshotType: screenshotResult.type,
          };

        case 'stop':
          await this.close();
          return {
            success: true,
            action: 'stop',
          };

        case 'agent_task':
          if (!params.instruction) {
            return {
              success: false,
              action: 'agent_task',
              error: 'Instruction is required for agent_task action',
            };
          }
          // Pass onStep callback for live updates
          // Pass sessionId for pause/resume control
          const agentResult = await this.executeAgentTask(
            params.instruction,
            params.maxSteps || 20,
            _signal,
            onStep,
            sessionId,
          );
          const agentPage = this.stagehand?.context.pages()[0];
          return {
            success: agentResult.success,
            action: 'agent_task',
            url: agentPage?.url(),
            steps: agentResult.steps,
            data: {
              message: agentResult.message,
              completed: agentResult.completed,
              usage: agentResult.usage,
            },
          };

        default:
          return {
            success: false,
            action: params.action,
            error: `Unknown action: ${params.action}`,
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[StagehandAdapter] Error in ${params.action}:`, message);

      return {
        success: false,
        action: params.action,
        error: message,
      };
    }
  }

  /**
   * Close the browser and cleanup
   */
  async close(): Promise<void> {
    if (this.stagehand) {
      await this.stagehand.close();
      this.stagehand = null;
      this.isInitialized = false;
    }
  }
}
