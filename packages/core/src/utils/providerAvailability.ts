/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_PROVIDER_AVAILABILITY: Utility to check if external LLM providers are installed

import { spawn } from 'node:child_process';

export interface ProviderAvailability {
  claude: boolean;
  codex: boolean;
}

/**
 * Check if a command is available by running it with --version
 * @param command Command to check (e.g., 'claude', 'codex')
 * @param timeout Timeout in milliseconds (default: 5000)
 * @returns Promise that resolves to true if command is available
 */
async function isCommandAvailable(
  command: string,
  timeout: number = 5000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], {
      shell: true,
      stdio: 'ignore', // Suppress output
      windowsHide: true, // Hide console window on Windows
    });

    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, timeout);

    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      // Exit code 0 means success
      resolve(code === 0);
    });
  });
}

/**
 * Check availability of all external LLM providers
 * @returns Promise that resolves to an object with availability status for each provider
 */
export async function checkProviderAvailability(): Promise<ProviderAvailability> {
  const [claude, codex] = await Promise.all([
    isCommandAvailable('claude'),
    isCommandAvailable('codex'),
  ]);

  return { claude, codex };
}

/**
 * Get user-friendly install message for a provider
 * @param provider Provider name ('claude' or 'codex')
 * @returns Install instruction message
 */
export function getProviderInstallMessage(provider: 'claude' | 'codex'): string {
  if (provider === 'claude') {
    return 'To use Claude Code, install it from https://docs.anthropic.com/en/docs/claude-code, then run `claude` to authenticate.';
  }
  if (provider === 'codex') {
    return 'To use OpenAI Codex, install it from https://www.npmjs.com/package/@openai/codex, then run `codex` to authenticate.';
  }
  return 'Provider not available. Please install and authenticate.';
}
