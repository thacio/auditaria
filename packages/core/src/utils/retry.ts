/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentResponse } from '@google/genai';
import { ApiError } from '@google/genai';
import { AuthType } from '../core/contentGenerator.js';
import {
  isProQuotaExceededError,
  isGenericQuotaExceededError,
} from './quotaErrorDetection.js';
import { delay, createAbortError } from './delay.js';
import { debugLogger } from './debugLogger.js';

const FETCH_FAILED_MESSAGE =
  'exception TypeError: fetch failed sending request';

export interface HttpError extends Error {
  status?: number;
}

export interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  shouldRetryOnError: (error: Error, retryFetchErrors?: boolean) => boolean;
  shouldRetryOnContent?: (content: GenerateContentResponse) => boolean;
  onPersistent429?: (
    authType?: string,
    error?: unknown,
  ) => Promise<string | boolean | null>;
  authType?: string;
  retryFetchErrors?: boolean;
  useImprovedFallbackStrategy?: boolean;
  disableFallbackForSession?: boolean;
  signal?: AbortSignal;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 5,
  initialDelayMs: 5000,
  maxDelayMs: 30000, // 30 seconds
  shouldRetryOnError: defaultShouldRetry,
};

/**
 * Default predicate function to determine if a retry should be attempted.
 * Retries on 429 (Too Many Requests) and 5xx server errors.
 * @param error The error object.
 * @param retryFetchErrors Whether to retry on specific fetch errors.
 * @returns True if the error is a transient error, false otherwise.
 */
function defaultShouldRetry(
  error: Error | unknown,
  retryFetchErrors?: boolean,
): boolean {
  if (
    retryFetchErrors &&
    error instanceof Error &&
    error.message.includes(FETCH_FAILED_MESSAGE)
  ) {
    return true;
  }

  // Priority check for ApiError
  if (error instanceof ApiError) {
    // Explicitly do not retry 400 (Bad Request)
    if (error.status === 400) return false;
    return error.status === 429 || (error.status >= 500 && error.status < 600);
  }

  // Check for status using helper (handles other error shapes)
  const status = getErrorStatus(error);
  if (status !== undefined) {
    return status === 429 || (status >= 500 && status < 600);
  }

  return false;
}

