/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  IdeClient,
  IdeConnectionEvent,
  IdeConnectionType,
  logIdeConnection,
  type Config,
  StartSessionEvent,
  logCliConfiguration,
  startupProfiler,
} from '@google/gemini-cli-core';
import { type LoadedSettings } from '../config/settings.js';
import { performInitialAuth } from './auth.js';
import { validateTheme } from './theme.js';

// AUDITARIA_LOCAL_SEARCH: Auto-start search service function
async function autoStartSearchService(config: Config): Promise<void> {
  try {
    const { searchDatabaseExists } = await import('@thacio/auditaria-cli-search');
    const { getSearchService } = await import('@google/gemini-cli-core');

    const rootPath = config.getTargetDir();

    if (searchDatabaseExists(rootPath)) {
      // eslint-disable-next-line no-console
      console.log('[SearchService] Database found, auto-starting service...');
      const service = getSearchService();
      // Start in background - don't await to avoid blocking app startup
      service.start(rootPath).catch((err: Error) => {
        // eslint-disable-next-line no-console
        console.warn('[SearchService] Background start failed:', err.message);
      });
    }
  } catch (error) {
    // Non-fatal - just log and continue
    // eslint-disable-next-line no-console
    console.warn(
      '[SearchService] Auto-start failed:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export interface InitializationResult {
  authError: string | null;
  themeError: string | null;
  shouldOpenAuthDialog: boolean;
  geminiMdFileCount: number;
}

/**
 * Orchestrates the application's startup initialization.
 * This runs BEFORE the React UI is rendered.
 * @param config The application config.
 * @param settings The loaded application settings.
 * @returns The results of the initialization.
 */
export async function initializeApp(
  config: Config,
  settings: LoadedSettings,
): Promise<InitializationResult> {
  const authHandle = startupProfiler.start('authenticate');
  const authError = await performInitialAuth(
    config,
    settings.merged.security.auth.selectedType,
  );
  authHandle?.end();
  const themeError = validateTheme(settings);

  const shouldOpenAuthDialog =
    settings.merged.security.auth.selectedType === undefined || !!authError;

  logCliConfiguration(
    config,
    new StartSessionEvent(config, config.getToolRegistry()),
  );

  if (config.getIdeMode()) {
    const ideClient = await IdeClient.getInstance();
    await ideClient.connect();
    logIdeConnection(config, new IdeConnectionEvent(IdeConnectionType.START));
  }

  // AUDITARIA_LOCAL_SEARCH: Auto-start search service if database exists
  // Run in background to avoid blocking app startup
  autoStartSearchService(config).catch(() => {
    // Errors already logged in the function
  });

  return {
    authError,
    themeError,
    shouldOpenAuthDialog,
    geminiMdFileCount: config.getGeminiMdFileCount(),
  };
}
