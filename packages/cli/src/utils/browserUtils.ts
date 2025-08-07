/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import { spawn } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Opens a URL in the default browser in a cross-platform way
 * @param url - The URL to open
 * @returns Promise that resolves if successful, rejects if failed
 */
export async function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const currentPlatform = platform();
    let command: string;
    let args: string[];

    switch (currentPlatform) {
      case 'darwin': // macOS
        command = 'open';
        args = [url];
        break;
      case 'win32': // Windows
        command = 'cmd';
        args = ['/c', 'start', '""', url];
        break;
      default: // Linux and other Unix-like systems
        command = 'xdg-open';
        args = [url];
        break;
    }

    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    });

    child.on('error', (error) => {
      reject(new Error(`Failed to open browser: ${error.message}`));
    });

    child.on('spawn', () => {
      // Process spawned successfully
      child.unref(); // Allow the parent process to exit
      resolve();
    });

    // Fallback timeout in case spawn event doesn't fire
    setTimeout(() => {
      if (!child.killed) {
        child.unref();
        resolve();
      }
    }, 1000);
  });
}

/**
 * Opens a browser with a delay to allow server to start
 * @param url - The URL to open
 * @param delayMs - Delay in milliseconds before opening (default: 1000ms)
 * @returns Promise that resolves after attempting to open browser
 */
export async function openBrowserWithDelay(url: string, delayMs: number = 1000): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(async () => {
      try {
        await openBrowser(url);
        resolve();
      } catch (error) {
        // We resolve even if browser opening fails, as this is not critical
        resolve();
      }
    }, delayMs);
  });
}