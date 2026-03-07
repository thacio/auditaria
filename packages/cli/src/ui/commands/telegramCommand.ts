/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_TELEGRAM_FEATURE: This entire file is part of the Telegram integration

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
  registerTelegramForwarder,
  unregisterTelegramForwarder,
} from '../../services/telegram/TelegramBridge.js';

/** Persisted Telegram config (token + allowFrom + autostart) */
interface SavedTelegramConfig {
  botToken: string;
  allowFrom: string[];
  autostart?: boolean;
}

interface ActiveTelegramService {
  stop: () => Promise<void>;
  botUsername: string;
  updateAllowList: (allowFrom: string[]) => void;
  forwardCliItem: (item: HistoryItem) => void;
}

const TELEGRAM_CONFIG_FILE = 'telegram.json';
const TELEGRAM_LOCK_FILE = 'telegram.lock';
let activeTelegramService: ActiveTelegramService | undefined;
let activeBotUsername = '';

function getConfigPath(): string {
  return path.join(os.homedir(), '.auditaria', TELEGRAM_CONFIG_FILE);
}

function getLockPath(): string {
  return path.join(os.homedir(), '.auditaria', TELEGRAM_LOCK_FILE);
}

/**
 * Checks if another CLI instance is already running the Telegram bot.
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
      return data.pid; // Process is alive — lock is held
    } catch {
      // Process is dead — stale lock
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

function loadSavedConfig(): SavedTelegramConfig | undefined {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return JSON.parse(
        fs.readFileSync(configPath, 'utf-8'),
      ) as SavedTelegramConfig;
    }
  } catch {
    // Ignore read errors
  }
  return undefined;
}

function saveConfig(config: SavedTelegramConfig): void {
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
  return process.env['TELEGRAM_BOT_TOKEN'] || undefined;
}

const BOTFATHER_INSTRUCTIONS =
  '<b>How to get a Telegram Bot Token:</b>\n\n' +
  '1. Open Telegram and search for <b>@BotFather</b>\n' +
  '2. Send <code>/newbot</code>\n' +
  '3. Choose a display name (e.g., "My Auditaria Bot")\n' +
  '4. Choose a username ending in "bot" (e.g., "my_auditaria_bot")\n' +
  '5. BotFather will send you a token like:\n' +
  '   <code>123456789:ABCdefGHIjklMNOpqrsTUVwxyz</code>\n\n' +
  'Then run:\n' +
  '   <code>/telegram start &lt;your-token&gt;</code>';

async function startAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  if (activeTelegramService) {
    return {
      type: 'message',
      messageType: 'info',
      content: `Telegram bot is already running as @${activeBotUsername || 'unknown'}. Use /telegram stop first.`,
    };
  }

  const token = resolveToken(args.trim() || undefined);

  if (!token) {
    // Show BotFather instructions
    context.ui.addItem(
      { type: 'info', text: BOTFATHER_INSTRUCTIONS.replace(/<[^>]+>/g, '') },
      Date.now(),
    );
    return {
      type: 'message',
      messageType: 'error',
      content:
        'No bot token found. Provide it with: /telegram start <token>\n' +
        'Or set the TELEGRAM_BOT_TOKEN environment variable.',
    };
  }

  const config = context.services.config;
  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not available. Cannot start Telegram bot.',
    };
  }

  // Check if another CLI instance is already running the bot
  if (!acquireFileLock()) {
    const holdingPid = checkLock();
    return {
      type: 'message',
      messageType: 'error',
      content: `Another Auditaria instance (PID ${holdingPid}) is already running the Telegram bot.\nStop it first, or use that instance.`,
    };
  }

  // Save token for future use (autostart enabled once token is saved)
  const saved = loadSavedConfig() || { botToken: '', allowFrom: [] };
  saved.botToken = token;
  saved.autostart = true;
  saveConfig(saved);

  context.ui.addItem(
    { type: 'info', text: 'Starting Telegram bot...' },
    Date.now(),
  );

  try {
    const { startTelegramService } = await import(
      '../../services/telegram/TelegramService.js'
    );

    const allowFrom =
      saved.allowFrom.length > 0
        ? saved.allowFrom
        : process.env['TELEGRAM_ALLOW_FROM']
            ?.split(',')
            .map((s) => s.trim())
            .filter(Boolean) || [];

    const service = await startTelegramService(config, {
      botToken: token,
      allowFrom,
    });

    activeTelegramService = service;
    activeBotUsername = service.botUsername || 'bot';

    // Register CLI → Telegram forwarder
    registerTelegramForwarder((item) => service.forwardCliItem(item));

    const hasAllowList = saved.allowFrom.length > 0;
    let content = `Telegram bot started as @${activeBotUsername}!\n`;
    content +=
      'Token saved to ~/.auditaria/telegram.json for future sessions.\n';

    if (!hasAllowList) {
      content += '\nNext step: Send any message to your bot in Telegram.\n';
      content += 'It will reply with your user ID. Then run:\n';
      content += '  /telegram allow <your_user_id>';
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
      content: `Failed to start Telegram bot: ${err instanceof Error ? err.message : String(err)}`,
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

  if (!activeTelegramService) {
    return {
      type: 'message',
      messageType: 'info',
      content: disableAutostart
        ? 'Telegram bot is not running. Autostart disabled.'
        : 'Telegram bot is not running.',
    };
  }

  try {
    await activeTelegramService.stop();
    activeTelegramService = undefined;
    activeBotUsername = '';
    unregisterTelegramForwarder();
    releaseFileLock();
    return {
      type: 'message',
      messageType: 'info',
      content: disableAutostart
        ? 'Telegram bot stopped. Autostart disabled.'
        : 'Telegram bot stopped. It will auto-start next launch (use --disable to prevent).',
    };
  } catch (err) {
    return {
      type: 'message',
      messageType: 'error',
      content: `Failed to stop Telegram bot: ${err instanceof Error ? err.message : String(err)}`,
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
        'Please provide a numeric Telegram user ID.\n' +
        'Usage: /telegram allow <user_id>\n\n' +
        'To find your ID, send any message to your bot — it will reply with your user ID.',
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
  if (activeTelegramService) {
    activeTelegramService.updateAllowList(saved.allowFrom);
  }

  return {
    type: 'message',
    messageType: 'info',
    content: `User ${userId} added to allow list.${activeTelegramService ? ' Bot updated — they can now interact.' : ' Will take effect when bot starts.'}`,
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
        'Please provide a numeric Telegram user ID.\nUsage: /telegram remove <user_id>',
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

  if (activeTelegramService) {
    activeTelegramService.updateAllowList(saved.allowFrom);
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
  const hasEnvToken = !!process.env['TELEGRAM_BOT_TOKEN'];
  const hasSavedToken = !!saved?.botToken;

  let status = '';

  if (activeTelegramService) {
    status += 'Status: RUNNING\n';
    if (activeBotUsername) {
      status += `Bot: @${activeBotUsername}\n`;
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
      'Allow list: NONE (all messages denied — use /telegram allow <id>)\n';
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
  // If args look like a token, treat as start
  if (args.trim() && args.trim().includes(':')) {
    return startAction(context, args);
  }

  // Otherwise show help
  return {
    type: 'message',
    messageType: 'info',
    content:
      'Telegram Bot Integration\n\n' +
      'Usage:\n' +
      '  /telegram start [token]    - Start the bot (saves token, enables autostart)\n' +
      '  /telegram stop             - Stop the bot (keeps autostart)\n' +
      '  /telegram stop --disable   - Stop the bot and disable autostart\n' +
      '  /telegram allow <user_id>  - Add a user to the allow list\n' +
      '  /telegram remove <user_id> - Remove a user from the allow list\n' +
      '  /telegram status           - Show bot status\n\n' +
      'Setup:\n' +
      '  1. /telegram start <token>  (get token from @BotFather)\n' +
      '  2. Message your bot in Telegram (it replies with your user ID)\n' +
      '  3. /telegram allow <your_user_id>\n\n' +
      'Once configured, the bot auto-starts on every Auditaria launch.\n\n' +
      (activeTelegramService
        ? 'Bot is currently RUNNING.'
        : 'Bot is currently STOPPED.'),
  };
}

/**
 * Auto-starts the Telegram bot if a saved token exists and autostart is enabled.
 * Called from gemini.tsx during app initialization.
 * Runs silently — logs via debugLogger, doesn't throw.
 */
