// AUDITARIA_CLAUDE_PROVIDER: HTTP API for executing bridgeable tools
// Runs in the Auditaria process. The MCP bridge script (spawned by Claude CLI)
// communicates with this server to list and execute tools.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import type { AnyDeclarativeTool } from '../../tools/tools.js';
import { partToString } from '../../utils/partUtils.js';
import type { BridgeableToolSchema, ToolExecuteRequest, ToolExecuteResponse } from './types.js';

const BASE_PORT = 19751;
const MAX_PORT_ATTEMPTS = 20;

export class ToolExecutorServer {
  private server: Server | null = null;
  private port: number | null = null;

  constructor(private readonly registry: ToolRegistry) {}

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
      const result = await tool.buildAndExecute(params, ac.signal);

      const content = partToString(result.llmContent, { verbose: true });
      return {
        content: content || result.returnDisplay?.toString() || 'Tool completed with no output',
        isError: !!result.error,
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
