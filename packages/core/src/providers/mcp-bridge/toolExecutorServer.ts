// AUDITARIA_CLAUDE_PROVIDER: HTTP API for executing bridgeable tools
// Runs in the Auditaria process. The MCP bridge script (spawned by Claude CLI)
// communicates with this server to list and execute tools.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import type { AnyDeclarativeTool } from '../../tools/tools.js';
import { partToString } from '../../utils/partUtils.js';
import type { AnsiOutput } from '../../utils/terminalSerializer.js'; // AUDITARIA: For updateOutput callback type
import type { BridgeableToolSchema, ToolExecuteRequest, ToolExecuteResponse } from './types.js';

const BASE_PORT = 19751;
const MAX_PORT_ATTEMPTS = 20;

// AUDITARIA: Callback type for routing live tool output to the UI layer
type ToolOutputCallback = (toolName: string, output: string) => void;

// AUDITARIA: Display metadata for bridgeable tools (used by UI to show nice names/descriptions)
export interface ToolDisplayInfo {
  displayName: string;
  description: string;
  isOutputMarkdown: boolean;
}

export class ToolExecutorServer {
  private server: Server | null = null;
  private port: number | null = null;
  private toolOutputHandler?: ToolOutputCallback; // AUDITARIA: Live tool output routing
  private lastReturnDisplays = new Map<string, string>(); // AUDITARIA: Store returnDisplay per tool

  constructor(private readonly registry: ToolRegistry) {}

  // AUDITARIA: Set callback for live tool output updates (browser agent steps, etc.)
  setToolOutputHandler(handler: ToolOutputCallback | undefined): void {
    this.toolOutputHandler = handler;
  }

  // AUDITARIA: Consume stored returnDisplay for a tool (returns and deletes)
  consumeReturnDisplay(toolName: string): string | undefined {
    const display = this.lastReturnDisplays.get(toolName);
    if (display) this.lastReturnDisplays.delete(toolName);
    return display;
  }

  getPort(): number | null {
    return this.port;
  }

  async start(): Promise<number> {
    if (this.server) return this.port!;

    const httpServer = createServer((req, res) => this.handleRequest(req, res));

    this.port = await this.findAvailablePort(httpServer);
    this.server = httpServer;
    return this.port;
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.port = null;
    }
  }

  getBridgeableTools(): BridgeableToolSchema[] {
    return this.registry.getAllTools()
      .filter(tool => (tool.constructor as unknown as Record<string, unknown>).Bridgeable === true)
      .map(tool => ({
        name: tool.schema.name ?? tool.name,
        description: tool.schema.description ?? '',
        inputSchema: tool.schema.parametersJsonSchema,
      }));
  }

  // AUDITARIA: Get display metadata for a bridgeable tool (displayName, description, isOutputMarkdown).
  // Builds the tool invocation to get a rich description from getDescription() instead of raw args JSON.
  getToolDisplayInfo(toolName: string, args: Record<string, unknown>): ToolDisplayInfo | undefined {
    const tool = this.registry.getAllTools()
      .find(t => t.name === toolName &&
        (t.constructor as unknown as Record<string, unknown>).Bridgeable === true);
    if (!tool) return undefined;

    let description: string;
    try {
      const invocation = tool.build(args as never);
      description = invocation.getDescription();
    } catch {
      // Validation failed — fall back to a simple key:value summary
      description = Object.entries(args)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(', ');
    }

    return {
      displayName: tool.displayName,
      description,
      isOutputMarkdown: tool.isOutputMarkdown,
    };
  }

  private async findAvailablePort(server: Server): Promise<number> {
    for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
      const port = BASE_PORT + i;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve();
          });
        });
        return port;
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
      }
    }
    throw new Error(
      `No available port found in range ${BASE_PORT}-${BASE_PORT + MAX_PORT_ATTEMPTS - 1}`,
    );
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === 'GET' && req.url === '/tools') {
      this.handleListTools(res);
    } else if (req.method === 'POST' && req.url === '/execute') {
      this.handleExecuteTool(req, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  private handleListTools(res: ServerResponse): void {
    const tools = this.getBridgeableTools();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tools));
  }

  private async handleExecuteTool(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await this.readBody(req);
      const request: ToolExecuteRequest = JSON.parse(body);

      const tool = this.registry.getAllTools()
        .find(t => t.name === request.tool &&
          (t.constructor as unknown as Record<string, unknown>).Bridgeable === true);

      if (!tool) {
        const response: ToolExecuteResponse = {
          content: `Tool '${request.tool}' not found or not bridgeable`,
          isError: true,
        };
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
        return;
      }

      const result = await this.executeTool(tool, request.params);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e: unknown) {
      const response: ToolExecuteResponse = {
        content: `Execution error: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    }
  }

  private async executeTool(
    tool: AnyDeclarativeTool,
    params: Record<string, unknown>,
  ): Promise<ToolExecuteResponse> {
    try {
      const ac = new AbortController();
      const toolName = tool.name;

      // AUDITARIA: Create updateOutput callback for live updates (browser agent steps, etc.)
      const updateOutput = (tool.canUpdateOutput && this.toolOutputHandler)
        ? (output: string | AnsiOutput) => {
            if (typeof output === 'string') {
              this.toolOutputHandler!(toolName, output);
            }
          }
        : undefined;

      const result = await tool.buildAndExecute(params, ac.signal, updateOutput);

      const content = partToString(result.llmContent, { verbose: true });

      // AUDITARIA: Store returnDisplay for providerManager to consume
      const returnDisplayStr = typeof result.returnDisplay === 'string'
        ? result.returnDisplay
        : result.returnDisplay?.toString();
      if (returnDisplayStr) {
        this.lastReturnDisplays.set(toolName, returnDisplayStr);
      }

      return {
        content: content || returnDisplayStr || 'Tool completed with no output',
        isError: !!result.error,
        returnDisplay: returnDisplayStr,
      };
    } catch (e: unknown) {
      return {
        content: `Tool error: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }
}
