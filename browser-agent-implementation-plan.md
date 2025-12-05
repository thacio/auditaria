# Browser-Agent Tool Implementation Plan

This document provides a comprehensive implementation plan for the browser-agent
tool in Auditaria. This plan is designed to be self-contained so that if context
is lost, work can resume from where it left off.

## Executive Summary

The browser-agent tool enables AI-driven browser automation in Auditaria using
Stagehand. Users can:

- Have the AI perform autonomous web browsing tasks
- See live updates when using the web interface
- Take control of the browser mid-task
- Capture screenshots as proof for audits

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Auditaria CLI/Web                        │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │   AI (Gemini)   │  │   Web Interface │  │    Terminal     │  │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘  │
│           │                    │                    │           │
│           ▼                    ▼                    ▼           │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    BrowserAgentTool                         ││
│  │  (packages/core - minimal integration: 3 lines)             ││
│  └─────────────────────────────────────────────────────────────┘│
└───────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    packages/browser-agent/                      │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │ BrowserAgent    │  │ SessionManager  │  │ CredentialBridge│  │
│  │ Service         │  │                 │  │                 │  │
│  └────────┬────────┘  └─────────────────┘  └─────────────────┘  │
│           │                                                     │
│           ▼                                                     │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                   StagehandAdapter                          ││
│  │  (Abstraction layer - allows swapping providers)            ││
│  └─────────────────────────────────────────────────────────────┘│
└───────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                  @browserbasehq/stagehand                       │
│  (npm package initially, local fork stagehand/ if needed)       │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │ act()           │  │ extract()       │  │ agent()         │  │
│  │ observe()       │  │ screenshot()    │  │ navigate()      │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
└───────────────────────────────────────────────────────────────┘
                                │
                                ▼
                    ┌───────────────────────┐
                    │   Chrome (via CDP)    │
                    └───────────────────────┘
```

## Tool Pattern Reference

The browser-agent tool follows the stock Gemini CLI tool patterns. Reference
these files:

### Simple Tool Pattern: `write-todos.ts`

- **Location**: `packages/core/src/tools/write-todos.ts`
- **Pattern**: No config dependency, simple validation, returns `ToolResult`
- **Key elements**:

  ```typescript
  class WriteTodosToolInvocation extends BaseToolInvocation<Params, ToolResult> {
    getDescription(): string { ... }
    async execute(): Promise<ToolResult> { ... }
  }

  class WriteTodosTool extends BaseDeclarativeTool<Params, ToolResult> {
    static readonly Name = TOOL_NAME;
    constructor() { super(...) }
    validateToolParamValues(params): string | null { ... }
    createInvocation(...): ToolInvocation { ... }
  }
  ```

### Tool with Config: `read-file.ts`

- **Location**: `packages/core/src/tools/read-file.ts`
- **Pattern**: Uses `Config` for file system access and validation
- **Key elements**:
  - Constructor receives `Config`
  - Validates paths are within workspace
  - Uses `config.getFileSystemService()` for file operations
  - Returns structured `ToolResult` with `llmContent` and `returnDisplay`

### Complex Tool Pattern: `edit.ts`

- **Location**: `packages/core/src/tools/edit.ts`
- **Pattern**: Confirmation support, modifiable interface, telemetry
- **Key elements**:
  - `getConfirmationDetails()` for user confirmation
  - `ModifiableDeclarativeTool` interface for editable content
  - Detailed error types via `ToolErrorType`

## Stagehand Capabilities Summary

Based on exploration of `stagehand/` folder:

### Core Methods

| Method                         | Description           | Use Case                  |
| ------------------------------ | --------------------- | ------------------------- |
| `act(instruction)`             | Single atomic action  | Click, type, select       |
| `extract(instruction, schema)` | Get structured data   | Scraping, data extraction |
| `observe(instruction)`         | Plan actions first    | Preview before execution  |
| `agent(config).execute(task)`  | Autonomous multi-step | Complex tasks             |

### Model Support

- Google: `google/gemini-2.0-flash`, `google/gemini-2.5-flash`,
  `google/gemini-2.5-pro`
- OpenAI: `openai/gpt-4.1`, `openai/gpt-4o`
- Anthropic: `anthropic/claude-sonnet-4-5`

### Key Files in Stagehand

- Main class: `stagehand/packages/core/lib/v3/v3.ts`
- Google client: `stagehand/packages/core/lib/v3/llm/GoogleClient.ts`
- Agent handler: `stagehand/packages/core/lib/v3/handlers/v3AgentHandler.ts`
- Examples: `stagehand/packages/core/examples/`

### Authentication

```typescript
const stagehand = new Stagehand({
  model: {
    modelName: 'google/gemini-2.0-flash',
    apiKey: process.env.GEMINI_API_KEY,
  },
  env: 'LOCAL', // Use local Chrome, not Browserbase
});
```

## Open-Operator Patterns (Inspiration)

Based on exploration of `open-operator/` folder:

### Key Patterns to Adopt

1. **Atomic action enforcement** - One action per step prevents hallucination
2. **Step-by-step logging with reasoning** - Transparency for users
3. **Two-phase prompting** - URL selection separate from action generation
4. **Structured output schema** - Zod validation for reliability
5. **Vision-first approach** - Screenshots rather than DOM inspection

### Missing Features We Should Add

1. Pause/resume capability
2. Human-in-the-loop approval
3. Manual override/takeover
4. Session recording

## Browser-Use Patterns (Inspiration)

Based on exploration of `browser-use/` folder (Python):

### Key Patterns to Adopt

1. **Event-driven architecture** - Decouple action dispatch from execution
2. **Structured prompts with sections** - XML-style tags for context
3. **Index-based element targeting** - Simpler than selectors for LLM
4. **Error as context** - Return errors to LLM for better decisions
5. **Todo.md for long tasks** - Persistent task tracking

---

## Phase Implementation Plan

### Phase 1: Basic Extract (MVP)

**Goal**: Prove Stagehand works with Gemini API

**Deliverables**:

```
packages/browser-agent/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   └── stagehand-adapter.ts
└── scripts/
    └── test-extract.ts
```

**Test Script** (`test-extract.ts`):

```typescript
import { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';

const GEMINI_API_KEY = 'key';

async function main() {
  const stagehand = new Stagehand({
    env: 'LOCAL',
    model: {
      modelName: 'google/gemini-2.0-flash',
      apiKey: GEMINI_API_KEY,
    },
  });

  await stagehand.init();
  const page = stagehand.page;

  await page.goto('https://en.wikipedia.org/wiki/TypeScript');

  const data = await stagehand.extract(
    'Extract the first paragraph summary of this Wikipedia article',
    z.object({
      title: z.string(),
      summary: z.string(),
    }),
  );

  console.log('Extracted data:', data);

  await stagehand.close();
}

main().catch(console.error);
```

**Success Criteria**:

- Script runs without errors
- Extracts title and summary from Wikipedia
- Chrome browser opens and closes cleanly

**Dependencies** (`package.json`):

```json
{
  "name": "@thacio/browser-agent",
  "version": "0.1.0",
  "type": "module",
  "dependencies": {
    "@browserbasehq/stagehand": "^3.0.5",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "typescript": "^5.3.3",
    "tsx": "^4.7.0",
    "vitest": "^3.1.1"
  }
}
```

#### Phase 1 Completion Summary ✅

**Status**: COMPLETED (2025-12-01)

**Files Created**:

```
packages/browser-agent/
├── package.json
├── tsconfig.json
├── index.ts
├── src/
│   ├── index.ts
│   ├── types.ts
│   └── stagehand-adapter.ts
└── scripts/
    └── test-extract.ts
```

**Key Accomplishments**:

| Item                              | Status |
| --------------------------------- | ------ |
| Created browser-agent package     | ✅     |
| Installed Stagehand v3.0.5        | ✅     |
| Installed Playwright Chromium     | ✅     |
| Created StagehandAdapter (v3 API) | ✅     |
| Created test script               | ✅     |
| Tested with Wikipedia + Gemini    | ✅     |

**Test Results**:

- Browser launched successfully (headless: false)
- Navigated to Wikipedia TypeScript article
- Extracted title: "TypeScript"
- Extracted summary about TypeScript being a high-level programming language
- Token usage: ~35,700 tokens for extraction
- Browser closed cleanly

**Important v3 API Notes**:

- Import: `import { Stagehand } from '@browserbasehq/stagehand'`
- Page access: `stagehand.context.pages()[0]` (not `stagehand.page`)
- Methods `act`, `extract`, `observe` are on the `stagehand` instance
- Requires `npx playwright install chromium` for browser

---

### Phase 2: Auditaria Tool Integration

**Goal**: Make browser-agent callable by Auditaria AI

**New Files**:

```
packages/browser-agent/src/
├── browser-agent-tool.ts      # Tool class following stock patterns
├── types.ts                   # Type definitions
└── errors.ts                  # Error types
```

**Minimal Changes to Existing Files**:

1. `packages/core/src/tools/tool-names.ts` (add 1 line):

```typescript
// AUDITARIA_FEATURE: Browser agent tool
export const BROWSER_AGENT_TOOL_NAME = 'browser_agent';
```

2. `packages/core/src/config/config.ts` (add 2 lines):

```typescript
// AUDITARIA_FEATURE: Browser agent tool
import { BrowserAgentTool } from '@thacio/browser-agent';

// In createToolRegistry() method:
registerCoreTool(BrowserAgentTool, this); // AUDITARIA_FEATURE: Browser agent
```

**Tool Implementation Pattern** (following `write-todos.ts` + `read-file.ts`):

```typescript
// browser-agent-tool.ts
import type { ToolInvocation, ToolResult } from '@google/gemini-cli-core';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
} from '@google/gemini-cli-core';
import type { MessageBus } from '@google/gemini-cli-core';
import type { Config } from '@google/gemini-cli-core';
import { BROWSER_AGENT_TOOL_NAME } from '@google/gemini-cli-core';
import { StagehandAdapter } from './stagehand-adapter.js';
import type { BrowserAgentParams, BrowserAgentResult } from './types.js';

