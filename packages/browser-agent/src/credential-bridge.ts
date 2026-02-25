/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

/**
 * Credential Bridge for Browser Agent
 *
 * This module provides credential resolution that mimics Auditaria's auth system.
 * It supports all auth types: API key, Vertex AI, OAuth (free and paid tiers).
 */

import { OAuth2Client, type Credentials } from 'google-auth-library';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  loadApiKey,
  AuthType,
  setupUser,
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  homedir as getHomedir,
  type UserData,
  type Config,
} from '@google/gemini-cli-core';

// Keychain constants (same as OAuthCredentialStorage uses)
const KEYCHAIN_SERVICE_NAME = 'gemini-cli-oauth';
const MAIN_ACCOUNT_KEY = 'main-account';

// File storage constants (default storage location)
const OAUTH_FILE = 'oauth_creds.json';
const AUDITARIA_DIR = '.auditaria';
const GEMINI_DIR = '.gemini';

/**
 * Credential types for Stagehand
 */
export type CredentialMode = 'gemini' | 'vertexai' | 'oauth-vertexai';

export interface StagehandCredentials {
  mode: CredentialMode;
  apiKey?: string;
  authClient?: OAuth2Client;
  project?: string;
  location?: string;
}

/**
 * Error thrown when credentials cannot be resolved
 */
export class CredentialBridgeError extends Error {
  constructor(
    message: string,
    readonly authType?: AuthType,
  ) {
    super(message);
    this.name = 'CredentialBridgeError';
  }
}

/**
 * Credential Bridge
 *
 * Resolves credentials matching what Auditaria is currently using.
 * This ensures browser-agent uses the same authentication as the main app.
 */
export class CredentialBridge {
  /**
   * Get credentials based on Auditaria's current auth configuration
   */
  static async getCredentials(config: Config): Promise<StagehandCredentials> {
    const cgConfig = config.getContentGeneratorConfig();
    const authType = cgConfig.authType;

    switch (authType) {
      case AuthType.USE_GEMINI:
        return this.getGeminiCredentials(cgConfig);

      case AuthType.USE_VERTEX_AI:
        return this.getVertexAICredentials(cgConfig);

      case AuthType.LOGIN_WITH_GOOGLE:
      case AuthType.COMPUTE_ADC:
        return this.getOAuthCredentials();

      default:
        throw new CredentialBridgeError(
          `Unsupported auth type for browser agent: ${authType}`,
          authType,
        );
    }
  }

  /**
   * Get credentials for USE_GEMINI (API key) auth type
   */
  private static async getGeminiCredentials(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cgConfig: any,
  ): Promise<StagehandCredentials> {
    // Priority: config > stored key > env var
    const apiKey =
      cgConfig.apiKey || (await loadApiKey()) || process.env.GEMINI_API_KEY;

    if (!apiKey) {
      throw new CredentialBridgeError(
        'No Gemini API key found. Please set GEMINI_API_KEY or authenticate with API key.',
        AuthType.USE_GEMINI,
      );
    }

    return { mode: 'gemini', apiKey };
  }

  /**
   * Get credentials for USE_VERTEX_AI auth type
   */
  private static async getVertexAICredentials(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cgConfig: any,
  ): Promise<StagehandCredentials> {
    const project =
      process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
    const location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';

    if (!project) {
      throw new CredentialBridgeError(
        'GOOGLE_CLOUD_PROJECT environment variable is required for Vertex AI.',
        AuthType.USE_VERTEX_AI,
      );
    }

    return {
      mode: 'vertexai',
      apiKey: cgConfig.apiKey,
      project,
      location,
    };
  }

