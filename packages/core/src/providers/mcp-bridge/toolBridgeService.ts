/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_EXPOSE_MCP: Standalone bridge service for eager startup.
// When --expose-mcp / AUDITARIA_EXPOSE_MCP=1 is set, Config owns one of these
// and starts it during _initialize() so external MCP hosts (e.g. another
// Claude Code instance pointing at bundle/mcp-bridge.js) can reach 19751
// regardless of which provider Auditaria is currently driving.
//
// ProviderManager.ensureToolExecutorServer() borrows this service's server
// when it exists, so there is exactly one HTTP listener for the bridge.

import type { ToolRegistry } from '../../tools/tool-registry.js';
import { ToolExecutorServer } from './toolExecutorServer.js';

/**
 * Resolve the path to the bundled mcp-bridge.js script. The bridge bundle
 * lives next to the main CLI bundle, and `import.meta.url` of any module in
 * the bundle resolves to the bundle's own location.
 *
 * Returns undefined if path resolution fails (e.g., unusual bundling).
 */
export async function resolveBridgeScriptPath(): Promise<string | undefined> {
  try {
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const bundleDir = dirname(fileURLToPath(import.meta.url));
    return join(bundleDir, 'mcp-bridge.js');
  } catch {
    return undefined;
  }
}

export class ToolBridgeService {
  private server?: ToolExecutorServer;
  private scriptPath?: string;
  private port?: number;

  constructor(
    private readonly registry: ToolRegistry,
    // AUDITARIA_EXPOSE_MCP: When set (--mcp-port / AUDITARIA_MCP_PORT), bind exactly
    // that port and throw on conflict. Otherwise walk 19751..19770.
    private readonly explicitPort?: number,
  ) {}

  async start(): Promise<{ port: number; scriptPath: string }> {
    if (this.server && this.port !== undefined && this.scriptPath) {
      return { port: this.port, scriptPath: this.scriptPath };
    }

    const scriptPath = await resolveBridgeScriptPath();
    if (!scriptPath) {
      throw new Error('Could not resolve mcp-bridge.js path');
    }
    this.scriptPath = scriptPath;

    const server = new ToolExecutorServer(this.registry);
    this.port = await server.start(this.explicitPort);
    this.server = server;
    return { port: this.port, scriptPath: this.scriptPath };
  }

  stop(): void {
    this.server?.stop();
    this.server = undefined;
    this.port = undefined;
  }

  getServer(): ToolExecutorServer | undefined {
    return this.server;
  }

  getPort(): number | undefined {
    return this.port;
  }

  getScriptPath(): string | undefined {
    return this.scriptPath;
  }
}
