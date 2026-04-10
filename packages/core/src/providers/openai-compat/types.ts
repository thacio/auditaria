/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_OPENAI_COMPAT: Types for the generic OpenAI-compatible provider

/**
 * Authentication configuration for a custom provider.
 */
export type ProviderAuthConfig =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'header'; name: string; value: string };

/**
 * Model configuration within a custom provider.
 */
export interface ProviderModelConfig {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/**
 * A custom provider entry from ~/.auditaria/providers.json
 */
export interface CustomProviderConfig {
  id: string;
  name: string;
  type: 'openai-compatible';
  baseUrl: string;
  completionsPath?: string; // Default: /chat/completions
  auth: ProviderAuthConfig;
  models: ProviderModelConfig[];
  defaultModel?: string;
  headers?: Record<string, string>;
  startCommand?: string;
  healthCheck?: string;
  tls?: { rejectUnauthorized?: boolean };
  timeout?: { connectMs?: number; readMs?: number };
}

/**
 * The providers.json file schema.
 */
export interface ProvidersFile {
  providers: CustomProviderConfig[];
}

/**
 * Runtime config passed to the OpenAI-compat driver.
 */
export interface OpenAICompatDriverConfig {
  providerId: string;
  providerName: string;
  baseUrl: string;
  completionsPath: string;
  model: string;
  auth: ProviderAuthConfig;
  headers: Record<string, string>;
  contextWindow: number;
  tls?: { rejectUnauthorized?: boolean };
  timeout: { connectMs: number; readMs: number };
}

/**
 * An SSE chunk from an OpenAI-compatible /chat/completions stream.
 */
export interface OpenAISSEChunk {
  id?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null; // DeepSeek-style reasoning tokens
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export const DEFAULT_COMPLETIONS_PATH = '/chat/completions';
export const DEFAULT_CONTEXT_WINDOW = 128000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 30000;
export const DEFAULT_READ_TIMEOUT_MS = 120000;
export const MAX_RETRIES = 3;