  /**
   * Get credentials for LOGIN_WITH_GOOGLE or COMPUTE_ADC auth types
   *
   * This uses OAuth credentials stored by Auditaria and calls setupUser()
   * to get the project ID (works for both FREE and STANDARD tiers).
   */
  private static async getOAuthCredentials(): Promise<StagehandCredentials> {
    // Try to load credentials from keychain first (encrypted storage),
    // then fall back to file (default storage).
    // No expiry checks - OAuth2Client handles token refresh.
    let credentials = await this.loadCredentialsFromKeychain();

    if (!credentials) {
      credentials = await this.loadCredentialsFromFile();
    }

    if (!credentials) {
      throw new CredentialBridgeError(
        'No OAuth credentials found. Please login with "auditaria" first.',
        AuthType.LOGIN_WITH_GOOGLE,
      );
    }

    // Create OAuth2Client (same as Auditaria does)
    const client = new OAuth2Client({
      clientId: OAUTH_CLIENT_ID,
      clientSecret: OAUTH_CLIENT_SECRET,
    });
    client.setCredentials(credentials);

    // Get project ID by calling setupUser (same as Auditaria does)
    // This works for both FREE tier (Google-managed project) and
    // STANDARD tier (user's project from env var)
    let userData: UserData;
    try {
      /* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- OAuth2Client satisfies AuthClient, diff package versions */
      userData = await setupUser(
        client as unknown as Parameters<typeof setupUser>[0],
      );
      /* eslint-enable @typescript-eslint/no-unsafe-type-assertion */
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CredentialBridgeError(
        `Failed to get project info from Google: ${message}. ` +
          'Please ensure you are logged in with "auditaria".',
        AuthType.LOGIN_WITH_GOOGLE,
      );
    }

    return {
      mode: 'oauth-vertexai',
      authClient: client,
      project: userData.projectId,
      location: 'us-central1',
    };
  }

  /**
   * Load credentials directly from keychain.
   *
   * We read directly from keychain without any expiry checks.
   * Our job is just to pass credentials to OAuth2Client, which handles
   * token refresh automatically using the refresh_token.
   */
  private static async loadCredentialsFromKeychain(): Promise<Credentials | null> {
    try {
      // Dynamically import keytar (same as KeychainTokenStorage does)
      // @ts-ignore -- keytar is an optional native module resolved from core's dependencies at runtime
      const keytar = await import('keytar');
      const keytarModule = keytar.default || keytar;

      // Read raw data from keychain (no expiry check)
      const data = await keytarModule.getPassword(
        KEYCHAIN_SERVICE_NAME,
        MAIN_ACCOUNT_KEY,
      );

      if (!data) {
        return null;
      }

      // Parse the stored OAuthCredentials format
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse
      const storedCreds = JSON.parse(data) as unknown as {
        token: {
          accessToken: string;
          refreshToken?: string;
          tokenType?: string;
          scope?: string;
          expiresAt?: number;
        };
      };

      if (!storedCreds.token) {
        return null;
      }

      // Convert to Google Credentials format (same as OAuthCredentialStorage does)
      const credentials: Credentials = {
        access_token: storedCreds.token.accessToken,
        refresh_token: storedCreds.token.refreshToken || undefined,
        token_type: storedCreds.token.tokenType || undefined,
        scope: storedCreds.token.scope || undefined,
      };

      if (storedCreds.token.expiresAt) {
        credentials.expiry_date = storedCreds.token.expiresAt;
      }

      return credentials;
    } catch {
      // Keychain not available or other error - return null to let caller handle
      return null;
    }
  }

  /**
   * Load credentials from file (default storage location).
   *
   * By default (without GEMINI_FORCE_ENCRYPTED_FILE), Auditaria stores
   * credentials in ~/.auditaria/oauth_creds.json or ~/.gemini/oauth_creds.json.
   */
  private static async loadCredentialsFromFile(): Promise<Credentials | null> {
    const homedir = getHomedir();
    const pathsToTry = [
      path.join(homedir, AUDITARIA_DIR, OAUTH_FILE),
      path.join(homedir, GEMINI_DIR, OAUTH_FILE),
    ];

    for (const filePath of pathsToTry) {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON.parse
        const credentials = JSON.parse(content) as unknown as Credentials;
        return credentials;
      } catch {
        // File doesn't exist or can't be read, try next path
        continue;
      }
    }

    return null;
  }
}
