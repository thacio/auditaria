// AUDITARIA_CLAUDE_PROVIDER: Standalone MCP stdio server
// Spawned by Claude CLI as an MCP server. Bridges tool calls to Auditaria's
// ToolExecutorServer via HTTP on localhost. Fully generic — auto-discovers
// tools from the API, knows nothing about specific tool implementations.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { BridgeableToolSchema, ToolExecuteResponse } from './types.js';

// Parse --port from CLI arguments
const portIdx = process.argv.indexOf('--port');
if (portIdx === -1 || !process.argv[portIdx + 1]) {
  process.stderr.write('Usage: mcp-bridge --port <PORT> [--exclude <tool_name>]...\n');
  process.exit(1);
}
const PORT = process.argv[portIdx + 1];
const BASE_URL = `http://127.0.0.1:${PORT}`;

// AUDITARIA_AGENT_SESSION: Parse --exclude args (can appear multiple times)
const excludeSet = new Set<string>();
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--exclude' && process.argv[i + 1]) {
    excludeSet.add(process.argv[++i]);
  }
}

// Fetch tool definitions from Auditaria's tool executor
async function fetchTools(): Promise<BridgeableToolSchema[]> {
  const res = await fetch(`${BASE_URL}/tools`);
  if (!res.ok) throw new Error(`Failed to fetch tools: ${res.status} ${res.statusText}`);
  const allTools = await res.json() as BridgeableToolSchema[];
  // AUDITARIA_AGENT_SESSION: Filter out excluded tools
  return excludeSet.size > 0
    ? allTools.filter(t => !excludeSet.has(t.name))
    : allTools;
}

// Execute a tool via Auditaria's tool executor
async function executeTool(toolName: string, params: Record<string, unknown>): Promise<ToolExecuteResponse> {
  const res = await fetch(`${BASE_URL}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: toolName, params }),
  });
  if (!res.ok) throw new Error(`Tool execution failed: ${res.status} ${res.statusText}`);
  return res.json() as Promise<ToolExecuteResponse>;
}

async function main() {
  // Fetch available tools before setting up MCP handlers
  let tools: BridgeableToolSchema[];
  try {
    tools = await fetchTools();
  } catch (e) {
    process.stderr.write(`Failed to connect to Auditaria tool executor at ${BASE_URL}: ${e}\n`);
    process.exit(1);
  }

  if (tools.length === 0) {
    process.stderr.write('No bridgeable tools found\n');
  }

  const server = new Server(
    { name: 'auditaria-tools', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // Register list_tools handler — returns tool schemas from Auditaria
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    })),
  }));

  // Register call_tool handler — delegates execution to Auditaria
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = tools.find(t => t.name === name);
    if (!tool) {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      const result = await executeTool(name, (args || {}) as Record<string, unknown>);
      return {
        content: [{ type: 'text' as const, text: result.content }],
        isError: result.isError,
      };
    } catch (e) {
      return {
        content: [{ type: 'text' as const, text: `Bridge error: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      };
    }
  });

  // Connect via stdio (MCP transport)
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(e => {
  process.stderr.write(`MCP bridge fatal error: ${e}\n`);
  process.exit(1);
});