/**
 * Retries a function with exponential backoff and jitter.
 * @param fn The asynchronous function to retry.
 * @param options Optional retry configuration.
 * @returns A promise that resolves with the result of the function if successful.
 * @throws The last error encountered if all attempts fail.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>,
): Promise<T> {
  if (options?.signal?.aborted) {
    throw createAbortError();
  }

  if (options?.maxAttempts !== undefined && options.maxAttempts <= 0) {
    throw new Error('maxAttempts must be a positive number.');
  }

  const cleanOptions = options
    ? Object.fromEntries(Object.entries(options).filter(([_, v]) => v != null))
    : {};

  const {
    maxAttempts,
    initialDelayMs,
    maxDelayMs,
    onPersistent429,
    authType,
    shouldRetryOnError,
    shouldRetryOnContent,
    retryFetchErrors,
    signal,
  } = {
    ...DEFAULT_RETRY_OPTIONS,
    ...cleanOptions,
  };

  let attempt = 0;
  let currentDelay = initialDelayMs;
  let consecutive429Count = 0;

  while (attempt < maxAttempts) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    attempt++;
    try {
      const result = await fn();

      if (
        shouldRetryOnContent &&
        shouldRetryOnContent(result as GenerateContentResponse)
      ) {
        const jitter = currentDelay * 0.3 * (Math.random() * 2 - 1);
        const delayWithJitter = Math.max(0, currentDelay + jitter);
        await delay(delayWithJitter, signal);
        currentDelay = Math.min(maxDelayMs, currentDelay * 2);
        continue;
      }

      return result;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }

      const errorStatus = getErrorStatus(error);

      // Check for Pro quota exceeded error first - immediate fallback for OAuth users
      if (
        errorStatus === 429 &&
        authType === AuthType.LOGIN_WITH_GOOGLE &&
        isProQuotaExceededError(error) &&
        onPersistent429
      ) {
        try {
          const fallbackModel = await onPersistent429(authType, error);
          if (fallbackModel !== false && fallbackModel !== null) {
            // Reset attempt counter and try with new model
            attempt = 0;
            consecutive429Count = 0;
            currentDelay = initialDelayMs;
            // With the model updated, we continue to the next attempt
            continue;
          } else {
            // Fallback handler returned null/false, meaning don't continue - stop retry process
            throw error;
          }
        } catch (fallbackError) {
          // If fallback fails, continue with original error
          debugLogger.warn('Fallback to Flash model failed:', fallbackError);
        }
      }

      // Check for generic quota exceeded error (but not Pro, which was handled above) - immediate fallback for OAuth users
      if (
        errorStatus === 429 &&
        authType === AuthType.LOGIN_WITH_GOOGLE &&
        !isProQuotaExceededError(error) &&
        isGenericQuotaExceededError(error) &&
        onPersistent429
      ) {
        try {
          const fallbackModel = await onPersistent429(authType, error);
          if (fallbackModel !== false && fallbackModel !== null) {
            // Reset attempt counter and try with new model
            attempt = 0;
            consecutive429Count = 0;
            currentDelay = initialDelayMs;
            // With the model updated, we continue to the next attempt
            continue;
          } else {
            // Fallback handler returned null/false, meaning don't continue - stop retry process
            throw error;
          }
        } catch (fallbackError) {
          // If fallback fails, continue with original error
          debugLogger.warn('Fallback to Flash model failed:', fallbackError);
        }
      }

      // Track consecutive 429 errors
      if (errorStatus === 429) {
        consecutive429Count++;
      } else {
        consecutive429Count = 0;
      }

      // If we have persistent 429s and a fallback callback for OAuth
      if (
        consecutive429Count >= 2 &&
        onPersistent429 &&
        authType === AuthType.LOGIN_WITH_GOOGLE
      ) {
        try {
          const fallbackModel = await onPersistent429(authType, error);
          if (fallbackModel !== false && fallbackModel !== null) {
            // Reset attempt counter and try with new model
            attempt = 0;
            consecutive429Count = 0;
            currentDelay = initialDelayMs;
            // With the model updated, we continue to the next attempt
            continue;
          } else {
            // Fallback handler returned null/false, meaning don't continue - stop retry process
            throw error;
          }
        } catch (fallbackError) {
          // If fallback fails, continue with original error
          debugLogger.warn('Fallback to Flash model failed:', fallbackError);
        }
      }

      // Check if we've exhausted retries or shouldn't retry
      if (
        attempt >= maxAttempts ||
        !shouldRetryOnError(error as Error, retryFetchErrors)
      ) {
        throw error;
      }

      const { delayDurationMs, errorStatus: delayErrorStatus } =
        getDelayDurationAndStatus(error);

      if (delayDurationMs > 0) {
        // Respect Retry-After header if present and parsed
        debugLogger.warn(
          `Attempt ${attempt} failed with status ${delayErrorStatus ?? 'unknown'}. Retrying after explicit delay of ${delayDurationMs}ms...`,
          error,
        );
        await delay(delayDurationMs, signal);
        // Reset currentDelay for next potential non-429 error, or if Retry-After is not present next time
        currentDelay = initialDelayMs;
      } else {
        // Fall back to exponential backoff with jitter
        logRetryAttempt(attempt, error, errorStatus);
        // Add jitter: +/- 30% of currentDelay
        const jitter = currentDelay * 0.3 * (Math.random() * 2 - 1);
        const delayWithJitter = Math.max(0, currentDelay + jitter);
        await delay(delayWithJitter, signal);
        currentDelay = Math.min(maxDelayMs, currentDelay * 2);
      }
    }
  }
  // This line should theoretically be unreachable due to the throw in the catch block.
  // Added for type safety and to satisfy the compiler that a promise is always returned.
  throw new Error('Retry attempts exhausted');
}

/**
 * Extracts the HTTP status code from an error object.
 * @param error The error object.
 * @returns The HTTP status code, or undefined if not found.
 */