class BrowserAgentToolInvocation extends BaseToolInvocation<
  BrowserAgentParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: BrowserAgentParams,
    messageBus?: MessageBus,
    toolName?: string,
    displayName?: string,
  ) {
    super(params, messageBus, toolName, displayName);
  }

  getDescription(): string {
    const { action, url, instruction } = this.params;
    switch (action) {
      case 'navigate':
        return `Navigate to ${url}`;
      case 'act':
        return `Browser action: ${instruction?.substring(0, 50)}...`;
      case 'extract':
        return `Extract data: ${instruction?.substring(0, 50)}...`;
      case 'screenshot':
        return 'Take screenshot';
      case 'agent_task':
        return `Browser task: ${instruction?.substring(0, 50)}...`;
      default:
        return `Browser: ${action}`;
    }
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    const adapter = StagehandAdapter.getInstance(this.config);

    try {
      const result = await adapter.execute(this.params, signal);
      return {
        llmContent: this.formatForLLM(result),
        returnDisplay: this.formatForDisplay(result),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Browser agent error: ${message}`,
        returnDisplay: `Error: ${message}`,
        error: { message, type: 'BROWSER_AGENT_ERROR' },
      };
    }
  }

  private formatForLLM(result: BrowserAgentResult): string {
    // Format result for LLM context
  }

  private formatForDisplay(result: BrowserAgentResult): string {
    // Format result for user display
  }
}

export class BrowserAgentTool extends BaseDeclarativeTool<
  BrowserAgentParams,
  ToolResult
> {
  static readonly Name = BROWSER_AGENT_TOOL_NAME;

  constructor(
    private readonly config: Config,
    messageBus?: MessageBus,
  ) {
    super(
      BrowserAgentTool.Name,
      'BrowserAgent',
      BROWSER_AGENT_DESCRIPTION,
      Kind.Fetch,
      BROWSER_AGENT_SCHEMA,
      true,
      false,
      messageBus,
    );
  }

  protected override validateToolParamValues(
    params: BrowserAgentParams,
  ): string | null {
    // Validation logic
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
```

**Test**: Ask Auditaria "go to google.com and tell me the page title"

#### Phase 2 Completion Summary ✅

**Status**: COMPLETED (2025-12-01)

**Files Created/Modified**:

```
packages/browser-agent/src/
├── browser-agent-tool.ts      # NEW - Tool class following stock patterns
├── errors.ts                  # NEW - BrowserAgentError and BrowserAgentErrorType
├── types.ts                   # UPDATED - Added tool parameters + model selection
├── stagehand-adapter.ts       # UPDATED - Dynamic loading with multi-path resolution
└── index.ts                   # UPDATED - Exports tool and errors

packages/core/src/
├── tools/tool-names.ts        # ADDED - BROWSER_AGENT_TOOL_NAME
├── config/config.ts           # ADDED - import and registerCoreTool
└── package.json               # ADDED - @thacio/browser-agent dependency

packages/cli/package.json      # ADDED - @browserbasehq/stagehand, playwright deps
esbuild.config.js              # ADDED - Stagehand/Playwright to external array
```

**Key Accomplishments**:

| Item                                           | Status |
| ---------------------------------------------- | ------ |
| Created BrowserAgentTool class                 | ✅     |
| Created BrowserAgentToolInvocation class       | ✅     |
| Created errors.ts with error types             | ✅     |
| Added BROWSER_AGENT_TOOL_NAME to tool-names.ts | ✅     |
| Registered tool in config.ts                   | ✅     |
| Added @thacio/browser-agent dependency to core | ✅     |
| Build passes successfully                      | ✅     |
| Tool appears in bundle                         | ✅     |
| Fixed worker thread crash on startup           | ✅     |
| Fixed module resolution for global install     | ✅     |

**Tool Features**:

- Actions: `start`, `navigate`, `act`, `extract`, `observe`, `screenshot`,
  `agent_task`, `stop`
- Singleton adapter pattern for session persistence
- Parameter validation for each action type
- Formatted output for LLM context and user display
- Integration with ToolErrorType from core
- Model selection support (gemini-2.0-flash, gemini-2.5-flash, gemini-2.5-pro)

**Critical Bundling Fixes**:

The browser-agent required several fixes to work with the CLI bundling:

1. **Worker Thread Crash**: Stagehand does heavy initialization on import that
   crashes worker threads used by the CLI logger.
   - **Fix**: Dynamic import using `require()` inside `init()` method instead of
     static `import` at top level.

2. **esbuild Bundling**: Even with dynamic import, esbuild still processes and
   bundles the code.
   - **Fix**: Added to `esbuild.config.js` external array:

   ```javascript
   '@browserbasehq/stagehand',
   'playwright',
   'playwright-core',
   ```

3. **Module Resolution**: When marked as external, Node couldn't find the
   package from bundle location.
   - **Fix**: Multi-path resolution using `createRequire()`:

   ```typescript
   private async loadStagehand() {
     const paths = [
       `file://${__dirname}/../package.json`,           // Global install
       `file://${process.cwd()}/packages/cli/package.json`,  // Local CLI
       `file://${process.cwd()}/packages/browser-agent/package.json`, // Local dev
     ];
     for (const basePath of paths) {
       try {
         const require = createRequire(basePath);
         return require('@browserbasehq/stagehand');
       } catch { continue; }
     }
   }
   ```

4. **Global Install Support**: Dependencies need to be in CLI package for
   `npm install -g` to work.
   - **Fix**: Added `@browserbasehq/stagehand` and `playwright` to
     `packages/cli/package.json` dependencies.
   - **Note**: Requires `npm install --legacy-peer-deps` due to dotenv version
     conflict.

**Implementation Notes**:

- Stagehand v3 TypeScript types are restrictive - used `as any` cast for
  constructor options
- Tool uses `GEMINI_API_KEY` environment variable (Phase 3 will add credential
  bridge)
- Browser session persists across tool calls until `stop` action
- Tool registered without Config dependency (uses env var directly)

---

### Phase 3: Credential Bridge

**Goal**: Use Auditaria's authentication for browser-agent

**Challenge Discovered**: Stagehand's `GoogleClient` uses `@google/genai` SDK
which has bugs with OAuth authentication (`authClient` option). Multiple
attempts to use the SDK failed:

- "authHeaders is not iterable"
- "Project/location and API key are mutually exclusive"
- 404 errors with wrong endpoint format

**Solution**: Following Auditaria's proven pattern, created a new
`CodeAssistClient` in Stagehand that bypasses the `@google/genai` SDK entirely
and uses `authClient.request()` directly to call the Code Assist API
(`cloudcode-pa.googleapis.com`).

#### Phase 3 Completion Summary ✅

**Status**: COMPLETED (2025-12-02)

**Key Discovery - Auditaria's Dual Authentication Paths**:

| Auth Mode                 | Auditaria Class    | Endpoint                                 | SDK Used           |
| ------------------------- | ------------------ | ---------------------------------------- | ------------------ |
| OAuth (Login with Google) | `CodeAssistServer` | `cloudcode-pa.googleapis.com/v1internal` | None (direct HTTP) |
| API Key (Gemini/Vertex)   | `GoogleGenAI`      | Standard Gemini API                      | `@google/genai`    |

The Code Assist API endpoint works with OAuth without requiring Vertex AI API to
be enabled on the project.

**Files Created/Modified**:

```
packages/browser-agent/src/
├── credential-bridge.ts       # NEW - Detects auth type and gets credentials
├── browser-agent-tool.ts      # UPDATED - Uses CredentialBridge
├── stagehand-adapter.ts       # UPDATED - Accepts authClient for OAuth mode
├── types.ts                   # UPDATED - Added StagehandConfig with authClient

stagehand/packages/core/lib/v3/
├── llm/CodeAssistClient.ts    # NEW - OAuth-compatible LLM client (~440 lines)
├── llm/LLMProvider.ts         # UPDATED - Routes OAuth to CodeAssistClient
├── types/public/model.ts      # UPDATED - Added GoogleClientOptions interface
├── utils/fileLogger.ts        # NEW - Debug file logger for troubleshooting
├── v3.ts                      # UPDATED - Added debug logging

PLAN.md                        # NEW - Implementation plan documentation
```

**CredentialBridge Class** (`credential-bridge.ts`):

```typescript
export type CredentialMode = 'gemini' | 'vertexai' | 'oauth-vertexai';

export interface BrowserAgentCredentials {
  mode: CredentialMode;
  apiKey?: string; // For gemini/vertexai modes
  authClient?: AuthClient; // For oauth-vertexai mode
  project?: string; // For vertexai/oauth-vertexai modes
  location?: string; // For vertexai/oauth-vertexai modes
}

export class CredentialBridge {
  static async getCredentials(): Promise<BrowserAgentCredentials> {
    // Detects auth type from ContentGeneratorConfig
    // Returns appropriate credentials for each mode:
    // - gemini: apiKey only (standard Gemini API)
    // - vertexai: apiKey + project + location (Vertex AI with API key)
    // - oauth-vertexai: authClient + project + location (OAuth via Code Assist API)
  }
}
```

**CodeAssistClient Class**
(`stagehand/packages/core/lib/v3/llm/CodeAssistClient.ts`):

```typescript
// OAuth-compatible LLM client using Google Code Assist API
const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const CODE_ASSIST_API_VERSION = 'v1internal';

export class CodeAssistClient extends LLMClient {
  public type = 'google-oauth' as const;

  constructor({ logger, modelName, authClient, project }) {
    // Uses authClient from google-auth-library
  }

  private getEndpointUrl(): string {
    return `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:generateContent`;
  }

  async createChatCompletion({ options, logger, retries }): Promise<T> {
    // Request format (wrapped structure like Auditaria's CodeAssistServer):
    // {
    //   model: "gemini-2.0-flash",
    //   project: "dulcet-binder-fqbv1",
    //   user_prompt_id: "stagehand-xxx",
    //   request: { contents: [...], generationConfig: {...} }
    // }

    const response = await this.authClient.request({
      url: this.getEndpointUrl(),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestPayload),
    });

    // Response format (wrapped):
    // { response: { candidates: [...], usageMetadata: {...} }, traceId: "..." }
  }
}
```

**LLMProvider OAuth Detection**
(`stagehand/packages/core/lib/v3/llm/LLMProvider.ts`):

```typescript
case "google":
  // AUDITARIA: Check for OAuth mode (authClient present)
  const googleOpts = clientOptions as GoogleClientOptions | undefined;
  if (googleOpts?.authClient && googleOpts?.project) {
    return new CodeAssistClient({
      logger: this.logger,
      modelName: availableModel,
      authClient: googleOpts.authClient,
      project: googleOpts.project,
      location: googleOpts.location || 'us-central1',
    });
  }
  // Fall back to API key mode with GoogleClient
  return new GoogleClient({ ... });
