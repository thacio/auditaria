/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// File for 'gemini mcp add' command
import type { CommandModule } from 'yargs';
import { loadSettings, SettingScope } from '../../config/settings.js';
import type { MCPServerConfig } from '@thacio/auditaria-cli-core';
import { t } from '@thacio/auditaria-cli-core';

async function addMcpServer(
  name: string,
  commandOrUrl: string,
  args: Array<string | number> | undefined,
  options: {
    scope: string;
    transport: string;
    env: string[] | undefined;
    header: string[] | undefined;
    timeout?: number;
    trust?: boolean;
    description?: string;
    includeTools?: string[];
    excludeTools?: string[];
  },
) {
  const {
    scope,
    transport,
    env,
    header,
    timeout,
    trust,
    description,
    includeTools,
    excludeTools,
  } = options;

  const settings = loadSettings(process.cwd());
  const inHome = settings.workspace.path === settings.user.path;

  if (scope === 'project' && inHome) {
    console.error(
      t('commands.mcp.manage.add.error_home_directory', 'Error: Please use --scope user to edit settings in the home directory.'),
    );
    process.exit(1);
  }

  const settingsScope =
    scope === 'user' ? SettingScope.User : SettingScope.Workspace;

  let newServer: Partial<MCPServerConfig> = {};

  const headers = header?.reduce(
    (acc, curr) => {
      const [key, ...valueParts] = curr.split(':');
      const value = valueParts.join(':').trim();
      if (key.trim() && value) {
        acc[key.trim()] = value;
      }
      return acc;
    },
    {} as Record<string, string>,
  );

  switch (transport) {
    case 'sse':
      newServer = {
        url: commandOrUrl,
        headers,
        timeout,
        trust,
        description,
        includeTools,
        excludeTools,
      };
      break;
    case 'http':
      newServer = {
        httpUrl: commandOrUrl,
        headers,
        timeout,
        trust,
        description,
        includeTools,
        excludeTools,
      };
      break;
    case 'stdio':
    default:
      newServer = {
        command: commandOrUrl,
        args: args?.map(String),
        env: env?.reduce(
          (acc, curr) => {
            const [key, value] = curr.split('=');
            if (key && value) {
              acc[key] = value;
            }
            return acc;
          },
          {} as Record<string, string>,
        ),
        timeout,
        trust,
        description,
        includeTools,
        excludeTools,
      };
      break;
  }

  const existingSettings = settings.forScope(settingsScope).settings;
  const mcpServers = existingSettings.mcpServers || {};

  const isExistingServer = !!mcpServers[name];
  if (isExistingServer) {
    console.log(
      t('commands.mcp.manage.add.already_configured', `MCP server "${name}" is already configured within ${scope} settings.`, { name, scope }),
    );
  }

  mcpServers[name] = newServer as MCPServerConfig;

  settings.setValue(settingsScope, 'mcpServers', mcpServers);

  if (isExistingServer) {
    console.log(t('commands.mcp.manage.add.updated', `MCP server "${name}" updated in ${scope} settings.`, { name, scope }));
  } else {
    console.log(
      t('commands.mcp.manage.add.added', `MCP server "${name}" added to ${scope} settings. (${transport})`, { name, scope, transport }),
    );
  }
}

export const addCommand: CommandModule = {
  command: 'add <name> <commandOrUrl> [args...]',
  describe: t('commands.mcp.manage.add.description', 'Add a server'),
  builder: (yargs) =>
    yargs
      .usage(t('commands.mcp.manage.add.usage', 'Usage: auditaria mcp add [options] <name> <commandOrUrl> [args...]'))
      .parserConfiguration({
        'unknown-options-as-args': true, // Pass unknown options as server args
        'populate--': true, // Populate server args after -- separator
      })
      .positional('name', {
        describe: t('commands.mcp.manage.add.name_description', 'Name of the server'),
        type: 'string',
        demandOption: true,
      })
      .positional('commandOrUrl', {
        describe: t('commands.mcp.manage.add.command_url_description', 'Command (stdio) or URL (sse, http)'),
        type: 'string',
        demandOption: true,
      })
      .option('scope', {
        alias: 's',
        describe: t('commands.mcp.manage.add.scope_description', 'Configuration scope (user or project)'),
        type: 'string',
        default: 'project',
        choices: ['user', 'project'],
      })
      .option('transport', {
        alias: 't',
        describe: t('commands.mcp.manage.add.transport_description', 'Transport type (stdio, sse, http)'),
        type: 'string',
        default: 'stdio',
        choices: ['stdio', 'sse', 'http'],
      })
      .option('env', {
        alias: 'e',
        describe: t('commands.mcp.manage.add.env_description', 'Set environment variables (e.g. -e KEY=value)'),
        type: 'array',
        string: true,
      })
      .option('header', {
        alias: 'H',
        describe: t('commands.mcp.manage.add.header_description',
          'Set HTTP headers for SSE and HTTP transports (e.g. -H "X-Api-Key: abc123" -H "Authorization: Bearer abc123")'),
        type: 'array',
        string: true,
      })
      .option('timeout', {
        describe: t('commands.mcp.manage.add.timeout_description', 'Set connection timeout in milliseconds'),
        type: 'number',
      })
      .option('trust', {
        describe: t('commands.mcp.manage.add.trust_description',
          'Trust the server (bypass all tool call confirmation prompts)'),
        type: 'boolean',
      })
      .option('description', {
        describe: t('commands.mcp.manage.add.description_description', 'Set the description for the server'),
        type: 'string',
      })
      .option('include-tools', {
        describe: t('commands.mcp.manage.add.include_tools_description', 'A comma-separated list of tools to include'),
        type: 'array',
        string: true,
      })
      .option('exclude-tools', {
        describe: t('commands.mcp.manage.add.exclude_tools_description', 'A comma-separated list of tools to exclude'),
        type: 'array',
        string: true,
      })
      .middleware((argv) => {
        // Handle -- separator args as server args if present
        if (argv['--']) {
          const existingArgs = (argv['args'] as Array<string | number>) || [];
          argv['args'] = [...existingArgs, ...(argv['--'] as string[])];
        }
      }),
  handler: async (argv) => {
    await addMcpServer(
      argv['name'] as string,
      argv['commandOrUrl'] as string,
      argv['args'] as Array<string | number>,
      {
        scope: argv['scope'] as string,
        transport: argv['transport'] as string,
        env: argv['env'] as string[],
        header: argv['header'] as string[],
        timeout: argv['timeout'] as number | undefined,
        trust: argv['trust'] as boolean | undefined,
        description: argv['description'] as string | undefined,
        includeTools: argv['includeTools'] as string[] | undefined,
        excludeTools: argv['excludeTools'] as string[] | undefined,
      },
    );
  },
};
