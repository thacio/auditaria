/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_DISCORD_FEATURE: This entire file is part of the Discord integration

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
import {
  registerDiscordForwarder,
  unregisterDiscordForwarder,
} from '../../services/discord/DiscordBridge.js';

/** Persisted Discord config (token + allowFrom + autostart) */
interface SavedDiscordConfig {
  botToken: string;
  allowFrom: string[];
  autostart?: boolean;
}

interface ActiveDiscordService {
  stop: () => Promise<void>;
  botUsername: string;
  updateAllowList: (allowFrom: string[]) => void;
  forwardCliItem: (item: HistoryItem) => void;
}

const DISCORD_CONFIG_FILE = 'discord.json';
const DISCORD_LOCK_FILE = 'discord.lock';
let activeDiscordService: ActiveDiscordService | undefined;
let activeBotUsername = '';

function getConfigPath(): string {
  return path.join(os.homedir(), '.auditaria', DISCORD_CONFIG_FILE);
}

function getLockPath(): string {
  return path.join(os.homedir(), '.auditaria', DISCORD_LOCK_FILE);
}

/**
 * Checks if another CLI instance is already running the Discord bot.
 * Returns the PID of the holding process, or undefined if the lock is free/stale.
 */
function checkLock(): number | undefined {
  try {
    const lockPath = getLockPath();
    if (!fs.existsSync(lockPath)) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const data = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as {
      pid: number;
    };
    if (!data.pid) return undefined;
    // Check if the process is still alive
    try {
      process.kill(data.pid, 0); // signal 0 = just check existence
      return data.pid; // Process is alive -- lock is held
    } catch {
      // Process is dead -- stale lock
      fs.unlinkSync(lockPath);
      return undefined;
    }
  } catch {
    return undefined;
  }
}

function acquireFileLock(): boolean {
  const existing = checkLock();
  if (existing) return false; // Another process holds the lock
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
      // Only delete if we own the lock
      if (data.pid === process.pid) {
        fs.unlinkSync(lockPath);
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}

function loadSavedConfig(): SavedDiscordConfig | undefined {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return JSON.parse(
        fs.readFileSync(configPath, 'utf-8'),
      ) as SavedDiscordConfig;
    }
  } catch {
    // Ignore read errors
  }
  return undefined;
}

function saveConfig(config: SavedDiscordConfig): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

function resolveToken(argsToken?: string): string | undefined {
  // Priority: argument > saved config > env var
  if (argsToken) return argsToken;
  const saved = loadSavedConfig();
  if (saved?.botToken) return saved.botToken;
  return process.env['DISCORD_BOT_TOKEN'] || undefined;
}

const SETUP_INSTRUCTIONS =
  'How to set up a Discord Bot:\n\n' +
  'Step 1: Create a bot\n' +
  '  1. Go to https://discord.com/developers/applications\n' +
  '  2. Click "New Application", give it a name, click Create\n' +
  '  3. Go to "Bot" in the left sidebar\n' +
  '  4. Click "Reset Token" and copy the token (save it!)\n' +
  '  5. Scroll down and enable "MESSAGE CONTENT INTENT"\n\n' +
  "Step 2: Create a Discord server (if you don't own one)\n" +
  '  1. Open Discord app (or https://discord.com/channels/@me)\n' +
  '  2. Click the green "+" icon at the bottom of the server list (left sidebar)\n' +
  '  3. Choose "Create My Own" and follow the prompts\n\n' +
  'Step 3: Invite the bot to your server\n' +
  '  1. Back in the Developer Portal, go to "OAuth2" > "URL Generator"\n' +
  '  2. Under SCOPES, check "bot"\n' +
  '  3. Under BOT PERMISSIONS (appears after selecting "bot"), check:\n' +
  '     "Send Messages", "Read Message History", "Add Reactions"\n' +
  '  4. Copy the GENERATED URL at the bottom of the page\n' +
  '  5. Open that URL in your browser, select your server, and authorize\n\n' +
  'Step 4: Connect to Auditaria\n' +
  '  Run: /discord start <your-token>';

