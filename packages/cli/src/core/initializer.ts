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
  checkProviderAvailability, // AUDITARIA_PROVIDER_AVAILABILITY
} from '@google/gemini-cli-core';
import { type LoadedSettings } from '../config/settings.js';
import { performInitialAuth } from './auth.js';
import { validateTheme } from './theme.js';
import { registerCleanup } from '../utils/cleanup.js';
import type { AccountSuspensionInfo } from '../ui/contexts/UIStateContext.js';

// AUDITARIA_LOCAL_SEARCH: Auto-start search service function
async function autoStartSearchService(config: Config): Promise<void> {
  try {
    const { searchDatabaseExists } = await import('@thacio/auditaria-search');
    const { getSearchService } = await import('@google/gemini-cli-core');

    const rootPath = config.getTargetDir();

    const service = getSearchService();

    // AUDITARIA_GEMINI_EMBEDDINGS_START: Wire ContentGenerator for Gemini embeddings
    // Always set on the singleton so any later start() (e.g. /knowledge-base init) sees it
    try {
      const contentGenerator = config.getContentGenerator();
      if (contentGenerator) {
        service.setEmbedFunction(
          async (texts: string[], model: string, outputDimensionality?: number) => {
            const response = await contentGenerator.embedContent({
              model,
              contents: texts,
              config: outputDimensionality ? { outputDimensionality } : undefined,
            });
            if (
              !response.embeddings ||
              response.embeddings.length !== texts.length
            ) {
              throw new Error(
                `Embedding API returned ${response.embeddings?.length ?? 0} results for ${texts.length} texts`,
              );
            }
            return response.embeddings.map((e) => {
              if (!e.values || e.values.length === 0) {
                throw new Error('Embedding API returned empty values');
              }
              return e.values;
            });
          },
        );
      }
    } catch {
      // Non-fatal — Gemini embeddings unavailable, local will be used
    }
    // AUDITARIA_GEMINI_EMBEDDINGS_END

    if (searchDatabaseExists(rootPath)) {
      // eslint-disable-next-line no-console
      console.log('[SearchService] Database found, auto-starting service...');

      // Register cleanup BEFORE starting to ensure it runs even if start fails partway
      registerCleanup(async () => {
        if (service.isRunning()) {
          // eslint-disable-next-line no-console
          console.log(
            '[SearchService] Stopping service for graceful shutdown...',
          );
          await service.stop();
        }
      });

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
  accountSuspensionInfo: AccountSuspensionInfo | null;
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
  const { authError, accountSuspensionInfo } = await performInitialAuth(
    config,
    settings.merged.security.auth.selectedType,
  );
  authHandle?.end();
  const themeError = validateTheme(settings);

  // AUDITARIA_PROVIDER_AVAILABILITY_START: Check external provider availability
  const providerHandle = startupProfiler.start('checkProviderAvailability');
  try {
    const availability = await checkProviderAvailability();
    config.setProviderAvailability(availability);
  } catch (error) {
    // Non-fatal - just log and continue with unavailable providers
    // eslint-disable-next-line no-console
    console.warn(
      '[ProviderAvailability] Check failed:',
      error instanceof Error ? error.message : String(error),
    );
  }
  providerHandle?.end();
  // AUDITARIA_PROVIDER_AVAILABILITY_END

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
    accountSuspensionInfo,
    themeError,
    shouldOpenAuthDialog,
    geminiMdFileCount: config.getGeminiMdFileCount(),
  };
}
