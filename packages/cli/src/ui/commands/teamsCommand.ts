/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_TEAMS_FEATURE: This entire file is part of the Teams integration

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  type SlashCommand,
  type CommandContext,
  type SlashCommandActionReturn,
  CommandKind,
} from './types.js';
import type { HistoryItem } from '../types.js';
import type { TeamsResponseMode } from '../../services/teams/types.js';
import {
  registerTeamsForwarder,
  unregisterTeamsForwarder,
} from '../../services/teams/TeamsBridge.js';

/** Persisted Teams config */
interface SavedTeamsConfig {
  hmacSecret: string;
  port: number;
  allowFrom: string[];
  webhookUrl: string;
  responseMode: TeamsResponseMode;
  tunnel?: boolean;
  autostart?: boolean;
}

interface ActiveTeamsService {
  stop: () => Promise<void>;
  tunnelUrl: string | undefined;
  updateAllowList: (allowFrom: string[]) => void;
  updateResponseMode: (mode: TeamsResponseMode) => void;
  updateWebhookUrl: (url: string) => void;
  forwardCliItem: (item: HistoryItem) => void;
}

const TEAMS_CONFIG_FILE = 'teams.json';
const TEAMS_LOCK_FILE = 'teams.lock';
let activeTeamsService: ActiveTeamsService | undefined;

function getConfigPath(): string {
  return path.join(os.homedir(), '.auditaria', TEAMS_CONFIG_FILE);
}

function getLockPath(): string {
  return path.join(os.homedir(), '.auditaria', TEAMS_LOCK_FILE);
}

function checkLock(): number | undefined {
  try {
    const lockPath = getLockPath();
    if (!fs.existsSync(lockPath)) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const data = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as {
      pid: number;
    };
    if (!data.pid) return undefined;
    try {
      process.kill(data.pid, 0);
      return data.pid;
    } catch {
      fs.unlinkSync(lockPath);
      return undefined;
    }
  } catch {
    return undefined;
  }
}

