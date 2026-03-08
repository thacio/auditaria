/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_TEAMS_FEATURE: This entire file is part of the Teams integration
//
// Bridge for CLI <-> Teams display sync.
// Avoids circular dependencies by providing module-level callback storage
// that both TeamsService and React hooks can access.

import type { HistoryItemWithoutId, HistoryItem } from '../../ui/types.js';

// --- CLI Display Bridge ---
// Allows TeamsService to push items to CLI's useHistoryManager

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

// --- Teams Processing Flag ---
// When true, items added to CLI display by Teams are NOT forwarded back to Teams (prevents echo)

let teamsProcessing = false;

export function setTeamsProcessing(value: boolean): void {
  teamsProcessing = value;
}

export function isTeamsProcessing(): boolean {
  return teamsProcessing;
}

// --- CLI -> Teams Forwarding ---
// Allows useHistoryManager to forward items to Teams

type TeamsForwarder = (item: HistoryItem) => void;
let teamsForwarder: TeamsForwarder | undefined;

export function registerTeamsForwarder(fn: TeamsForwarder): void {
  teamsForwarder = fn;
}

export function unregisterTeamsForwarder(): void {
  teamsForwarder = undefined;
}

export function forwardToTeams(item: HistoryItem): void {
  if (!teamsProcessing && teamsForwarder) {
    teamsForwarder(item);
  }
}

// --- CLI Input Injection ---
// Allows TeamsService to inject slash commands into the CLI's submitQuery pipeline

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
 * Used for forwarding slash commands from Teams to the CLI command processor.
 * Returns true if the callback is registered (CLI is ready), false otherwise.
 */
export function injectCliInput(input: string): boolean {
  if (cliInputCallback) {
    cliInputCallback(input);
    return true;
  }
  return false;
}
