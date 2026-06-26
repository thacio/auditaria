/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * WEB_INTERFACE_FEATURE: Tiny singleton bridge so CLI hooks can learn whether
 * a web client is connected and ask the connected web client(s) to surface the
 * live Claude terminal — WITHOUT importing WebInterfaceService (which would
 * couple React hooks to the web server and risk import cycles). Mirrors the
 * `claudePtyMirror` singleton pattern.
 *
 * Used by the Claude provider's AskUserQuestion handling: when the web
 * interface is in use, the interactive-prompt modal (which auto-drives Claude's
 * picker via respondToPrompt) fights the user's manual input in the live web
 * terminal. Instead we suppress the modal and route the question to the
 * terminal — opening it if it's currently closed.
 *
 * WebInterfaceService registers the open-terminal broadcaster on start and
 * clears it on stop; it keeps the client count current on every connect /
 * disconnect.
 */
class WebTerminalBridge {
  private clientCount = 0;
  private openTerminal: (() => void) | null = null;

  /** Keep the connected-client count current (called on connect/disconnect). */
  setClientCount(n: number): void {
    this.clientCount = Math.max(0, n);
  }

  /**
   * Register the broadcaster that asks web clients to open the live Claude
   * terminal. Set on server start; pass null on stop. Its presence also doubles
   * as "the web server is running".
   */
  setOpenTerminalHandler(fn: (() => void) | null): void {
    this.openTerminal = fn;
  }

  /** True when a web server is running with at least one connected client. */
  hasConnectedClients(): boolean {
    return this.clientCount > 0 && this.openTerminal !== null;
  }

  /** Ask connected web clients to surface the live Claude terminal. */
  requestOpenTerminal(): void {
    this.openTerminal?.();
  }
}

export const webTerminalBridge = new WebTerminalBridge();
