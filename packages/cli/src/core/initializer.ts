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

    // AUDITARIA_GEMINI_EMBEDDINGS_START: Wire Google AI Studio API key for Gemini embeddings
    // Uses the stored API key (persists in keychain even when user switches to OAuth).
    // Calls generativelanguage.googleapis.com directly — free tier, no Vertex AI needed.
    // Free tier: 100 RPM, 1000 RPD. We throttle to stay well within limits.
    try {
      const { loadApiKey } = await import('@google/gemini-cli-core');
      const apiKey = process.env['GEMINI_API_KEY'] || (await loadApiKey());
      if (apiKey) {
        // Per-request rate limiter (shared across all calls on this singleton)
        const requestTimestamps: number[] = [];
        const MAX_RPM = 80; // Stay under 100 RPM free tier limit

        service.setEmbedFunction(
          async (texts: string[], model: string, outputDimensionality?: number) => {
            const results: number[][] = [];
            for (const text of texts) {
              // Sliding window rate limiter — wait if approaching limit
              const now = Date.now();
              const windowStart = now - 60_000;
              // Remove timestamps older than 1 minute
              while (requestTimestamps.length > 0 && requestTimestamps[0] <= windowStart) {
                requestTimestamps.shift();
              }
              if (requestTimestamps.length >= MAX_RPM) {
                const waitMs = requestTimestamps[0] - windowStart + 100;
                await new Promise((r) => setTimeout(r, waitMs));
              }
              requestTimestamps.push(Date.now());

              const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`;
              const body: Record<string, unknown> = {
                content: { parts: [{ text }] },
              };
              if (outputDimensionality) {
                body.outputDimensionality = outputDimensionality;
              }
              const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              });
              if (!res.ok) {
                const errText = await res.text();
                // Retry once on 429 (rate limit) after waiting
                if (res.status === 429) {
                  await new Promise((r) => setTimeout(r, 5000));
                  const retry = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                  });
                  if (retry.ok) {
                    const retryData = (await retry.json()) as {
                      embedding?: { values?: number[] };
                    };
                    if (retryData.embedding?.values?.length) {
                      results.push(retryData.embedding.values);
                      continue;
                    }
                  }
                }
                throw new Error(
                  `Gemini embedding API error ${res.status}: ${errText.slice(0, 300)}`,
                );
              }
              const data = (await res.json()) as {
                embedding?: { values?: number[] };
              };
              if (!data.embedding?.values?.length) {
                throw new Error(
                  `Gemini embedding API returned no values for model=${model}`,
                );
              }
              results.push(data.embedding.values);
            }
            return results;
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
