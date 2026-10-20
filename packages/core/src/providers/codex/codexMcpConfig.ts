/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CodexDriverConfig } from './types.js';

/** Encode a TOML basic string for a shell-free command argument. */
export function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** MCP overrides scoped to one Codex process. */
export function buildCodexMcpArgs(
  config: Pick<
    CodexDriverConfig,
    | 'mcpServers'
    | 'toolBridgePort'
    | 'toolBridgeScript'
    | 'toolBridgeExclude'
    | 'toolBridgeCallId'
  >,
): string[] {
  const args: string[] = [];
  if (config.toolBridgePort && config.toolBridgeScript) {
    const bridgeArgs = [
      config.toolBridgeScript,
      '--port',
      String(config.toolBridgePort),
    ];
    for (const name of config.toolBridgeExclude ?? [])
      bridgeArgs.push('--exclude', name);
    if (config.toolBridgeCallId)
      bridgeArgs.push('--call-id', config.toolBridgeCallId);
    args.push(
      '-c',
      `mcp_servers.auditaria-tools={command=${tomlString(process.execPath)},args=[${bridgeArgs.map(tomlString).join(',')}]}`,
    );
  }
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    if (!server.command) continue;
    const parts = [`command=${tomlString(server.command)}`];
    if (server.args?.length)
      parts.push(`args=[${server.args.map(tomlString).join(',')}]`);
    if (server.env && Object.keys(server.env).length) {
      parts.push(
        `env={${Object.entries(server.env)
          .map(
            ([key, value]) => `${tomlString(key)}=${tomlString(String(value))}`,
          )
          .join(',')}}`,
      );
    }
    args.push(
      '-c',
      `mcp_servers.${name.replace(/[^A-Za-z0-9_-]/g, '_')}={${parts.join(',')}}`,
    );
  }
  return args;
}
