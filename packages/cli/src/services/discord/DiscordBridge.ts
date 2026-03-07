/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_DISCORD_FEATURE: This entire file is part of the Discord integration
//
// Bridge for CLI <-> Discord display sync.
// Avoids circular dependencies by providing module-level callback storage
// that both DiscordService and React hooks can access.

import type { HistoryItemWithoutId, HistoryItem } from '../../ui/types.js';

// --- CLI Display Bridge ---
// Allows DiscordService to push items to CLI's useHistoryManager

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

// --- Discord Processing Flag ---
// When true, items added to CLI display by Discord are NOT forwarded back to Discord (prevents echo)

let discordProcessing = false;

export function setDiscordProcessing(value: boolean): void {
  discordProcessing = value;
}

export function isDiscordProcessing(): boolean {
  return discordProcessing;
}

// --- CLI -> Discord Forwarding ---
// Allows useHistoryManager to forward items to Discord

type DiscordForwarder = (item: HistoryItem) => void;
let discordForwarder: DiscordForwarder | undefined;

export function registerDiscordForwarder(fn: DiscordForwarder): void {
  discordForwarder = fn;
}

export function unregisterDiscordForwarder(): void {
  discordForwarder = undefined;
}

export function forwardToDiscord(item: HistoryItem): void {
  if (!discordProcessing && discordForwarder) {
    discordForwarder(item);
  }
}

// --- CLI Input Injection ---
// Allows DiscordService to inject slash commands into the CLI's submitQuery pipeline

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
 * Used for forwarding slash commands from Discord to the CLI command processor.
 * Returns true if the callback is registered (CLI is ready), false otherwise.
 */
export function injectCliInput(input: string): boolean {
  if (cliInputCallback) {
    cliInputCallback(input);
    return true;
  }
  return false;
}