async function startAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  if (activeDiscordService) {
    return {
      type: 'message',
      messageType: 'info',
      content: `Discord bot is already running as ${activeBotUsername || 'unknown'}. Use /discord stop first.`,
    };
  }

  const token = resolveToken(args.trim() || undefined);

  if (!token) {
    // Show setup instructions
    context.ui.addItem({ type: 'info', text: SETUP_INSTRUCTIONS }, Date.now());
    return {
      type: 'message',
      messageType: 'error',
      content:
        'No bot token found. Provide it with: /discord start <token>\n' +
        'Or set the DISCORD_BOT_TOKEN environment variable.',
    };
  }

  const config = context.services.config;
  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not available. Cannot start Discord bot.',
    };
  }

  // Check if another CLI instance is already running the bot
  if (!acquireFileLock()) {
    const holdingPid = checkLock();
    return {
      type: 'message',
      messageType: 'error',
      content: `Another Auditaria instance (PID ${holdingPid}) is already running the Discord bot.\nStop it first, or use that instance.`,
    };
  }

  // Save token for future use (autostart enabled once token is saved)
  const saved = loadSavedConfig() || { botToken: '', allowFrom: [] };
  saved.botToken = token;
  saved.autostart = true;
  saveConfig(saved);

  context.ui.addItem(
    { type: 'info', text: 'Starting Discord bot...' },
    Date.now(),
  );

  try {
    const { startDiscordService } = await import(
      '../../services/discord/DiscordService.js'
    );

    const allowFrom =
      saved.allowFrom.length > 0
        ? saved.allowFrom
        : process.env['DISCORD_ALLOW_FROM']
            ?.split(',')
            .map((s) => s.trim())
            .filter(Boolean) || [];

    const service = await startDiscordService(config, {
      botToken: token,
      allowFrom,
    });

    activeDiscordService = service;
    activeBotUsername = service.botUsername || 'bot';

    // Register CLI -> Discord forwarder
    registerDiscordForwarder((item) => service.forwardCliItem(item));

    const hasAllowList = saved.allowFrom.length > 0;
    let content = `Discord bot started as ${activeBotUsername}!\n`;
    content +=
      'Token saved to ~/.auditaria/discord.json for future sessions.\n';

    if (!hasAllowList) {
      content += '\nNext step: Send any message to your bot in Discord.\n';
      content += 'It will reply with your user ID. Then run:\n';
      content += '  /discord allow <your_user_id>';
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
      content: `Failed to start Discord bot: ${err instanceof Error ? err.message : String(err)}`,
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

  if (!activeDiscordService) {
    return {
      type: 'message',
      messageType: 'info',
      content: disableAutostart
        ? 'Discord bot is not running. Autostart disabled.'
        : 'Discord bot is not running.',
    };
  }

  try {
    await activeDiscordService.stop();
    activeDiscordService = undefined;
    activeBotUsername = '';
    unregisterDiscordForwarder();
    releaseFileLock();
    return {
      type: 'message',
      messageType: 'info',
      content: disableAutostart
        ? 'Discord bot stopped. Autostart disabled.'
        : 'Discord bot stopped. It will auto-start next launch (use --disable to prevent).',
    };
  } catch (err) {
    return {
      type: 'message',
      messageType: 'error',
      content: `Failed to stop Discord bot: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function allowAction(
  _context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const userId = args.trim();
  if (!userId || !/^\d+$/.test(userId)) {
    return {
      type: 'message',
      messageType: 'error',
      content:
        'Please provide a numeric Discord user ID.\n' +
        'Usage: /discord allow <user_id>\n\n' +
        'To find your ID, send any message to your bot -- it will reply with your user ID.',
    };
  }

  const saved = loadSavedConfig() || { botToken: '', allowFrom: [] };
  if (saved.allowFrom.includes(userId)) {
    return {
      type: 'message',
      messageType: 'info',
      content: `User ${userId} is already in the allow list.`,
    };
  }

  saved.allowFrom.push(userId);
  saveConfig(saved);

  // Update the running bot if active
  if (activeDiscordService) {
    activeDiscordService.updateAllowList(saved.allowFrom);
  }

  return {
    type: 'message',
    messageType: 'info',
    content: `User ${userId} added to allow list.${activeDiscordService ? ' Bot updated -- they can now interact.' : ' Will take effect when bot starts.'}`,
  };
}

async function removeAction(
  _context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const userId = args.trim();
  if (!userId || !/^\d+$/.test(userId)) {
    return {
      type: 'message',
      messageType: 'error',
      content:
        'Please provide a numeric Discord user ID.\nUsage: /discord remove <user_id>',
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

  if (activeDiscordService) {
    activeDiscordService.updateAllowList(saved.allowFrom);
  }

  return {
    type: 'message',
    messageType: 'info',
    content: `User ${userId} removed from allow list.`,
  };
}

async function statusAction(
  _context: CommandContext,
): Promise<void | SlashCommandActionReturn> {
  const saved = loadSavedConfig();
  const hasEnvToken = !!process.env['DISCORD_BOT_TOKEN'];
  const hasSavedToken = !!saved?.botToken;

  let status = '';

  if (activeDiscordService) {
    status += 'Status: RUNNING\n';
    if (activeBotUsername) {
      status += `Bot: ${activeBotUsername}\n`;
    }
  } else {
    status += 'Status: STOPPED\n';
  }

  status += `Token source: ${hasSavedToken ? 'saved config' : hasEnvToken ? 'env var' : 'none'}\n`;
  status += `Autostart: ${saved?.autostart !== false && hasSavedToken ? 'enabled' : 'disabled'}\n`;
  if (saved?.allowFrom && saved.allowFrom.length > 0) {
    status += `Allow list: ${saved.allowFrom.join(', ')}\n`;
  } else {
    status +=
      'Allow list: NONE (all messages denied -- use /discord allow <id>)\n';
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
  // If args look like a token (long string), treat as start
  if (args.trim() && args.trim().length > 20) {
    return startAction(context, args);
  }

  // Otherwise show help
  return {
    type: 'message',
    messageType: 'info',
    content:
      'Discord Bot Integration\n\n' +
      'Usage:\n' +
      '  /discord start [token]    - Start the bot (saves token, enables autostart)\n' +
      '  /discord stop             - Stop the bot (keeps autostart)\n' +
      '  /discord stop --disable   - Stop the bot and disable autostart\n' +
      '  /discord allow <user_id>  - Add a user to the allow list\n' +
      '  /discord remove <user_id> - Remove a user from the allow list\n' +
      '  /discord status           - Show bot status\n\n' +
      'Setup:\n' +
      '  1. Create bot at https://discord.com/developers/applications\n' +
      '  2. Bot section: copy token, enable MESSAGE CONTENT INTENT\n' +
      "  3. Create a Discord server if you don't own one (+ icon in Discord sidebar)\n" +
      '  4. OAuth2 > URL Generator: check "bot" scope, then check permissions:\n' +
      '     Send Messages, Read Message History, Add Reactions\n' +
      '  5. Copy the generated URL at the bottom, open it, select your server\n' +
      '  6. /discord start <token>\n' +
      '  7. Message the bot in Discord (it replies with your user ID)\n' +
      '  8. /discord allow <your_user_id>\n\n' +
      'Once configured, the bot auto-starts on every Auditaria launch.\n\n' +
      (activeDiscordService
        ? 'Bot is currently RUNNING.'
        : 'Bot is currently STOPPED.'),
  };
}

/**
 * Auto-starts the Discord bot if a saved token exists and autostart is enabled.
 * Called from gemini.tsx during app initialization.
 * Runs silently -- logs via debugLogger, doesn't throw.
 */
export async function autoStartDiscord(
  config: import('@google/gemini-cli-core').Config,
): Promise<void> {
  if (activeDiscordService) return;

  const saved = loadSavedConfig();
  if (!saved?.botToken || saved.autostart === false) return;

  // Check if another CLI instance is already running the bot
  if (!acquireFileLock()) return;

  const token = saved.botToken;
  const allowFrom =
    saved.allowFrom.length > 0
      ? saved.allowFrom
      : process.env['DISCORD_ALLOW_FROM']
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) || [];

  try {
    const { startDiscordService } = await import(
      '../../services/discord/DiscordService.js'
    );
    const service = await startDiscordService(config, {
      botToken: token,
      allowFrom,
    });
    activeDiscordService = service;
    activeBotUsername = service.botUsername || 'bot';
    registerDiscordForwarder((item) => service.forwardCliItem(item));
  } catch {
    releaseFileLock();
    // Silent failure -- bot autostart is best-effort
  }
}

/**
 * Stops the Discord bot if running. Called during app cleanup.
 */
export async function stopDiscordIfRunning(): Promise<void> {
  if (activeDiscordService) {
    await activeDiscordService.stop();
    activeDiscordService = undefined;
    activeBotUsername = '';
    unregisterDiscordForwarder();
    releaseFileLock();
  }
}

export const discordCommand: SlashCommand = {
  name: 'discord',
  description: 'Manage Discord bot integration',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  subCommands: [
    {
      name: 'start',
      description: 'Start the Discord bot. Usage: /discord start [token]',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: startAction,
    },
    {
      name: 'stop',
      description: 'Stop the running Discord bot',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: stopAction,
    },
    {
      name: 'allow',
      description:
        'Add a user to the allow list. Usage: /discord allow <user_id>',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: allowAction,
    },
    {
      name: 'remove',
      description:
        'Remove a user from the allow list. Usage: /discord remove <user_id>',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: removeAction,
    },
    {
      name: 'status',
      description: 'Show Discord bot status and configuration',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: statusAction,
    },
  ],
  action: defaultAction,
};
