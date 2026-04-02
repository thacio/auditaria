/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_OPENAI_COMPAT: Generic OpenAI-compatible provider

export { OpenAICompatDriver } from './openaiCompatDriver.js';
export { OpenAICompatContentGenerator } from './openaiCompatContentGenerator.js';
export {
  loadCustomProviders,
  buildDriverConfig,
  getCustomProviderContextWindow,
} from './configLoader.js';
export type {
  CustomProviderConfig,
  ProviderModelConfig,
  OpenAICompatDriverConfig,
} from './types.js';