function acquireFileLock(): boolean {
  const existing = checkLock();
  if (existing) return false;
  try {
    const lockPath = getLockPath();
    const dir = path.dirname(lockPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

function releaseFileLock(): void {
  try {
    const lockPath = getLockPath();
    if (fs.existsSync(lockPath)) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const data = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as {
        pid: number;
      };
      if (data.pid === process.pid) {
        fs.unlinkSync(lockPath);
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}

function loadSavedConfig(): SavedTeamsConfig | undefined {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return JSON.parse(
        fs.readFileSync(configPath, 'utf-8'),
      ) as SavedTeamsConfig;
    }
  } catch {
    // Ignore read errors
  }
  return undefined;
}

function saveConfig(config: SavedTeamsConfig): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

const VALID_RESPONSE_MODES: TeamsResponseMode[] = [
  'sync',
  'async',
  'labeled-async',
  'pull',
  'hybrid',
];

// --- Subcommand actions ---

async function startAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  if (activeTeamsService) {
    return {
      type: 'message',
      messageType: 'info',
      content:
        'Teams webhook server is already running. Use /teams stop first.',
    };
  }

  const config = context.services.config;
  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not available. Cannot start Teams service.',
    };
  }

  if (!acquireFileLock()) {
    const holdingPid = checkLock();
    return {
      type: 'message',
      messageType: 'error',
      content: `Another Auditaria instance (PID ${holdingPid}) is already running the Teams webhook server.\nStop it first, or use that instance.`,
    };
  }

  // Parse args: /teams start [hmac-secret] [--port N]
  const saved = loadSavedConfig() || {
    hmacSecret: '',
    port: 3978,
    allowFrom: [],
    webhookUrl: '',
    responseMode: 'sync' as TeamsResponseMode,
  };

  const argParts = args.trim().split(/\s+/);
  let hmacSecret = saved.hmacSecret;
  let port = saved.port || 3978;

  let noTunnel = false;
  for (let i = 0; i < argParts.length; i++) {
    if (argParts[i] === '--port' && argParts[i + 1]) {
      port = parseInt(argParts[i + 1], 10);
      i++;
    } else if (argParts[i] === '--no-tunnel') {
      noTunnel = true;
    } else if (argParts[i] && argParts[i] !== '--port') {
      hmacSecret = argParts[i]!;
    }
  }

  // Save config
  saved.hmacSecret = hmacSecret;
  saved.port = port;
  saved.autostart = true;
  if (noTunnel) saved.tunnel = false;
  saveConfig(saved);

  context.ui.addItem(
    {
      type: 'info',
      text: `Starting Teams webhook server on port ${port}...`,
    },
    Date.now(),
  );

  try {
    const { startTeamsService } = await import(
      '../../services/teams/TeamsService.js'
    );

    const service = await startTeamsService(config, {
      hmacSecret,
      port,
      allowFrom: saved.allowFrom,
      webhookUrl: saved.webhookUrl,
      responseMode: saved.responseMode,
      tunnel: saved.tunnel !== false && !noTunnel,
    });

    activeTeamsService = service;

    // Register CLI -> Teams forwarder (only works if incoming webhook is set)
    registerTeamsForwarder((item) => service.forwardCliItem(item));

    let content = `Teams webhook server started on port ${port}!\n`;
    if (service.tunnelUrl) {
      content += `Tunnel URL: ${service.tunnelUrl}\n`;
      content += 'Use this URL as the callback in Power Automate / Teams.\n';
    } else if (saved.tunnel !== false && !noTunnel) {
      content += '\nWarning: ngrok tunnel failed to start.\n';
      content +=
        'Check: ngrok config add-authtoken <token> (get from https://dashboard.ngrok.com)\n';
      content += 'Or start manually: ngrok http 3978\n';
      content += 'Or disable tunnel: /teams start --no-tunnel\n';
    }
    content += `Response mode: ${saved.responseMode}\n`;
    content += 'Config saved to ~/.auditaria/teams.json\n';

    if (!hmacSecret) {
      content +=
        '\nWarning: No HMAC secret configured. Requests will not be authenticated.\n';
      content += 'Set it with: /teams start <hmac-secret-from-teams>\n';
    }

    if (saved.allowFrom.length === 0) {
      content += '\nNext step: @mention the bot in Teams.\n';
      content += 'The response will show your AAD Object ID. Then run:\n';
      content += '  /teams allow <your_aad_object_id>\n';
    }

    if (!saved.webhookUrl && saved.responseMode !== 'sync') {
      content +=
        '\nNote: No incoming webhook URL configured. Async responses require it.\n';
      content += '  /teams webhook <url>\n';
    }

    return {
      type: 'message',
      messageType: 'info',
      content,
    };
  } catch (err) {
    releaseFileLock();
    return {
      type: 'message',
      messageType: 'error',
      content: `Failed to start Teams service: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function stopAction(
  _context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const disableAutostart = args.trim() === '--disable';

  if (disableAutostart) {
    const saved = loadSavedConfig();
    if (saved) {
      saved.autostart = false;
      saveConfig(saved);
    }
  }

  if (!activeTeamsService) {
    return {
      type: 'message',
      messageType: 'info',
      content: disableAutostart
        ? 'Teams service is not running. Autostart disabled.'
        : 'Teams service is not running.',
    };
  }

  try {
    await activeTeamsService.stop();
    activeTeamsService = undefined;
    unregisterTeamsForwarder();
    releaseFileLock();
    return {
      type: 'message',
      messageType: 'info',
      content: disableAutostart
        ? 'Teams service stopped. Autostart disabled.'
        : 'Teams service stopped. It will auto-start next launch (use --disable to prevent).',
    };
  } catch (err) {
    return {
      type: 'message',
      messageType: 'error',
      content: `Failed to stop Teams service: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function webhookAction(
  _context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const url = args.trim();
  if (!url) {
    const saved = loadSavedConfig();
    return {
      type: 'message',
      messageType: 'info',
      content: saved?.webhookUrl
        ? `Current incoming webhook URL: ${saved.webhookUrl}\n\nTo change: /teams webhook <new-url>`
        : 'No incoming webhook URL configured.\n\nUsage: /teams webhook <url>\n\nTo create one in Teams:\n1. Go to your channel\n2. Click ... > Connectors (or Workflows)\n3. Add "Incoming Webhook"\n4. Copy the URL',
    };
  }

  // Basic URL validation
  if (!url.startsWith('https://')) {
    return {
      type: 'message',
      messageType: 'error',
      content:
        'Incoming webhook URL must start with https://\nTeams webhook URLs look like: https://xxxx.webhook.office.com/...',
    };
  }

  const saved = loadSavedConfig() || {
    hmacSecret: '',
    port: 3978,
    allowFrom: [],
    webhookUrl: '',
    responseMode: 'sync' as TeamsResponseMode,
  };
  saved.webhookUrl = url;
  saveConfig(saved);

  if (activeTeamsService) {
    activeTeamsService.updateWebhookUrl(url);
  }

  return {
    type: 'message',
    messageType: 'info',
    content: `Incoming webhook URL saved.\n${activeTeamsService ? 'Active service updated.' : 'Will take effect when service starts.'}`,
  };
}

async function allowAction(
  _context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const userId = args.trim();
  if (!userId) {
    return {
      type: 'message',
      messageType: 'error',
      content:
        'Please provide an AAD Object ID (UUID format).\n' +
        'Usage: /teams allow <aad-object-id>\n\n' +
        'To find your ID, @mention the bot in Teams — it will reply with your AAD Object ID.',
    };
  }

  const saved = loadSavedConfig() || {
    hmacSecret: '',
    port: 3978,
    allowFrom: [],
    webhookUrl: '',
    responseMode: 'sync' as TeamsResponseMode,
  };

  if (saved.allowFrom.includes(userId)) {
    return {
      type: 'message',
      messageType: 'info',
      content: `User ${userId} is already in the allow list.`,
    };
  }

  saved.allowFrom.push(userId);
  saveConfig(saved);

  if (activeTeamsService) {
    activeTeamsService.updateAllowList(saved.allowFrom);
  }

  return {
    type: 'message',
    messageType: 'info',
    content: `User ${userId} added to allow list.${activeTeamsService ? ' Service updated — they can now interact.' : ' Will take effect when service starts.'}`,
  };
}

async function removeAction(
  _context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const userId = args.trim();
  if (!userId) {
    return {
      type: 'message',
      messageType: 'error',
      content:
        'Please provide an AAD Object ID.\nUsage: /teams remove <aad-object-id>',
    };
  }

  const saved = loadSavedConfig();
  if (!saved || !saved.allowFrom.includes(userId)) {
    return {
      type: 'message',
      messageType: 'info',
      content: `User ${userId} is not in the allow list.`,
    };
  }

  saved.allowFrom = saved.allowFrom.filter((id) => id !== userId);
  saveConfig(saved);

  if (activeTeamsService) {
    activeTeamsService.updateAllowList(saved.allowFrom);
  }

  return {
    type: 'message',
    messageType: 'info',
    content: `User ${userId} removed from allow list.`,
  };
}

async function modeAction(
  _context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const mode = args.trim() as TeamsResponseMode;

  if (!mode) {
    const saved = loadSavedConfig();
    return {
      type: 'message',
      messageType: 'info',
      content:
        `Current response mode: ${saved?.responseMode || 'sync'}\n\n` +
        'Available modes:\n' +
        '  sync          - Return in HTTP response (in-thread, 5s timeout)\n' +
        '  async         - POST via incoming webhook (new post, no timeout)\n' +
        '  labeled-async - Like async but with thread context label\n' +
        '  pull          - Store results, return on next @mention (in-thread)\n' +
        '  hybrid        - Try sync, fall back to async if >4s\n\n' +
        'Usage: /teams mode <mode>',
    };
  }

  if (!VALID_RESPONSE_MODES.includes(mode)) {
    return {
      type: 'message',
      messageType: 'error',
      content: `Invalid mode "${mode}". Valid modes: ${VALID_RESPONSE_MODES.join(', ')}`,
    };
  }

  if (mode !== 'sync' && mode !== 'pull' && !loadSavedConfig()?.webhookUrl) {
    return {
      type: 'message',
      messageType: 'error',
      content: `Mode "${mode}" requires an incoming webhook URL.\nSet one first: /teams webhook <url>`,
    };
  }

  const saved = loadSavedConfig() || {
    hmacSecret: '',
    port: 3978,
    allowFrom: [],
    webhookUrl: '',
    responseMode: 'sync' as TeamsResponseMode,
  };
  saved.responseMode = mode;
  saveConfig(saved);

  if (activeTeamsService) {
    activeTeamsService.updateResponseMode(mode);
  }

  return {
    type: 'message',
    messageType: 'info',
    content: `Response mode set to: ${mode}${activeTeamsService ? ' (active service updated)' : ''}`,
  };
}

async function statusAction(
  _context: CommandContext,
): Promise<void | SlashCommandActionReturn> {
  const saved = loadSavedConfig();
  const hasSecret = !!saved?.hmacSecret;
  const hasWebhook = !!saved?.webhookUrl;

  let status = '';

  if (activeTeamsService) {
    status += 'Status: RUNNING\n';
    if (activeTeamsService.tunnelUrl) {
      status += `Tunnel: ${activeTeamsService.tunnelUrl}\n`;
    }
  } else {
    status += 'Status: STOPPED\n';
  }

  status += `Port: ${saved?.port || 3978}\n`;
  status += `HMAC secret: ${hasSecret ? 'configured' : 'NOT SET (no auth)'}\n`;
  status += `Response mode: ${saved?.responseMode || 'sync'}\n`;
  status += `Tunnel: ${saved?.tunnel !== false ? 'enabled (ngrok)' : 'disabled'}\n`;
  status += `Incoming webhook: ${hasWebhook ? 'configured' : 'NOT SET'}\n`;
  status += `Autostart: ${saved?.autostart !== false && hasSecret ? 'enabled' : 'disabled'}\n`;

  if (saved?.allowFrom && saved.allowFrom.length > 0) {
    status += `Allow list (${saved.allowFrom.length}):\n`;
    for (const id of saved.allowFrom) {
      status += `  - ${id}\n`;
    }
  } else {
    status +=
      'Allow list: EMPTY (all messages denied — use /teams allow <id>)\n';
  }

  return {
    type: 'message',
    messageType: 'info',
    content: status.trim(),
  };
}

async function defaultAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  // If args look like a base64 HMAC secret, treat as start
  if (args.trim() && /^[A-Za-z0-9+/=]{20,}$/.test(args.trim())) {
    return startAction(context, args);
  }

  return {
    type: 'message',
    messageType: 'info',
    content:
      'Microsoft Teams Integration\n\n' +
      'Usage:\n' +
      '  /teams start [hmac-secret] [--port N] [--no-tunnel]  - Start webhook server\n' +
      '  /teams stop                             - Stop server\n' +
      '  /teams stop --disable                   - Stop and disable autostart\n' +
      '  /teams webhook <url>                    - Set incoming webhook URL\n' +
      '  /teams allow <aad-object-id>            - Add user to allow list\n' +
      '  /teams remove <aad-object-id>           - Remove user from allow list\n' +
      '  /teams mode [mode]                      - Get/set response mode\n' +
      '  /teams status                           - Show status\n\n' +
      'Setup:\n' +
      '  1. Create an Outgoing Webhook in Teams (channel settings)\n' +
      '  2. Point it to your server URL (e.g., ngrok http 3978)\n' +
      '  3. /teams start <hmac-secret-from-teams>\n' +
      '  4. @mention bot in Teams (it replies with your AAD Object ID)\n' +
      '  5. /teams allow <your_aad_object_id>\n\n' +
      'Response modes: sync, async, labeled-async, pull, hybrid\n' +
      '  /teams mode <mode> to switch\n\n' +
      (activeTeamsService
        ? 'Service is currently RUNNING.'
        : 'Service is currently STOPPED.'),
  };
}

// --- Auto-start / cleanup ---

/**
 * Auto-starts the Teams service if saved config exists and autostart is enabled.
 */
export async function autoStartTeams(
  config: import('@google/gemini-cli-core').Config,
): Promise<void> {
  if (activeTeamsService) return;

  const saved = loadSavedConfig();
  if (!saved?.hmacSecret || saved.autostart === false) return;

  if (!acquireFileLock()) return;

  try {
    const { startTeamsService } = await import(
      '../../services/teams/TeamsService.js'
    );
    const service = await startTeamsService(config, {
      hmacSecret: saved.hmacSecret,
      port: saved.port || 3978,
      allowFrom: saved.allowFrom || [],
      webhookUrl: saved.webhookUrl || '',
      responseMode: saved.responseMode || 'sync',
      tunnel: saved.tunnel !== false,
    });
    activeTeamsService = service;
    registerTeamsForwarder((item) => service.forwardCliItem(item));
  } catch {
    releaseFileLock();
    // Silent failure — autostart is best-effort
  }
}

/**
 * Stops the Teams service if running.
 */
export async function stopTeamsIfRunning(): Promise<void> {
  if (activeTeamsService) {
    await activeTeamsService.stop();
    activeTeamsService = undefined;
    unregisterTeamsForwarder();
    releaseFileLock();
  }
}

// --- Command definition ---

export const teamsCommand: SlashCommand = {
  name: 'teams',
  description: 'Manage Microsoft Teams webhook integration',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  subCommands: [
    {
      name: 'start',
      description:
        'Start the webhook server. Usage: /teams start [hmac-secret] [--port N]',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: startAction,
    },
    {
      name: 'stop',
      description: 'Stop the webhook server',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: stopAction,
    },
    {
      name: 'webhook',
      description:
        'Set the incoming webhook URL for async responses. Usage: /teams webhook <url>',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: webhookAction,
    },
    {
      name: 'allow',
      description:
        'Add a user to the allow list. Usage: /teams allow <aad-object-id>',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: allowAction,
    },
    {
      name: 'remove',
      description:
        'Remove a user from the allow list. Usage: /teams remove <aad-object-id>',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: removeAction,
    },
    {
      name: 'mode',
      description:
        'Get or set the response mode. Usage: /teams mode [sync|async|labeled-async|pull|hybrid]',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: modeAction,
    },
    {
      name: 'status',
      description: 'Show Teams integration status and configuration',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: statusAction,
    },
  ],
  action: defaultAction,
};