export function getErrorStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null) {
    if ('status' in error && typeof error.status === 'number') {
      return error.status;
    }
    // Check for error.response.status (common in axios errors)
    if (
      'response' in error &&
      typeof (error as { response?: unknown }).response === 'object' &&
      (error as { response?: unknown }).response !== null
    ) {
      const response = (
        error as { response: { status?: unknown; headers?: unknown } }
      ).response;
      if ('status' in response && typeof response.status === 'number') {
        return response.status;
      }
    }
  }
  return undefined;
}

/**
 * Extracts the Retry-After delay from an error object's headers.
 * @param error The error object.
 * @returns The delay in milliseconds, or 0 if not found or invalid.
 */
function getRetryAfterDelayMs(error: unknown): number {
  if (typeof error === 'object' && error !== null) {
    // Check for error.response.headers (common in axios errors)
    if (
      'response' in error &&
      typeof (error as { response?: unknown }).response === 'object' &&
      (error as { response?: unknown }).response !== null
    ) {
      const response = (error as { response: { headers?: unknown } }).response;
      if (
        'headers' in response &&
        typeof response.headers === 'object' &&
        response.headers !== null
      ) {
        const headers = response.headers as { 'retry-after'?: unknown };
        const retryAfterHeader = headers['retry-after'];
        if (typeof retryAfterHeader === 'string') {
          const retryAfterSeconds = parseInt(retryAfterHeader, 10);
          if (!isNaN(retryAfterSeconds)) {
            return retryAfterSeconds * 1000;
          }
          // It might be an HTTP date
          const retryAfterDate = new Date(retryAfterHeader);
          if (!isNaN(retryAfterDate.getTime())) {
            return Math.max(0, retryAfterDate.getTime() - Date.now());
          }
        }
      }
    }
  }
  return 0;
}

/**
 * Determines the delay duration based on the error, prioritizing Retry-After header.
 * @param error The error object.
 * @returns An object containing the delay duration in milliseconds and the error status.
 */
function getDelayDurationAndStatus(error: unknown): {
  delayDurationMs: number;
  errorStatus: number | undefined;
} {
  const errorStatus = getErrorStatus(error);
  let delayDurationMs = 0;

  if (errorStatus === 429) {
    delayDurationMs = getRetryAfterDelayMs(error);
  }
  return { delayDurationMs, errorStatus };
}

/**
 * Logs a message for a retry attempt when using exponential backoff.
 * @param attempt The current attempt number.
 * @param error The error that caused the retry.
 * @param errorStatus The HTTP status code of the error, if available.
 */
function logRetryAttempt(
  attempt: number,
  error: unknown,
  errorStatus?: number,
): void {
  let message = `Attempt ${attempt} failed. Retrying with backoff...`;
  if (errorStatus) {
    message = `Attempt ${attempt} failed with status ${errorStatus}. Retrying with backoff...`;
  }

  if (errorStatus === 429) {
    debugLogger.warn(message, error);
  } else if (errorStatus && errorStatus >= 500 && errorStatus < 600) {
    console.error(message, error);
  } else if (error instanceof Error) {
    // Fallback for errors that might not have a status but have a message
    if (error.message.includes('429')) {
      debugLogger.warn(
        `Attempt ${attempt} failed with 429 error (no Retry-After header). Retrying with backoff...`,
        error,
      );
    } else if (error.message.match(/5\d{2}/)) {
      console.error(
        `Attempt ${attempt} failed with 5xx error. Retrying with backoff...`,
        error,
      );
    } else {
      debugLogger.warn(message, error); // Default to warn for other errors
    }
  } else {
    debugLogger.warn(message, error); // Default to warn if error type is unknown
  }
}
