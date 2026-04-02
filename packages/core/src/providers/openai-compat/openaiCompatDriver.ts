/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_OPENAI_COMPAT: Generic OpenAI-compatible provider driver

import type {
  ProviderDriver,
  ProviderEvent,
} from '../types.js';
import { ProviderEventType } from '../types.js';
import type { OpenAICompatDriverConfig } from './types.js';
import { MAX_RETRIES } from './types.js';
import { parseOpenAISSEStream } from './sseParser.js';

/**
 * A provider driver that talks to any OpenAI-compatible API endpoint.
 * Supports streaming via SSE, bearer/header auth, and retry with backoff.
 *
 * This is a text-only pipe: prompt in, text out. No tool execution.
 * Auditaria handles all agent logic (tools, file editing, context management).
 */
export class OpenAICompatDriver implements ProviderDriver {
  private abortController: AbortController | null = null;
  readonly canResume = false;

  constructor(private readonly config: OpenAICompatDriverConfig) {}

  async *sendMessage(
    prompt: string,
    signal: AbortSignal,
    systemContext?: string,
  ): AsyncGenerator<ProviderEvent> {
    // Build messages array
    const messages: Array<{ role: string; content: string }> = [];
    if (systemContext) {
      messages.push({ role: 'system', content: systemContext });
    }
    messages.push({ role: 'user', content: prompt });

    // Build request body
    const body = JSON.stringify({
      model: this.config.model,
      messages,
      stream: true,
    });

    const url = this.config.baseUrl + this.config.completionsPath;
    const headers = this.buildHeaders();

    // Yield model info
    yield {
      type: ProviderEventType.ModelInfo,
      model: `${this.config.providerName}: ${this.config.model}`,
    };

    // Fetch with retry
    let response: Response;
    try {
      response = await this.fetchWithRetry(url, {
        method: 'POST',
        headers,
        body,
        signal,
      });
    } catch (e) {
      if (signal.aborted) return;
      const message = e instanceof Error ? e.message : 'Connection failed';
      yield { type: ProviderEventType.Error, message };
      return;
    }

    // Handle non-OK responses
    if (!response.ok) {
      // Status 499 = user abort (Continue.dev pattern)
      if (response.status === 499) return;

      let errorMessage = `${this.config.providerName} API error: ${response.status}`;
      try {
        const errorBody = await response.text();
        const parsed = JSON.parse(errorBody) as { error?: { message?: string } };
        if (parsed.error?.message) {
          errorMessage = parsed.error.message;
        }
      } catch { /* use default message */ }

      yield {
        type: ProviderEventType.Error,
        message: errorMessage,
        status: response.status,
      };
      return;
    }

    // Check for non-streaming response (some providers ignore stream:true on errors)
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream') && !contentType.includes('application/x-ndjson')) {
      // JSON response — not streaming
      try {
        const json = await response.json() as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const content = json.choices?.[0]?.message?.content;
        if (content) {
          yield { type: ProviderEventType.Content, text: content };
        }
        yield {
          type: ProviderEventType.Finished,
          usage: {
            inputTokens: json.usage?.prompt_tokens,
            outputTokens: json.usage?.completion_tokens,
          },
        };
      } catch {
        yield { type: ProviderEventType.Error, message: 'Failed to parse response' };
      }
      return;
    }

    // Stream SSE response
    if (!response.body) {
      yield { type: ProviderEventType.Error, message: 'No response body' };
      return;
    }

    yield* parseOpenAISSEStream(response.body, this.config.model);
  }

  async interrupt(): Promise<void> {
    this.abortController?.abort();
  }

  getSessionId(): string | undefined {
    return undefined; // Stateless — no session persistence
  }

  resetSession(): void {
    // Stateless — nothing to reset
  }

  dispose(): void {
    this.abortController?.abort();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Apply auth
    switch (this.config.auth.type) {
      case 'bearer':
        headers['Authorization'] = `Bearer ${this.config.auth.token}`;
        break;
      case 'header':
        headers[this.config.auth.name] = this.config.auth.value;
        break;
      case 'none':
        break;
    }

    // Apply custom headers
    if (this.config.headers) {
      Object.assign(headers, this.config.headers);
    }

    return headers;
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    maxRetries: number = MAX_RETRIES,
  ): Promise<Response> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const fetchOptions: RequestInit = { ...options };

        // TLS configuration
        if (this.config.tls?.rejectUnauthorized === false) {
          // Node.js fetch doesn't support this directly — handled via NODE_TLS_REJECT_UNAUTHORIZED env
          // For production, users should set this env var
        }

        const response = await fetch(url, fetchOptions);

        // Retry on 429 (rate limit)
        if (response.status === 429 && attempt < maxRetries - 1) {
          const retryAfter = response.headers.get('retry-after');
          const waitMs = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : 1000 * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }

        // Retry on 5xx
        if (response.status >= 500 && attempt < maxRetries - 1) {
          await new Promise((r) =>
            setTimeout(r, 1000 * Math.pow(2, attempt)),
          );
          continue;
        }

        return response;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (options.signal && (options.signal as AbortSignal).aborted) {
          throw lastError;
        }
        if (attempt < maxRetries - 1) {
          await new Promise((r) =>
            setTimeout(r, 1000 * Math.pow(2, attempt)),
          );
        }
      }
    }

    throw lastError || new Error(`Failed after ${maxRetries} attempts`);
  }
}
