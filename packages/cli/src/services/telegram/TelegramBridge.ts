/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_TELEGRAM_FEATURE: This entire file is part of the Telegram integration
//
// Bridge for CLI ↔ Telegram display sync.
// Avoids circular dependencies by providing module-level callback storage
// that both TelegramService and React hooks can access.

import type { HistoryItemWithoutId, HistoryItem } from '../../ui/types.js';

// --- CLI Display Bridge ---
// Allows TelegramService to push items to CLI's useHistoryManager

type CliDisplayCallback = (item: HistoryItemWithoutId, ts?: number) => void;
let cliDisplayCallback: CliDisplayCallback | undefined;

export function registerCliDisplayCallback(cb: CliDisplayCallback): void {
  cliDisplayCallback = cb;
}

export function unregisterCliDisplayCallback(): void {
  cliDisplayCallback = undefined;
}

export function pushToCliDisplay(item: HistoryItemWithoutId): void {
  cliDisplayCallback?.(item, Date.now());
}

// --- Telegram Processing Flag ---
// When true, items added to CLI display by Telegram are NOT forwarded back to Telegram (prevents echo)

let telegramProcessing = false;

export function setTelegramProcessing(value: boolean): void {
  telegramProcessing = value;
}

export function isTelegramProcessing(): boolean {
  return telegramProcessing;
}

// --- CLI → Telegram Forwarding ---
// Allows useHistoryManager to forward items to Telegram

type TelegramForwarder = (item: HistoryItem) => void;
let telegramForwarder: TelegramForwarder | undefined;

export function registerTelegramForwarder(fn: TelegramForwarder): void {
  telegramForwarder = fn;
}

export function unregisterTelegramForwarder(): void {
  telegramForwarder = undefined;
}

export function forwardToTelegram(item: HistoryItem): void {
  if (!telegramProcessing && telegramForwarder) {
    telegramForwarder(item);
  }
}

// --- CLI Input Injection ---
// Allows TelegramService to inject slash commands into the CLI's submitQuery pipeline

type CliInputCallback = (input: string) => void;
let cliInputCallback: CliInputCallback | undefined;

export function registerCliInputCallback(cb: CliInputCallback): void {
  cliInputCallback = cb;
}

export function unregisterCliInputCallback(): void {
  cliInputCallback = undefined;
}

/**
 * Injects input into the CLI as if the user typed it.
 * Used for forwarding slash commands from Telegram to the CLI command processor.
 * Returns true if the callback is registered (CLI is ready), false otherwise.
 */
export function injectCliInput(input: string): boolean {
  if (cliInputCallback) {
    cliInputCallback(input);
    return true;
  }
  return false;
}
