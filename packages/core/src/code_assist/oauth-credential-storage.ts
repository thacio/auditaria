/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type Credentials } from 'google-auth-library';
import { HybridTokenStorage } from '../mcp/token-storage/hybrid-token-storage.js';
import { OAUTH_FILE } from '../config/storage.js';
import type { OAuthCredentials } from '../mcp/token-storage/types.js';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { GEMINI_DIR, homedir } from '../utils/paths.js';
import { AUDITARIA_DIR } from '../utils/paths.js'; // AUDITARIA: Also import AUDITARIA_DIR
import { coreEvents } from '../utils/events.js';

const KEYCHAIN_SERVICE_NAME = 'gemini-cli-oauth';
const MAIN_ACCOUNT_KEY = 'main-account';

export class OAuthCredentialStorage {
  private static storage: HybridTokenStorage = new HybridTokenStorage(
    KEYCHAIN_SERVICE_NAME,
  );

  /**
   * Load cached OAuth credentials
   */
  static async loadCredentials(): Promise<Credentials | null> {
    try {
      const credentials = await this.storage.getCredentials(MAIN_ACCOUNT_KEY);

      if (credentials?.token) {
        const { accessToken, refreshToken, expiresAt, tokenType, scope } =
          credentials.token;
        // Convert from OAuthCredentials format to Google Credentials format
        const googleCreds: Credentials = {
          access_token: accessToken,
          refresh_token: refreshToken || undefined,
          token_type: tokenType || undefined,
          scope: scope || undefined,
        };

        if (expiresAt) {
          googleCreds.expiry_date = expiresAt;
        }

        return googleCreds;
      }

      // Fallback: Try to migrate from old file-based storage
      return await this.migrateFromFileStorage();
    } catch (error: unknown) {
      coreEvents.emitFeedback(
        'error',
        'Failed to load OAuth credentials',
        error,
      );
      throw new Error('Failed to load OAuth credentials', { cause: error });
    }
  }

  /**
   * Save OAuth credentials
   */
  static async saveCredentials(credentials: Credentials): Promise<void> {
    if (!credentials.access_token) {
      throw new Error('Attempted to save credentials without an access token.');
    }

    // Convert Google Credentials to OAuthCredentials format
    const mcpCredentials: OAuthCredentials = {
      serverName: MAIN_ACCOUNT_KEY,
      token: {
        accessToken: credentials.access_token,
        refreshToken: credentials.refresh_token || undefined,
        tokenType: credentials.token_type || 'Bearer',
        scope: credentials.scope || undefined,
        expiresAt: credentials.expiry_date || undefined,
      },
      updatedAt: Date.now(),
    };

    await this.storage.setCredentials(mcpCredentials);
  }

  /**
   * Clear cached OAuth credentials
   */
  static async clearCredentials(): Promise<void> {
    try {
      await this.storage.deleteCredentials(MAIN_ACCOUNT_KEY);

      // AUDITARIA_MODIFY_START: Try to remove old files from both directories
      const auditariaFilePath = path.join(homedir(), AUDITARIA_DIR, OAUTH_FILE);
      // const geminiFilePath = path.join(homedir(), GEMINI_DIR, OAUTH_FILE);
      await fs.rm(auditariaFilePath, { force: true }).catch(() => {});
      // await fs.rm(geminiFilePath, { force: true }).catch(() => {});
      // AUDITARIA_MODIFY_ENDS
    } catch (error: unknown) {
      coreEvents.emitFeedback(
        'error',
        'Failed to clear OAuth credentials',
        error,
      );
      throw new Error('Failed to clear OAuth credentials', { cause: error });
    }
  }

  /**
   * Migrate credentials from old file-based storage to keychain
   * AUDITARIA: Check .auditaria directory first, then fallback to .gemini
   */
  private static async migrateFromFileStorage(): Promise<Credentials | null> {
    // AUDITARIA_MODIFY_START: Try .auditaria directory first (our fork's location)
    const auditariaFilePath = path.join(homedir(), AUDITARIA_DIR, OAUTH_FILE);
    const geminiFilePath = path.join(homedir(), GEMINI_DIR, OAUTH_FILE);

    let credsJson: string | null = null;
    let usedFilePath: string | null = null;

    // Try .auditaria first
    try {
      credsJson = await fs.readFile(auditariaFilePath, 'utf-8');
      usedFilePath = auditariaFilePath;
    } catch (error: unknown) {
      if (
        !(
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        )
      ) {
        // Non-ENOENT errors should propagate
        throw error;
      }
      // File doesn't exist in .auditaria, try .gemini
    }

    // Fallback to .gemini if not found in .auditaria
    if (!credsJson) {
      try {
        credsJson = await fs.readFile(geminiFilePath, 'utf-8');
        usedFilePath = geminiFilePath;
        // AUDITARIA_MODIFY_END
      } catch (error: unknown) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          // File doesn't exist in either location
          return null;
        }
        // Other read errors should propagate.
        throw error;
      } // AUDITARIA ADDITION
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const credentials: Credentials = JSON.parse(credsJson);

    // Save to new storage
    await this.saveCredentials(credentials);

    // Remove old file after successful migration
    // AUDITARIA_MODIFY_START
    if (usedFilePath) {
      await fs.rm(usedFilePath, { force: true }).catch(() => {});
    }
    // AUDITARIA_MODIFY_END

    return credentials;
  }
}