```

**Authentication Flow Summary**:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      CredentialBridge.getCredentials()                   │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │ Detects authType from ContentGeneratorConfig:                       ││
│  │ • 'oauth-personal' / 'oauth-compute-adc' → oauth-vertexai mode     ││
│  │ • 'gemini-api-key' → gemini mode                                   ││
│  │ • 'vertex-ai-api-key' → vertexai mode                              ││
│  └─────────────────────────────────────────────────────────────────────┘│
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
           ┌─────────────────────────┼─────────────────────────┐
           ▼                         ▼                         ▼
┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
│   OAuth Mode       │  │   Gemini Mode      │  │   Vertex AI Mode   │
│ (oauth-vertexai)   │  │   (gemini)         │  │   (vertexai)       │
├────────────────────┤  ├────────────────────┤  ├────────────────────┤
│ authClient (OAuth) │  │ apiKey             │  │ apiKey             │
│ project            │  │                    │  │ project            │
│ location           │  │                    │  │ location           │
└─────────┬──────────┘  └─────────┬──────────┘  └─────────┬──────────┘
          │                       │                       │
          ▼                       ▼                       ▼
┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
│ CodeAssistClient   │  │ AISdkClient        │  │ GoogleClient       │
│ (Stagehand fork)   │  │ (AI SDK)           │  │ (@google/genai)    │
├────────────────────┤  ├────────────────────┤  ├────────────────────┤
│ cloudcode-pa.      │  │ Standard           │  │ Vertex AI          │
│ googleapis.com     │  │ Gemini API         │  │ Endpoint           │
└────────────────────┘  └────────────────────┘  └────────────────────┘
```

**Debug File Logger** (`stagehand/packages/core/lib/v3/utils/fileLogger.ts`):

```typescript
// Log file: %TEMP%/stagehand-debug.log (Windows) or /tmp/stagehand-debug.log
export function debugLog(
  category: string,
  message: string,
  data?: Record<string, unknown>,
): void;
export function debugError(
  category: string,
  error: unknown,
  context?: string,
): void;
export function clearLog(): void;
export function getLogFilePath(): string;
```

**Test Results**:

| Auth Mode                 | Test               | Result     |
| ------------------------- | ------------------ | ---------- |
| OAuth (Login with Google) | Navigate + Extract | ✅ Working |
| API Key (Gemini)          | Navigate + Extract | ✅ Working |

**OAuth Test Log**:

```
[CodeAssistClient] Making authClient.request()... | {"endpoint":"https://cloudcode-pa.googleapis.com/v1internal:generateContent"}
[CodeAssistClient] Request completed | {"status":200}
[adapter:extract] stagehand.extract() completed successfully
```

**API Key Test Log**:

```
[CredentialBridge] authType: gemini-api-key
[CredentialBridge] Using USE_GEMINI path
[BrowserAgentTool] Got credentials, mode: gemini
[adapter:extract] stagehand.extract() completed successfully
```

**Key Implementation Notes**:

1. **Model Name Handling**: For OAuth mode, the adapter converts
   `google/gemini-2.0-flash` to `gemini-2.0-flash` (without prefix) to bypass AI
   SDK and use our `CodeAssistClient`.

2. **Code Assist API Format**: The request/response format differs from standard
   Vertex AI:
   - Request: Wrapped in `{ model, project, user_prompt_id, request: {...} }`
   - Response: Wrapped in `{ response: {...}, traceId }`

3. **No Vertex AI API Required**: The Code Assist API works with OAuth without
   needing Vertex AI API enabled on the project.

4. **Stagehand Fork Required**: The OAuth support requires changes to
   Stagehand's `LLMProvider.ts` and the new `CodeAssistClient.ts`. After
   building Stagehand, copy `dist/index.js` to
   `node_modules/@browserbasehq/stagehand/dist/`.

**Build Commands**:

```bash
# Build Stagehand fork
cd stagehand/packages/core
npx tsup --entry.index lib/v3/index.ts

# Copy to node_modules
cp dist/index.js ../../node_modules/@browserbasehq/stagehand/dist/index.js

# Build Auditaria
cd ../..
npm run build
```

---

### Phase 4: Screenshot Capture ✅

**Goal**: Enable visual proofs for audits with multiple capture modes

**Status**: COMPLETED (2025-12-02)

**Features Implemented**:

| Mode | Usage | Description |
|------|-------|-------------|
| Viewport | `{ action: "screenshot" }` | Capture visible area (default) |
| Full Page | `{ fullPage: true }` | Entire scrollable page |
| Clip | `{ clip: {x,y,width,height} }` | Specific region |
| Element | `{ selector: "#id" }` | Specific element via bounding box |
| Mask | `{ mask: [".secret"] }` | Hide sensitive elements |
| JPEG | `{ type: "jpeg", quality: 80 }` | JPEG with quality control |
| Base64 | `{ returnBase64: true }` | Return inline for web interface |

**Screenshot Options** (Stagehand/Playwright nomenclature):

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `fullPage` | boolean | `false` | Capture entire scrollable page |
| `clip` | `{x,y,width,height}` | - | Capture specific region |
| `selector` | string | - | CSS/XPath for element screenshot |
| `type` | `'png'\|'jpeg'` | `'png'` | Image format |
| `quality` | number | - | JPEG quality 0-100 |
| `mask` | string[] | - | Selectors to hide with overlay |
| `maskColor` | string | `#FF00FF` | Mask overlay color |
| `animations` | `'allow'\|'disabled'` | `'allow'` | Freeze animations |
| `omitBackground` | boolean | `false` | Transparent background (PNG) |
| `path` | string | auto | Custom save path |
| `returnBase64` | boolean | `false` | Return base64 instead of file |

**Default Save Location**: `./browser-session/screenshots/screenshot-<timestamp>.png`

**Files Changed**:

1. `packages/browser-agent/src/types.ts`:
   - Added `ScreenshotClip` interface
   - Updated `ScreenshotOptions` with all Stagehand options + `returnBase64`
   - Updated `ScreenshotResult` with base64 support
   - Updated `BrowserAgentParams` with screenshot options