export async function autoStartTelegram(
  config: import('@google/gemini-cli-core').Config,
): Promise<void> {
  if (activeTelegramService) return;

  const saved = loadSavedConfig();
  if (!saved?.botToken || saved.autostart === false) return;

  // Check if another CLI instance is already running the bot
  if (!acquireFileLock()) return;

  const token = saved.botToken;
  const allowFrom =
    saved.allowFrom.length > 0
      ? saved.allowFrom
      : process.env['TELEGRAM_ALLOW_FROM']
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) || [];

  try {
    const { startTelegramService } = await import(
      '../../services/telegram/TelegramService.js'
    );
    const service = await startTelegramService(config, {
      botToken: token,
      allowFrom,
    });
    activeTelegramService = service;
    activeBotUsername = service.botUsername || 'bot';
    registerTelegramForwarder((item) => service.forwardCliItem(item));
  } catch {
    releaseFileLock();
    // Silent failure — bot autostart is best-effort
  }
}

/**
 * Stops the Telegram bot if running. Called during app cleanup.
 */
export async function stopTelegramIfRunning(): Promise<void> {
  if (activeTelegramService) {
    await activeTelegramService.stop();
    activeTelegramService = undefined;
    activeBotUsername = '';
    unregisterTelegramForwarder();
    releaseFileLock();
  }
}

export const telegramCommand: SlashCommand = {
  name: 'telegram',
  description: 'Manage Telegram bot integration',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  subCommands: [
    {
      name: 'start',
      description: 'Start the Telegram bot. Usage: /telegram start [token]',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: startAction,
    },
    {
      name: 'stop',
      description: 'Stop the running Telegram bot',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: stopAction,
    },
    {
      name: 'allow',
      description:
        'Add a user to the allow list. Usage: /telegram allow <user_id>',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: allowAction,
    },
    {
      name: 'remove',
      description:
        'Remove a user from the allow list. Usage: /telegram remove <user_id>',
      kind: CommandKind.BUILT_IN,
      autoExecute: false,
      action: removeAction,
    },
    {
      name: 'status',
      description: 'Show Telegram bot status and configuration',
      kind: CommandKind.BUILT_IN,
      autoExecute: true,
      action: statusAction,
    },
  ],
  action: defaultAction,
};
