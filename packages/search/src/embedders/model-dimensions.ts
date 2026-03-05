/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared model dimensions lookup.
// Single source of truth for known model → dimension mappings.

/** Known model dimensions by model ID */
export const MODEL_DIMENSIONS: Record<string, number> = {
  'Xenova/multilingual-e5-small': 384,
  'Xenova/multilingual-e5-base': 768,
  'Xenova/multilingual-e5-large': 1024,
  'Xenova/all-MiniLM-L6-v2': 384,
  'Xenova/all-mpnet-base-v2': 768,
};

/** Default model ID */
export const DEFAULT_MODEL_ID = 'Xenova/multilingual-e5-small';

/** Default dimensions (for the default model) */
export const DEFAULT_DIMENSIONS = 384;

/**
 * Get the known dimensions for a model ID.
 * Returns undefined for unknown/custom models.
 */
export function getModelDimensions(modelId: string): number | undefined {
  return MODEL_DIMENSIONS[modelId];
}