2. `packages/browser-agent/src/stagehand-adapter.ts`:
   - Enhanced `screenshot()` method with all modes
   - Element screenshot via `getBoundingClientRect()` + clip (Stagehand locator
     doesn't have screenshot method)
   - Auto-generates path in `browser-session/screenshots/` by default
   - `returnBase64: true` returns base64 for web interface

3. `packages/browser-agent/src/browser-agent-tool.ts`:
   - Updated schema with all screenshot parameters
   - Updated formatForLLM/formatForDisplay for base64

4. Test scripts created:
   - `scripts/test-screenshot-modes.ts` - Tests all Stagehand screenshot options
   - `scripts/test-screenshot-adapter.ts` - Tests StagehandAdapter integration

**Key Improvements**:
- Default is viewport-only (not full page), solving "huge screenshot" problem
- Auto-saves to `browser-session/screenshots/` with timestamp filename
- LLM gets the file path to reference the screenshot
- `returnBase64: true` option for web interface use cases

---

### Phase 5: Session Management

**Goal**: Efficient browser lifecycle

**New File**: `packages/browser-agent/src/session-manager.ts`

```typescript
export class SessionManager {
  private static instance: SessionManager;
  private stagehand: Stagehand | null = null;
  private isInitializing = false;

  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  async getOrCreateSession(config: SessionConfig): Promise<Stagehand> {
    if (this.stagehand) {
      return this.stagehand;
    }

    if (this.isInitializing) {
      // Wait for existing initialization
      await this.waitForInit();
      return this.stagehand!;
    }

    this.isInitializing = true;
    try {
      this.stagehand = new Stagehand({
        env: 'LOCAL',
        model: {
          modelName: config.model,
          apiKey: config.apiKey,
        },
      });
      await this.stagehand.init();
      return this.stagehand;
    } finally {
      this.isInitializing = false;
    }
  }

  async closeSession(): Promise<void> {
    if (this.stagehand) {
      await this.stagehand.close();
      this.stagehand = null;
    }
  }

  // Register cleanup on process exit
  registerCleanupHooks(): void {
    process.on('exit', () => this.closeSession());
    process.on('SIGINT', () => this.closeSession());
    process.on('SIGTERM', () => this.closeSession());
  }
}
```

---

### Phase 6: Autonomous Agent Tasks ✅

**Goal**: Multi-step autonomous browsing

**Status**: COMPLETED (2025-12-02)

**Files Modified**:
- `packages/browser-agent/src/types.ts` - Added `AgentTaskResult` interface
- `packages/browser-agent/src/stagehand-adapter.ts` - Added `executeAgentTask()`, `mapAgentResult()`, `formatActionResult()` methods
- `packages/browser-agent/src/index.ts` - Export `AgentTaskResult`
- `packages/browser-agent/scripts/test-agent-task.ts` - New test script

**Implementation Summary**:

The `agent_task` action uses Stagehand's built-in agent API for autonomous multi-step task execution:

```typescript
// Create agent with adapter's model config
const agent = stagehand.agent({ model: this.config.model });

// Execute task with max steps limit
const result = await agent.execute({
  instruction,
  maxSteps: maxSteps || 20,
});

// Map Stagehand AgentResult to our AgentTaskResult
return this.mapAgentResult(result);
```

**Key Features**:
- Uses Stagehand's tool-based agent (act, ariaTree, extract, goto, etc.)
- Maps `AgentAction[]` from Stagehand to our `AgentStep[]` format
- Captures step reasoning and results
- Reports token usage when available
- Pre-abort signal check for cancellation support

**AgentTaskResult Format**:
```typescript
interface AgentTaskResult {
  success: boolean;
  message?: string;
  steps: AgentStep[];  // stepNumber, action, reasoning, result
  completed: boolean;
  usage?: { input_tokens, output_tokens, inference_time_ms };
}
```

**Example Usage**:

```
User: "Go to Wikipedia and find when TypeScript was first released"

AI calls browser_agent with:
{
  action: "agent_task",
  instruction: "Search for TypeScript and tell me when it was first released",
  maxSteps: 10
}
```

**OAuth Compatibility**: Works with both OAuth and API key authentication via the same CodeAssistClient used by other operations.

---

### Phase 6.5: Error Handling

**Goal**: Robust error handling for production use

**New File**: `packages/browser-agent/src/errors.ts`

```typescript
export enum BrowserAgentErrorType {
  BROWSER_NOT_AVAILABLE = 'BROWSER_NOT_AVAILABLE',
  NAVIGATION_FAILED = 'NAVIGATION_FAILED',
  ELEMENT_NOT_FOUND = 'ELEMENT_NOT_FOUND',
  ACTION_TIMEOUT = 'ACTION_TIMEOUT',
  EXTRACTION_FAILED = 'EXTRACTION_FAILED',
  AGENT_STUCK = 'AGENT_STUCK',
  SCREENSHOT_FAILED = 'SCREENSHOT_FAILED',
  CONNECTION_LOST = 'CONNECTION_LOST',
}

export class BrowserAgentError extends Error {
  constructor(
    message: string,
    public readonly type: BrowserAgentErrorType,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BrowserAgentError';
  }

  toLLMContext(): string {
    // Format error for LLM to understand and potentially retry
    return `Browser agent error (${this.type}): ${this.message}. ${
      this.context ? `Context: ${JSON.stringify(this.context)}` : ''
    }`;
  }
}
```

**Error Handling in Adapter**:

```typescript
try {
  await this.stagehand.act(instruction);
} catch (error) {
  if (error.message.includes('element not found')) {
    throw new BrowserAgentError(
      `Could not find element matching: "${instruction}"`,
      BrowserAgentErrorType.ELEMENT_NOT_FOUND,
      { instruction, url: await this.page.url() },
    );
  }
  // ... handle other error types
}
```

---

### Phase 7: Web Interface Live View (Basic) ✅

**Goal**: Show browser agent step-by-step progress INLINE within the tool card

**Status**: COMPLETED (2025-12-02)

**Actual Implementation** (differs from original plan - uses updateOutput instead of WebSocket):

**Files Created**:
- `docs/phase-7-implementation-plan.md` - Implementation plan
- `packages/cli/src/ui/components/messages/BrowserStepDisplay.tsx` - CLI display component

**Files Modified**:
- `packages/browser-agent/src/types.ts` - `BrowserStepDisplay`, `BrowserStepInfo`, `AgentStepCallback`
- `packages/browser-agent/src/browser-agent-tool.ts` - Step callback, `updateOutput` usage
- `packages/browser-agent/src/stagehand-adapter.ts` - `onStep` parameter passthrough
- `packages/cli/src/ui/components/messages/ToolResultDisplay.tsx` - Browser step detection
- `packages/web-client/src/components/ToolRenderer.js` - Browser steps rendering
- `packages/web-client/src/style.css` - Browser step styles

**Stagehand Fork Changes**:
- `stagehand/packages/core/lib/v3/types/public/agent.ts` - `AgentStepUpdate`, `onStep` option
- `stagehand/packages/core/lib/v3/handlers/v3AgentHandler.ts` - `createStepHandler()` with `onStep` callback

See **Phase 7 Completion Summary** below for full details.

---

### Phase 8: User Control (Pause/Resume/Stop)

**Goal**: Users can control browser-agent execution

**State Machine**:

```typescript
enum BrowserAgentState {
  IDLE = 'idle',
  RUNNING = 'running',
  PAUSED = 'paused',
  STOPPING = 'stopping',
}

class BrowserAgentController {
  private state = BrowserAgentState.IDLE;
  private abortController: AbortController | null = null;
  private pausePromise: Promise<void> | null = null;
  private pauseResolver: (() => void) | null = null;

  pause(): void {
    if (this.state === BrowserAgentState.RUNNING) {
      this.state = BrowserAgentState.PAUSED;
      this.pausePromise = new Promise((resolve) => {
        this.pauseResolver = resolve;
      });
    }
  }

  resume(): void {
    if (this.state === BrowserAgentState.PAUSED) {
      this.state = BrowserAgentState.RUNNING;
      this.pauseResolver?.();
    }
  }

  stop(): void {
    this.state = BrowserAgentState.STOPPING;
    this.abortController?.abort();
  }

  async checkPause(): Promise<void> {
    if (this.pausePromise) {
      await this.pausePromise;
      this.pausePromise = null;
    }
  }
}
```

**Status**: COMPLETED (2025-12-03)

**Approach**: Extended SessionManager with execution states, Promise-based pause blocking, WebSocket control channel

**Commits**:
- Root: `29d80c36e` - "phase 8 - completed"
- Stagehand: `8a4cf5e` - "pausestop"

**Detailed Plan**: See `docs/phase-8-pause-resume-plan.md`

**Files Created**:

```
docs/
└── phase-8-pause-resume-plan.md    # Comprehensive implementation plan (859 lines)

packages/web-client/src/components/
├── BrowserAgentControls.css        # Control panel styles
├── BrowserAgentControls.js         # Pause/Resume/Stop UI component
└── agentControlsFactory.js         # Factory for control button creation
```

**Files Modified**:

| File | Changes | Description |
|------|---------|-------------|
| `packages/browser-agent/src/session-manager.ts` | +139 lines | Extended SessionState enum, added pause control methods |
| `packages/browser-agent/src/stagehand-adapter.ts` | +51 lines | Pass checkPauseState callback to Stagehand |
| `packages/browser-agent/src/browser-agent-tool.ts` | +62 lines | Track execution state, handle user cancellation |
| `packages/browser-agent/src/types.ts` | +5 lines | Added execution control fields to SessionEntry |
| `packages/cli/src/services/WebInterfaceService.ts` | +82 lines | WebSocket control channel `/control/agent/:sessionId` |
| `packages/web-client/src/components/BrowserStreamViewer.js` | +19 lines | Integration with control panel |
| `packages/web-client/src/components/ToolRenderer.js` | +29 lines | Render controls for agent_task |
| `stagehand/packages/core/lib/v3/handlers/v3AgentHandler.ts` | Modified | Added checkPauseState callback support in both OAuth and AI SDK paths |
| `stagehand/packages/core/lib/v3/types/public/agent.ts` | Modified | Added `checkPauseState?: () => Promise<void>` to AgentExecuteOptions |

**Key Features Implemented**:

1. **Extended SessionState Enum**:
   ```typescript
   export enum SessionState {
     IDLE = 'idle',
     INITIALIZING = 'initializing',
     READY = 'ready',
     RUNNING = 'running',        // NEW: Agent task executing
     PAUSED = 'paused',          // NEW: Paused between steps
     STOPPING = 'stopping',      // NEW: Stop requested
     CLOSING = 'closing',
     ERROR = 'error',
   }
   ```

2. **SessionManager Control Methods**:
   - `pauseExecution(sessionId)` - Pauses agent at next step boundary
   - `resumeExecution(sessionId)` - Resumes execution
   - `stopExecution(sessionId)` - Stops execution gracefully
   - `checkPauseState(sessionId)` - Promise-based blocking for pause
   - `setRunning(sessionId, abortController)` - Mark as running
   - `setReady(sessionId)` - Mark as ready (cleanup)

3. **Pause Implementation Strategy**:
   - **OAuth Path** (manual loop): Promise-based blocking at top of loop
   - **AI SDK Path** (generateText): AbortController to stop, then restart
   - Both preserve state between pause/resume
   - Pauses only at step boundaries (never mid-step)

4. **WebSocket Control Channel**:
   - Route: `/control/agent/:sessionId`
   - Control messages: `pause`, `resume`, `stop`, `get_state`
   - Server messages: `state`, `error`
   - State updates sent on actions

5. **Web Client Controls** (`BrowserAgentControls.js`):
   - Pause/Resume/Stop buttons
   - Real-time state indicator
   - Buttons enabled/disabled based on state
   - WebSocket connection management

6. **Stagehand Integration**:
   - Added `checkPauseState?: () => Promise<void>` parameter to `AgentExecuteOptions`
   - OAuth path: Called at top of loop before LLM call
   - AI SDK path: Called in `onStepFinish` callback
   - Both throw error on stop to exit cleanly

**Control State Machine**:

```
IDLE → RUNNING (on agent_task start)
RUNNING → PAUSED (pause button)
PAUSED → RUNNING (resume button)
RUNNING → STOPPING (stop button)
PAUSED → STOPPING (stop button)
STOPPING → READY (cleanup complete)
RUNNING → READY (task complete)
```

**WebSocket Message Flow**:

```
Client → Server:
{ action: 'pause' }    → Pause at next step boundary
{ action: 'resume' }   → Resume from paused state
{ action: 'stop' }     → Stop execution gracefully
{ action: 'get_state' } → Query current state

Server → Client:
{ type: 'state', state: 'running|paused|stopping', sessionId }
{ type: 'error', message: 'error details' }
```

**Test Results**:

| Feature | OAuth Mode | API Key Mode | Status |
|---------|------------|--------------|--------|
| Pause between steps | ✅ Working | ✅ Working | Complete |
| Resume execution | ✅ Working | ✅ Working | Complete |
| Stop from running | ✅ Working | ✅ Working | Complete |
| Stop from paused | ✅ Working | ✅ Working | Complete |
| Multiple sessions | ✅ Working | ✅ Working | Complete |
| WebSocket control | ✅ Working | ✅ Working | Complete |
| UI state updates | ✅ Working | ✅ Working | Complete |

**Architecture**:

```
┌─────────────────────────────────────────────────────────────┐
│                   Web Interface Client                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │      BrowserAgentControls.js (React)                 │   │
│  │  [⏸ Pause] [▶ Resume] [⏹ Stop]  Status: running    │   │
│  └───────────────────────┬──────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────┘
                             │ WebSocket
                             │ /control/agent/:sessionId
┌────────────────────────────▼────────────────────────────────┐
│                WebInterfaceService.ts                        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  handleAgentControlConnection()                      │   │
│  │  • Route control messages                            │   │
│  │  • Call SessionManager methods                       │   │
│  │  • Send state updates                                │   │
│  └───────────────────────┬──────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│              SessionManager (Singleton)                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  State: IDLE / RUNNING / PAUSED / STOPPING          │   │
│  │  • pauseExecution() - Set pausePromise              │   │
│  │  • resumeExecution() - Resolve pausePromise         │   │
│  │  • stopExecution() - Abort + resolve pause          │   │
│  │  • checkPauseState() - Await pausePromise           │   │
│  └───────────────────────┬──────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│              BrowserAgentTool                                │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  • setRunning() before agent_task                   │   │
│  │  • Pass sessionId to adapter                         │   │
│  │  • setReady() on completion                          │   │
│  │  • Handle stop errors gracefully                     │   │
│  └───────────────────────┬──────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│            StagehandAdapter                                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  executeAgentTask(sessionId)                         │   │
│  │  • Create checkPauseState callback                   │   │
│  │  • Pass to agent.execute()                           │   │
│  └───────────────────────┬──────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│       Stagehand V3AgentHandler (Fork)                        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  OAuth Path (executeWithCodeAssist):                │   │
│  │    for (step < maxSteps) {                           │   │
│  │      await checkPauseState(); // BLOCKS HERE        │   │
│  │      ... LLM call and tools ...                      │   │
│  │    }                                                  │   │
│  │                                                       │   │
│  │  AI SDK Path (generateText):                        │   │
│  │    onStepFinish: async () => {                      │   │
│  │      await checkPauseState(); // THROWS ON STOP     │   │
│  │      ... step processing ...                         │   │
│  │    }                                                  │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**Key Implementation Notes**:

1. **Safe Pause Points**: Only pauses between steps, never during a step
2. **State Preservation**: All agent state (actions, reasoning, conversation) preserved
3. **Promise-Based Blocking**: `checkPauseState()` returns Promise that blocks until resumed
4. **Session-Level Control**: Each session has independent pause/resume/stop state
5. **AbortController Integration**: Stop uses AbortController for clean cancellation
6. **User Cancellation Message**: Stopped tasks return `[Operation Cancelled] Reason: User cancelled the operation.`
7. **Stagehand Fork Required**: Changes to `v3AgentHandler.ts` and `agent.ts` types

**Stagehand Build Commands**:

```bash
# Build Stagehand fork
cd stagehand/packages/core
npx tsup lib/v3/index.ts --format cjs --outDir dist --no-dts

# Copy to node_modules
cp dist/index.js ../../node_modules/@browserbasehq/stagehand/dist/index.js

# Build and install Auditaria
cd ../..
npm run build && npm run bundle && npm install -g .
```

  Key Learning

  When copying rebuilt Stagehand, make sure to copy to C:/projects/auditaria/node_modules/@browserbasehq/stagehand/dist/index.js (where test scripts load from), not the
  stagehand subdirectory's node_modules.

---

### Phase 9: Browser Streaming (Real-Time Video) ✅

**Goal**: Stream live browser view to web interface

**Status**: COMPLETED (2025-12-03)

**Approach**: Chrome DevTools Protocol (CDP) screencast for real-time JPEG frames

**Commit**: `3dac1ca` - "phase 9 completed - streaming browser"

**Files Created**:

```
packages/browser-agent/src/streaming/
├── types.ts                    # Stream types, quality presets, message types
├── stream-provider.ts          # Abstract base class for stream providers
├── cdp-stream-provider.ts      # CDP screencast implementation
├── stream-manager.ts           # Manages streaming sessions and clients
└── index.ts                    # Exports

packages/web-client/src/components/
└── BrowserStreamViewer.js      # React component for viewing browser streams
```

**Files Modified**:

| File | Changes |
|------|---------|
| `packages/browser-agent/src/index.ts` | Export all streaming components |
| `packages/browser-agent/src/session-manager.ts` | Added `getPage()` method for streaming |
| `packages/browser-agent/package.json` | Added playwright peer dependency |
| `packages/cli/src/services/WebInterfaceService.ts` | WebSocket routing, stream handlers, cleanup |
| `packages/web-client/src/components/ToolRenderer.js` | Browser stream viewer integration |
| `packages/web-client/src/style.css` | Stream viewer styles |

**Key Features Implemented**:

1. **CDP Screencast Streaming**:
   - Uses `Page.startScreencast` for real-time JPEG frames
   - Configurable quality presets (low/medium/high)
   - FPS control via `everyNthFrame` parameter
   - Automatic frame acknowledgment

2. **Quality Presets**:
   ```typescript
   const StreamQualityPresets = {
     low: { fps: 5, quality: 50, maxWidth: 640, maxHeight: 360 },
     medium: { fps: 15, quality: 70, maxWidth: 1280, maxHeight: 720 },
     high: { fps: 30, quality: 85, maxWidth: 1920, maxHeight: 1080 },
   };
   ```

3. **Stream Manager**:
   - Singleton pattern for managing streams
   - One provider per browser session
   - Multiple clients can watch the same session
   - Lazy start: streaming starts when first client connects
   - Auto stop: streaming stops when last client disconnects
   - Page resolver integration with SessionManager

4. **WebSocket Communication**:
   - Route: `/stream/browser/:sessionId`
   - Control messages: `start`, `stop`, `set_quality`, `get_status`, `ping`
   - Server messages: `frame`, `status`, `error`, `started`, `stopped`, `connected`, `pong`
   - Base64 JPEG frames sent as JSON messages

5. **Web Client Viewer** (`BrowserStreamViewer.js`):
   - Canvas-based rendering with smooth frame updates
   - Quality selector (low/medium/high)
   - FPS counter
   - Connection state indicator
   - Auto-fit to container with aspect ratio preservation
   - Error handling and reconnection

**Architecture**:

```
┌─────────────────────────────────────────────────────────────┐
│                   Web Interface Client                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │         BrowserStreamViewer.js (React)               │   │
│  │  Canvas + Quality Selector + FPS Counter             │   │
│  └───────────────────────┬──────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────┘
                             │ WebSocket
                             │ /stream/browser/:sessionId
┌────────────────────────────▼────────────────────────────────┐
│                WebInterfaceService.ts                        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  handleBrowserStreamConnection()                     │   │
│  │  • Route WebSocket connections                       │   │
│  │  • Handle control messages                           │   │
│  │  • Send frames to clients                            │   │
│  └───────────────────────┬──────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│              StreamManager (Singleton)                       │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  • subscribe(sessionId, clientId, callback, quality) │   │
│  │  • unsubscribe(sessionId, clientId)                  │   │
│  │  • Lazy start/stop based on client count            │   │
│  │  • Broadcast frames to all clients                   │   │
│  └───────────────────────┬──────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│          CDPStreamProvider (per session)                     │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  • start(page) - Start Page.startScreencast          │   │
│  │  • stop() - Stop Page.stopScreencast                 │   │
│  │  • setQuality(quality) - Update quality settings     │   │
│  │  • handleFrame() - Process and emit frames           │   │
│  └───────────────────────┬──────────────────────────────┘   │
└────────────────────────────┬────────────────────────────────┘
                             │ CDP
┌────────────────────────────▼────────────────────────────────┐
│              Stagehand Page (CDP Session)                    │
│  • sendCDP('Page.startScreencast', {...})                   │
│  • sendCDP('Page.stopScreencast')                           │
│  • sendCDP('Page.screencastFrameAck', {...})                │
│  • Listen for 'Page.screencastFrame' events                 │
└─────────────────────────────────────────────────────────────┘
```

**Usage Flow**:

1. User opens web interface
2. Browser agent starts a session
3. Web client connects via WebSocket to `/stream/browser/default`
4. StreamManager subscribes client and starts CDPStreamProvider
5. CDPStreamProvider calls `Page.startScreencast`
6. Chrome sends screencast frames via CDP
7. CDPStreamProvider emits frames
8. StreamManager broadcasts frames to all connected clients
9. Web client receives frames and renders on canvas
10. When last client disconnects, streaming stops automatically

**Test Results**:

| Feature | Status |
|---------|--------|
| CDP screencast initialization | ✅ Working |
| Frame capture at configurable FPS | ✅ Working |
| Quality presets (low/medium/high) | ✅ Working |
| WebSocket frame streaming | ✅ Working |
| Multiple client support | ✅ Working |
| Lazy start/stop | ✅ Working |
| Quality switching | ✅ Working |
| FPS counter | ✅ Working |
| Canvas rendering | ✅ Working |

**Key Implementation Details**:

1. **Page Resolver Pattern**:
   ```typescript
   streamManager.setPageResolver(async (sessionId: string) => {
     const sessionManager = SessionManager.getInstance();
     return sessionManager.getPage(sessionId);
   });
   ```

2. **Frame Format**:
   ```typescript
   interface StreamFrame {
     data: string;        // Base64 JPEG (without data URL prefix)
     timestamp: number;   // Frame timestamp
     width: number;       // Frame dimensions
     height: number;
     sessionId: string;   // Session identifier
   }
   ```

3. **Retry Logic**: StreamManager retries up to 10 times (500ms delay) waiting for page to be ready before starting stream

4. **Cleanup**: Proper cleanup on disconnect, stream stop, and service shutdown

**Limitations**:

- Video only (no audio support via CDP screencast)
- JPEG compression (no lossless option)
- Maximum 30 FPS (CDP limitation)
- Chrome only (CDP protocol)

**Future Enhancements** (Phase 9.5 - Optional):

- WebRTC provider for audio support
- Recording to video file (MP4/WebM)
- Screenshot capture from stream
- Pip (Picture-in-Picture) mode

---

### Phase 10: Human-in-the-Loop Takeover ✅

**Goal**: Users can intervene during agent tasks by taking manual control of the browser

**Status**: COMPLETED (2025-12-04)

**Commit**: `52998a2` - "phase 10 progress"

**Key Features Implemented**:

1. **Takeover/Handback Flow**:
   - Browser starts in headed mode but **minimized** (hidden from user)
   - User clicks "Take Over" → browser window shows and comes to front
   - User interacts with browser manually while agent is paused
   - User clicks "End Takeover" → browser minimizes, agent resumes automatically

2. **Hybrid Streaming** (works even when minimized):
   - **Headless/Visible**: Uses `Page.startScreencast` (efficient, real-time)
   - **Headed+Minimized**: Uses `Page.captureScreenshot` polling at 2 FPS
   - Auto-detects window state and switches modes automatically

3. **Windows DPI Detection**:
   - Reads DPI from Windows Registry (`LogPixels` or `AppliedDPI`)
   - Converts to scale factor: `scaleFactor = DPI / 96`
   - Ensures proper viewport rendering without tiny fonts

**Files Created/Modified**:

| File | Changes |
|------|---------|
| `packages/browser-agent/src/session-manager.ts` | +153 lines - Added `TAKING_OVER`, `TAKEN_OVER`, `ENDING_TAKEOVER` states, `takeOverSession()`, `endTakeOver()` methods |
| `packages/browser-agent/src/stagehand-adapter.ts` | +203 lines - Added `showWindow()`, `minimizeWindow()`, `getWindowsScaleFactor()`, Chrome flags for anti-backgrounding |
| `packages/browser-agent/src/streaming/cdp-stream-provider.ts` | +236 lines - Hybrid streaming with screencast + screenshot polling, window state monitoring |
| `packages/browser-agent/src/streaming/types.ts` | Increased maxWidth/maxHeight to 4096x2160 |
| `packages/cli/src/services/WebInterfaceService.ts` | +66 lines - WebSocket handlers for `takeover` and `end_takeover` messages |
| `packages/web-client/src/components/BrowserAgentControls.js` | +77 lines - Take Over and End Takeover buttons, state-specific hints |
| `packages/web-client/src/components/BrowserAgentControls.css` | +88 lines - Takeover button styles, status badges |
| `packages/web-client/src/components/agentControlsFactory.js` | +47 lines - Factory updates for takeover controls |

**New Session States**:

```typescript
export enum SessionState {
  // ... existing states ...
  TAKING_OVER = 'taking_over',      // Transitioning to visible mode
  TAKEN_OVER = 'taken_over',        // User has manual control
  ENDING_TAKEOVER = 'ending_takeover', // Transitioning back to minimized
}
```

**StagehandAdapter Window Control Methods**:

```typescript
// Show browser window and bring to front
async showWindow(): Promise<void> {
  const { windowId } = await page.sendCDP('Browser.getWindowForTarget');
  await page.sendCDP('Browser.setWindowBounds', {
    windowId,
    bounds: { windowState: 'normal' }
  });
  await page.sendCDP('Page.bringToFront');
}

// Minimize browser window
async minimizeWindow(): Promise<void> {
  const { windowId } = await page.sendCDP('Browser.getWindowForTarget');
  await page.sendCDP('Browser.setWindowBounds', {
    windowId,
    bounds: { windowState: 'minimized' }
  });
}
```

**Chrome Launch Flags** (prevent backgrounding when minimized):

```typescript
args: [
  '--start-minimized',                         // Start browser minimized
  '--disable-backgrounding-occluded-windows',  // Keep rendering when covered
  '--disable-renderer-backgrounding',          // Prevent renderer throttling
  '--disable-background-timer-throttling',     // Prevent timer throttling
  '--disable-ipc-flooding-protection',         // Allow high-frequency IPC
],
```

**Windows DPI Detection**:

```typescript
private async getWindowsScaleFactor(): Promise<number | undefined> {
  if (process.platform !== 'win32') return undefined;

  const result = execSync(
    'reg query "HKEY_CURRENT_USER\\Control Panel\\Desktop" /v LogPixels 2>nul || ' +
    'reg query "HKEY_CURRENT_USER\\Control Panel\\Desktop\\WindowMetrics" /v AppliedDPI 2>nul',
    { encoding: 'utf8', timeout: 5000 },
  );

  const match = result.match(/REG_DWORD\s+0x([0-9a-fA-F]+)/);
  if (match) {
    const dpi = parseInt(match[1], 16);
    return dpi / 96; // 96 DPI = 100% = 1.0
  }
  return undefined;
}
```

**Hybrid Streaming Architecture**:

```
┌─────────────────────────────────────────────────────────────┐
│                   CDPStreamProvider                          │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  detectHeadlessMode()                                │   │
│  │  • Try Browser.getWindowForTarget                   │   │
│  │  • If success: headed mode                           │   │
│  │  • If fail: headless mode                            │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─────────────────┐        ┌─────────────────┐             │
│  │  Screencast     │        │  Screenshot     │             │
│  │  (Visible)      │   OR   │  (Minimized)    │             │
│  ├─────────────────┤        ├─────────────────┤             │
│  │ startScreencast │        │ captureScreenshot│             │
│  │ Real-time JPEG  │        │ Polling at 2 FPS │             │
│  │ CDP events      │        │ Timer-based      │             │
│  └─────────────────┘        └─────────────────┘             │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Window State Monitor (every 2 seconds)              │   │
│  │  • Check Browser.getWindowBounds                     │   │
│  │  • If minimized: switch to screenshot mode           │   │
│  │  • If normal: switch to screencast mode              │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

**WebSocket Control Messages**:

```
Client → Server:
{ action: 'takeover' }      → Show browser, bring to front
{ action: 'end_takeover' }  → Minimize browser, resume agent

Server → Client:
{ type: 'state', state: 'taking_over', sessionId }
{ type: 'state', state: 'taken_over', sessionId }
{ type: 'state', state: 'ending_takeover', sessionId }
{ type: 'takeover_ready', message: 'Browser is now visible...' }
{ type: 'takeover_ended', message: 'Browser minimized. Agent resumed.' }
```

**UI State Flow**:

```
Browser starts → Minimized (hidden)
     │
     ▼
[Take Over] clicked
     │
     ├─ State: taking_over (⏳ Switching to visible mode...)
     │
     ▼
showWindow() + bringToFront()
     │
     ├─ State: taken_over (👤 Manual Control Active)
     │
     ▼
User interacts with browser manually
     │
     ▼
[End Takeover] clicked
     │
     ├─ State: ending_takeover (⏳ Switching back...)
     │
     ▼
minimizeWindow() + auto-resume agent
     │
     ├─ State: running
     │
     ▼
Agent continues execution
```

**Test Results**:

| Feature | Status |
|---------|--------|
| Browser starts minimized | ✅ Working |
| Takeover shows browser | ✅ Working |
| Bring to front (CDP) | ✅ Working |
| End takeover minimizes | ✅ Working |
| Agent auto-resumes | ✅ Working |
| Hybrid streaming | ✅ Working |
| Window state detection | ✅ Working |
| Screenshot polling (minimized) | ✅ Working |
| Screencast (visible) | ✅ Working |
| Windows DPI detection | ✅ Working |
| Cross-platform (DPI only on Windows) | ✅ Working |

**Key Implementation Notes**:

1. **No Stagehand Fork Changes Required**: All takeover logic is in browser-agent and uses CDP directly
2. **Browser Never Restarts**: Uses CDP window state control, keeps session alive
3. **Streaming Continues**: Hybrid approach ensures frames even when minimized
4. **Auto-Resume**: Agent continues automatically after end takeover
5. **State Preservation**: All agent state preserved during takeover
6. **Headless Flag**: Only affects initial mode; takeover always makes visible
7. **DPI Detection**: Only runs on Windows; macOS/Linux let Chrome auto-detect

---

## API Specification

### Tool Parameters

```typescript
export type BrowserAgentAction =
  | 'start' // Initialize browser session (optional - auto-starts on other actions)
  | 'navigate' // Go to URL (auto-starts browser if needed)
  | 'act' // Single atomic action (auto-starts browser if needed)
  | 'extract' // Get structured data (auto-starts browser if needed)
  | 'screenshot' // Capture current page (auto-starts browser if needed)
  | 'observe' // Get possible actions (auto-starts browser if needed)
  | 'agent_task' // Run autonomous task
  | 'stop'; // End session and cleanup

export interface BrowserAgentParams {
  action: BrowserAgentAction;

  // For navigate
  url?: string;

  // For act/extract/observe/agent_task
  instruction?: string;

  // For extract - OPTIONAL (defaults to { extraction: string } if not provided)
  schema?: {
    type: 'object';
    properties: Record<
      string,
      {
        type: string;
        description?: string;
      }
    >;
    required?: string[];
  };

  // For screenshot
  fullPage?: boolean;
  savePath?: string;

  // For agent_task
  maxSteps?: number; // Default: 20

  // For start action - run browser in headless mode (default: false = visible)
  headless?: boolean;

  // Model selection
  model?: 'gemini-2.0-flash' | 'gemini-2.5-flash' | 'gemini-2.5-pro';
}
```

### Tool Result

```typescript
export interface BrowserAgentResult {
  success: boolean;
  action: BrowserAgentAction;

  // Current state
  url?: string;

  // For extract/observe
  data?: unknown;

  // For screenshot
  screenshotPath?: string;

  // For agent_task
  steps?: AgentStep[];

  // Error info
  error?: string;
  errorType?: BrowserAgentErrorType;
}

export interface AgentStep {
  stepNumber: number;
  action: string;
  reasoning: string;
  result: string;
  screenshot?: string;
}
```

### Tool Schema (JSON Schema)

```typescript
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
      description: 'Capture full page screenshot (default: false)',
    },
    maxSteps: {
      type: 'number',
      description: 'Maximum steps for agent_task (default: 20)',
    },
    model: {
      type: 'string',
      enum: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
      description: 'Model to use for browser agent (default: gemini-2.0-flash)',
    },
  },
  required: ['action'],
};
```

---

## File Structure

### New Package

```
packages/browser-agent/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                    # Main exports
│   ├── browser-agent-tool.ts       # Auditaria tool class
│   ├── stagehand-adapter.ts        # Stagehand wrapper
│   ├── session-manager.ts          # Browser lifecycle
│   ├── credential-bridge.ts        # Auth integration
│   ├── controller.ts               # Pause/resume/stop
│   ├── types.ts                    # Type definitions
│   └── errors.ts                   # Error definitions
├── scripts/
│   ├── test-extract.ts             # Phase 1 test
│   ├── test-navigate.ts            # Navigation test
│   └── test-agent.ts               # Agent task test
└── README.md
```

### Changes to Existing Packages

**Minimal invasion** - only 3 lines in core:

```
packages/core/src/tools/tool-names.ts
  + export const BROWSER_AGENT_TOOL_NAME = 'browser_agent';  // 1 line

packages/core/src/config/config.ts
  + import { BrowserAgentTool } from '@thacio/browser-agent';  // 1 line
  + registerCoreTool(BrowserAgentTool, this);                  // 1 line (in createToolRegistry)
```

**Web interface** (later phases):

```
packages/web-server/src/
  + browser-agent-events.ts

packages/web-client/src/components/
  + BrowserView.tsx
  + BrowserActionLog.tsx
```

---

## Testing Strategy

| Phase | Test Type | Test Method                                   |
| ----- | --------- | --------------------------------------------- |
| 1     | Automated | `npm run test:extract` - Wikipedia extraction |
| 2     | Manual    | AI tool invocation via Auditaria              |
| 3     | Automated | Auth detection unit tests                     |
| 4     | Automated | Screenshot file verification                  |
| 5     | Automated | Session persistence tests                     |
| 6     | Manual    | Multi-step task completion                    |
| 6.5   | Automated | Error scenario coverage                       |
| 7+    | Manual    | Web interface testing                         |

### Phase 1 Test Command

```bash
cd packages/browser-agent
npm install
npx tsx scripts/test-extract.ts
```

---

## Limitations

| Limitation            | Description                      | Mitigation                     |
| --------------------- | -------------------------------- | ------------------------------ |
| Chrome only           | Stagehand uses CDP, Chrome only  | Document requirement           |
| Local Chrome required | No Firefox/Safari                | Clear error message            |
| Memory usage          | Chrome is heavy (~500MB)         | Lazy init, cleanup             |
| No live video         | Streaming complex                | Use rapid screenshots          |
| Stagehand fork needed | OAuth requires patched Stagehand | Build and copy to node_modules |

---

## Risks

| Risk                       | Probability | Impact | Mitigation                                  |
| -------------------------- | ----------- | ------ | ------------------------------------------- |
| Stagehand breaking changes | Medium      | High   | Version lock, adapter pattern               |
| Stagehand fork drift       | Medium      | Medium | Track upstream changes, rebase periodically |
| CDP connection drops       | Medium      | Medium | Reconnection logic                          |
| LLM rate limits            | Medium      | Low    | Caching, backoff                            |
| Playwright conflicts       | Low         | High   | Optional dependency                         |

---

## Reference Files

### Stagehand

- Main class: `stagehand/packages/core/lib/v3/v3.ts`
- Google client: `stagehand/packages/core/lib/v3/llm/GoogleClient.ts`
- Examples: `stagehand/packages/core/examples/`
- Agent: `stagehand/packages/core/lib/v3/handlers/v3AgentHandler.ts`

### Open-Operator (Inspiration)

- Agent loop: `open-operator/app/api/agent/route.ts`
- Chat UI: `open-operator/app/components/ChatFeed.tsx`

### Browser-Use (Inspiration)

- System prompt: `browser-use/browser_use/agent/system_prompt.md`
- Agent service: `browser-use/browser_use/agent/service.py`

### Auditaria Tool Patterns

- Simple tool: `packages/core/src/tools/write-todos.ts`
- Config tool: `packages/core/src/tools/read-file.ts`
- Complex tool: `packages/core/src/tools/edit.ts`
- Registration: `packages/core/src/config/config.ts` (lines 1429-1545)

---
## Current Progress

**Last completed phase**: Phase 10 - Human-in-the-Loop Takeover ✅

**Status**: All major phases (1-10) now complete!

**Note**: Phase 9 was completed before Phase 8 due to higher priority for real-time browser viewing

### Phase 9 Completion Summary ✅

**Status**: COMPLETED (2025-12-03)

**Goal**: Real-time browser streaming to web interface using Chrome DevTools Protocol

**Commit**: `3dac1ca` - "phase 9 completed - streaming browser"

**Key Accomplishments**:

| Item | Status |
|------|--------|
| Created streaming infrastructure | ✅ |
| Implemented CDP screencast provider | ✅ |
| Implemented StreamManager with lazy start/stop | ✅ |
| WebSocket routing in WebInterfaceService | ✅ |
| BrowserStreamViewer React component | ✅ |
| Quality presets (low/medium/high) | ✅ |
| FPS counter and connection indicator | ✅ |
| Multiple client support | ✅ |
| Auto-cleanup on disconnect | ✅ |

**Architecture Highlights**:

1. **Abstract Provider Pattern**: `StreamProvider` base class allows future WebRTC provider
2. **Singleton StreamManager**: Manages all streaming sessions and client subscriptions
3. **Lazy Start/Stop**: Stream starts when first client connects, stops when last disconnects
4. **Page Resolver Pattern**: Connects StreamManager to SessionManager via callback
5. **WebSocket Protocol**: Custom message protocol for control and frame delivery

**Technical Details**:

- Uses `Page.startScreencast` CDP method for frame capture
- JPEG compression with configurable quality (50-85%)
- FPS control via `everyNthFrame` parameter (5-30 FPS)
- Base64 encoded frames sent over WebSocket
- Canvas rendering on client with aspect ratio preservation
- Retry logic (10 attempts, 500ms delay) for page readiness

**Files Structure**:
```
packages/browser-agent/src/streaming/
├── types.ts                    # 114 lines - All type definitions
├── stream-provider.ts          # 123 lines - Abstract base class
├── cdp-stream-provider.ts      # 183 lines - CDP implementation
├── stream-manager.ts           # 301 lines - Session/client management
└── index.ts                    # 28 lines - Exports

packages/web-client/src/components/
└── BrowserStreamViewer.js      # 537 lines - React streaming viewer
```

**Integration Points**:

1. `SessionManager.getPage()` - Returns Stagehand Page for streaming
2. `WebInterfaceService.setupWebSocketHandlers()` - Routes `/stream/browser/:sessionId`
3. `StreamManager.setPageResolver()` - Connects to SessionManager
4. `ToolRenderer.js` - Renders BrowserStreamViewer component

**Performance Metrics**:

| Quality | FPS | Resolution | JPEG Quality | Bandwidth Estimate |
|---------|-----|------------|--------------|-------------------|
| Low | 5 | 640x360 | 50% | ~50-100 KB/s |
| Medium | 15 | 1280x720 | 70% | ~200-400 KB/s |
| High | 30 | 1920x1080 | 85% | ~500-1000 KB/s |

**Known Limitations**:

- Video only (no audio - CDP screencast limitation)
- JPEG only (no PNG/lossless option)
- Maximum 30 FPS (CDP limitation)
- Chrome only (CDP protocol specific)

**Next Steps**:

- Phase 8: User control (pause/resume/stop)
- Phase 10: Human-in-the-loop takeover
- Optional: WebRTC provider for audio support
- Optional: Recording to video file

---

### Phase 7 Completion Summary ✅

**Status**: COMPLETED (2025-12-02)

**Goal**: Show browser agent step-by-step progress INLINE within the tool card as it executes, for both CLI and web interface.

**Approach**: Modified the Stagehand fork to emit step callbacks during agent execution, then wired those through to Auditaria's `updateOutput` mechanism.

**Commit**: `e55507fa7` - "phase 7"

**Files Created**:
- `docs/phase-7-implementation-plan.md` - Implementation plan documentation
- `packages/cli/src/ui/components/messages/BrowserStepDisplay.tsx` - Ink component for CLI display (~194 lines)

**Files Modified in Auditaria**:

| File | Changes |
|------|---------|
| `packages/browser-agent/src/types.ts` | Added `BrowserStepDisplay`, `BrowserStepInfo`, `AgentStepCallback` interfaces |
| `packages/browser-agent/src/browser-agent-tool.ts` | Added step callback setup, `updateOutput` usage, enabled `canUpdateOutput: true` |
| `packages/browser-agent/src/stagehand-adapter.ts` | Added `onStep` parameter to `executeAgentTask()` and `execute()` |
| `packages/cli/src/ui/components/messages/ToolResultDisplay.tsx` | Added browser step detection (must check FIRST before string checks) |
| `packages/web-client/src/components/ToolRenderer.js` | Added `renderBrowserSteps()`, `tryParseBrowserStepDisplay()`, step styling |
| `packages/web-client/src/style.css` | Added `.browser-steps-container`, `.browser-step`, status color classes |

**Stagehand Fork Modifications** (critical - not in main commit):

| File | Changes |
|------|---------|
| `stagehand/packages/core/lib/v3/types/public/agent.ts` | Added `AgentStepUpdate` interface, `onStep` to `AgentExecuteOptions` |
| `stagehand/packages/core/lib/v3/handlers/v3AgentHandler.ts` | Modified `createStepHandler()` to accept and emit `onStep` callback, passed `options.onStep` through |

**Key Implementation Details**:

1. **Stagehand onStep Callback** (`v3AgentHandler.ts:106-171`):
   ```typescript
   private createStepHandler(
     state: AgentState,
     onStep?: (step: AgentStepUpdate) => void,
   ) {
     let stepNumber = 0;
     return async (event: StepResult<ToolSet>) => {
       stepNumber++;
       // ... existing tool call processing ...

       // AUDITARIA: Emit step update callback for live progress tracking
       if (onStep) {
         onStep({
           stepNumber,
           actions: state.actions.slice(-event.toolCalls.length),
           message: event.text || state.collectedReasoning.slice(-1)[0] || "",
           completed: state.completed,
           currentUrl: state.currentPageUrl,
         });
       }
     };
   }
   ```

2. **BrowserAgentTool Step Callback** (`browser-agent-tool.ts:304-366`):
   - Creates `onStepCallback` for `agent_task` action when `updateOutput` is available
   - Converts Stagehand `AgentStepUpdate` to our `BrowserStepInfo` format
   - Accumulates steps in `allSteps` array
   - Emits JSON-stringified `BrowserStepDisplay` via `updateOutput()`

3. **CLI Rendering Fix** (`ToolResultDisplay.tsx`):
   - **Critical**: `browserStepData` check must be FIRST in the conditional chain
   - Previously, JSON strings were matching `typeof === 'string'` before browser step detection
   - Fix: Check `tryParseBrowserStepDisplay()` result before any string checks

4. **Web Client** (`ToolRenderer.js`):
   - `tryParseBrowserStepDisplay()` - Detects JSON with `browserSteps` array
   - `renderBrowserSteps()` - Creates DOM elements with status icons and colors
   - `getStepIcon()` - Maps status to icon (○ pending, ◐ executing, ● completed, ✗ error)

**Display Format**:
```
Session: default • https://example.com
● 1. Navigate - Going to https://example.com
● 2. Click - Clicking the login button
◐ 3. Type - Entering username
✓ Completed (3 steps)
```

**Build Commands After Stagehand Changes**:
```bash
# Build Stagehand fork
cd stagehand/packages/core
npx tsup lib/v3/index.ts --format cjs --outDir dist --no-dts

# Copy to node_modules
cp dist/index.js ../../node_modules/@browserbasehq/stagehand/dist/index.js

# Build and install Auditaria
cd ../..
npm run build && npm run bundle && npm uninstall @thacio/auditaria-cli && npm install -g .
```

**Notes**:
- Screenshots not implemented (deferred to later phase)
- Debug console.log statements left in place for troubleshooting
- V3AgentHandler (browser agent) modified, NOT GoogleCUAClient (CUA agent)
- CUA mode is for computer-use, regular browser agent uses V3AgentHandler

---

### Phase 6 Completion Summary ✅

**Status**: COMPLETED (2025-12-02)

**Key Feature**: Autonomous multi-step browser tasks using Stagehand's agent API

**Files Modified**:
- `packages/browser-agent/src/types.ts` - Added `AgentTaskResult` interface
- `packages/browser-agent/src/stagehand-adapter.ts` - Added `executeAgentTask()`, `mapAgentResult()`, `formatActionResult()` methods, updated `execute()` switch case
- `packages/browser-agent/src/index.ts` - Export `AgentTaskResult`

**Files Created**:
- `packages/browser-agent/scripts/test-agent-task.ts` - Test script for agent_task

**Features Implemented**:

| Feature | Description |
|---------|-------------|
| `agent_task` action | Execute autonomous multi-step tasks |
| Step tracking | Capture each step with reasoning and results |
| Token usage | Report input/output tokens and inference time |
| AbortSignal | Pre-abort check for cancellation |
| Result mapping | Convert Stagehand AgentResult to our format |

**Usage Example**:
```json
{ "action": "agent_task", "instruction": "Search for TypeScript on Wikipedia and find when it was first released", "maxSteps": 10 }
```

---

### Phase 5 Completion Summary ✅

**Status**: COMPLETED (2025-12-02)

**Key Feature**: Multiple concurrent browser sessions with smart defaults

**Files Created**:
- `packages/browser-agent/src/session-manager.ts` - SessionManager class (~300 lines)
- `packages/browser-agent/scripts/test-session-manager.ts` - Multi-session tests
- `docs/phase5-session-management-plan.md` - Detailed plan documentation

**Files Modified**:
- `packages/browser-agent/src/types.ts` - Added `sessionId`, `stopAll`, `activeSessions`
- `packages/browser-agent/src/browser-agent-tool.ts` - Replaced singleton with SessionManager
- `packages/browser-agent/src/index.ts` - Export SessionManager, SessionState, SessionConfig, SessionInfo

**Features Implemented**:

| Feature | Description |
|---------|-------------|
| Multiple sessions | Up to 5 concurrent browser sessions |
| Named sessions | AI can name sessions (e.g., `"admin"`, `"site-a"`) |
| Smart defaults | If 0-1 sessions, no ID needed; if multiple, ID required |
| Per-session locks | Promise-based race condition protection |
| Cleanup hooks | SIGINT/SIGTERM handlers close all browsers |
| Session info | Results include `sessionId` and `activeSessions` |

**Session Resolution Logic**:
```
sessionId provided? → Use or create that session
No sessionId:
  ├─ 0 sessions → Create "default"
  ├─ 1 session  → Use that session
  └─ 2+ sessions → ERROR (ambiguous)
```

**New Tool Parameters**:
- `sessionId` - Optional session identifier (e.g., `"admin"`, `"site-a"`)
- `stopAll` - For stop action: close all sessions at once

**Usage Examples**:

Simple (backward compatible):
```json
{ "action": "navigate", "url": "https://example.com" }
{ "action": "extract", "instruction": "Get title" }
{ "action": "stop" }
```

Multi-session:
```json
{ "action": "navigate", "sessionId": "site-a", "url": "https://site-a.com" }
{ "action": "navigate", "sessionId": "site-b", "url": "https://site-b.com" }
{ "action": "extract", "sessionId": "site-a", "instruction": "Get prices" }
{ "action": "extract", "sessionId": "site-b", "instruction": "Get prices" }
{ "action": "stop", "stopAll": true }
```

---

**Phase 4 Results** (Screenshot Capture - 2025-12-02):

Enhanced screenshot with full Stagehand/Playwright options. All tests passing (17/17).

**Default behavior**: Saves to `./browser-session/screenshots/screenshot-<timestamp>.png`

| Feature | Usage | Description |
|---------|-------|-------------|
| Viewport | `{ action: "screenshot" }` | Default, captures visible area |
| Full Page | `{ fullPage: true }` | Entire scrollable page |
| Element | `{ selector: "#id" }` | Specific element via bounding box |
| Clip | `{ clip: {x,y,w,h} }` | Specific region |
| Mask | `{ mask: [".secret"] }` | Hide sensitive elements |
| JPEG | `{ type: "jpeg", quality: 80 }` | JPEG with quality |
| Base64 | `{ returnBase64: true }` | Return inline (for web interface) |

**Key files**: `types.ts`, `stagehand-adapter.ts`, `browser-agent-tool.ts`

**Test scripts**: `scripts/test-screenshot-modes.ts`, `scripts/test-screenshot-adapter.ts`

---

**Phase 3.5 Results** (OAuth Bug Fix & Cleanup - 2025-12-02):

The `observe` action was returning empty `[]` when using OAuth mode. Root cause
analysis:

| Issue                  | Root Cause                                   | Fix                                                                                |
| ---------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| Empty observe results  | Missing `responseSchema` in CodeAssistClient | Added `responseSchema` to `generationConfig` using `toGeminiSchema()`              |
| API key required error | v3.ts always tried to load API key           | Added `hasAuthClient` check to skip API key loading in OAuth mode                  |
| Wrong Stagehand loaded | Dynamic import loaded vanilla npm package    | Must copy patched `dist/index.js` to `node_modules/@browserbasehq/stagehand/dist/` |

**Stagehand Commit** (`fc747a7` - "fix google code assist to work properly"):

1. **CodeAssistClient.ts** - Added structured output support:

   ```typescript
   import { Schema } from '@google/genai';
   import { toGeminiSchema } from '../../utils';

   // In generationConfig:
   if (response_model) {
     generationConfig.responseMimeType = 'application/json';
     const geminiSchema = toGeminiSchema(response_model.schema);
     generationConfig.responseSchema = geminiSchema;
   }
   ```

2. **v3.ts** - Fixed OAuth mode detection:
   ```typescript
   const hasAuthClient = !!(baseClientOptions as { authClient?: unknown })
     .authClient;
   if (!apiKey && !hasAuthClient) {
     // Skip API key loading for OAuth
     // load API key from env...
   }
   ```

**Cleanup Completed**:

- Removed `selector` field from `ObservableAction` interface (not useful for
  LLM)
- Removed all `console.log('[CredentialBridge]...')` debug statements
- Removed all `fileLog()` debug logging from CodeAssistClient.ts

**Build Commands** (updated):

```bash
# Build Stagehand fork (CJS format required)
cd stagehand/packages/core
npx tsup lib/v3/index.ts --format cjs --outDir dist --no-dts

# Copy to node_modules
cp dist/index.js ../../node_modules/@browserbasehq/stagehand/dist/index.js

# Build and install Auditaria
cd ../..
npm run build && npm run bundle && npm install -g .
```

**Phase 3 Results** (Credential Bridge - 2025-12-02):

- **OAuth Support**: Browser-agent now works with "Login with Google"
  authentication
- **API Key Support**: Standard Gemini API key authentication also works
- **CodeAssistClient**: New OAuth-compatible LLM client in Stagehand fork
- **CredentialBridge**: Detects auth type and provides appropriate credentials
- **Code Assist API**: Uses `cloudcode-pa.googleapis.com` for OAuth (same as
  Auditaria)
- **Both auth modes tested and working**: OAuth and API key

**Phase 2.5 Results** (UX Improvements):

- **Auto-start**: Browser automatically starts when needed - no explicit `start`
  action required
- **Headless parameter**: Added `headless` option to control browser visibility
  (default: false = visible)
- **Schema optional**: Extract action no longer requires schema - uses default
  `{ extraction: string }` if not provided
- **JSON Schema to Zod**: Improved converter with `.describe()` support for
  better LLM guidance
- **All tests passing**: 6 test suites covering validation, headless/visible
  modes, extraction with/without schema

**Phase 2 Results**:

- BrowserAgentTool class created following stock patterns (write-todos.ts,
  read-file.ts)
- Tool registered in config.ts and tool-names.ts
- Browser agent dependency added to core package
- Build passes successfully
- Tool included in bundle
- **Fixed**: Worker thread crash on startup (dynamic import)
- **Fixed**: Module resolution for both local dev and global install
- **Added**: Stagehand/Playwright to esbuild externals
- **Added**: Dependencies to CLI package for global install support

**Phase 1 Results**:

- Stagehand v3.0.5 installed and working
- Gemini 2.0 Flash integration successful
- Extract functionality tested with Wikipedia
- Playwright Chromium browser installed
- StagehandAdapter class created with v3 API

**Important Notes for Future Development**:

- Use `npm install --legacy-peer-deps` due to dotenv peer dependency conflict
  with Stagehand
- Any new heavy dependencies that do initialization on import should be marked
  external in esbuild.config.js
- External packages need multi-path resolution in code to work both locally and
  when globally installed
- **Stagehand fork changes**: After modifying Stagehand files, rebuild and copy
  to node_modules:
  ```bash
  cd stagehand/packages/core && npx tsup --entry.index lib/v3/index.ts
  cp dist/index.js ../../node_modules/@browserbasehq/stagehand/dist/index.js
  ```

**Current Tool Behavior**:

- Browser auto-starts on first action (navigate, extract, act, observe,
  screenshot)
- Default headless: false (visible browser for debugging)
- Extract without schema returns `{ extraction: "..." }`
- Extract with schema returns data matching the provided JSON Schema
- Session persists until `stop` action is called
- **OAuth mode**: Uses CodeAssistClient → Code Assist API
- **API key mode**: Uses AISdkClient/GoogleClient → Standard Gemini API

---

## Changelog

- 2025-12-04: Phase 10 completed - Human-in-the-Loop Takeover with browser window control via CDP,
  Hybrid streaming (screencast + screenshot polling), Windows DPI detection from registry,
  Take Over/End Takeover UI with state-specific hints and auto-resume
- 2025-12-03: Phase 8 completed - Pause/Resume/Stop controls for autonomous agent tasks,
  Extended SessionManager with execution states, WebSocket control channel, BrowserAgentControls UI,
  Stagehand fork modified (checkPauseState callback in v3AgentHandler)
- 2025-12-03: Phase 9 completed - Real-time browser streaming via CDP screencast,
  StreamManager with lazy start/stop, BrowserStreamViewer React component
- 2025-12-02: Phase 7 completed - Live step display for browser agent (CLI + web),
  Stagehand fork modified (V3AgentHandler onStep callback)
- 2025-12-02: Phase 3.5 completed - Fixed OAuth observe bug (missing
  responseSchema), removed debug logs, removed selector from observe output
- 2025-12-02: Phase 3 completed - OAuth credential bridge with CodeAssistClient
  for Code Assist API
- 2025-12-01: Phase 2.5 - Auto-start browser, headless parameter, schema
  optional for extract
- 2025-12-01: Phase 2 fixes - Worker thread crash, module resolution, global
  install support
- 2025-12-01: Phase 2 completed - Tool integration with Auditaria
- 2025-12-01: Phase 1 completed - Basic Extract working with Stagehand v3 +
  Gemini
- 2025-12-01: Initial plan created
