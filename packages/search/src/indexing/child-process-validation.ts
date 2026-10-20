/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChildToMainMessage,
  MainToChildMessage,
} from './child-process-types.js';
import {
  type Guard,
  anyOf,
  objectOf,
  oneOf,
  isNumber,
  isUnknown,
  isString,
  isBoolean,
  optional,
  arrayOf,
} from '../core/validation.js';
import { isPartialSearchConfig } from '../config/config-validation.js';

export const isChildToMainMessage: Guard<ChildToMainMessage> = anyOf(
  objectOf({ type: oneOf('ready'), memoryUsageMb: isNumber }),
  objectOf({
    type: oneOf('progress'),
    event: oneOf(
      'document:started',
      'document:completed',
      'document:failed',
      'sync:completed',
      'indexing:progress',
    ),
    data: isUnknown,
    memoryUsageMb: isNumber,
    processed: isNumber,
    total: isNumber,
  }),
  objectOf({
    type: oneOf('batch_complete'),
    id: isString,
    stats: objectOf({
      processed: isNumber,
      failed: isNumber,
      duration: isNumber,
      memoryUsageMb: isNumber,
    }),
    hasMore: isBoolean,
  }),
  objectOf({
    type: oneOf('error'),
    id: optional(isString),
    error: isString,
    fatal: isBoolean,
  }),
  objectOf({ type: oneOf('pong'), id: isString, memoryUsageMb: isNumber }),
);

export const isMainToChildMessage: Guard<MainToChildMessage> = anyOf(
  objectOf({
    type: oneOf('start_indexing'),
    id: isString,
    rootPath: isString,
    databasePath: isString,
    config: isPartialSearchConfig,
    options: objectOf({
      force: optional(isBoolean),
      resume: optional(isBoolean),
      maxDocuments: optional(isNumber),
      filePaths: optional(arrayOf(isString)),
    }),
  }),
  objectOf({ type: oneOf('shutdown'), id: isString }),
  objectOf({ type: oneOf('ping'), id: isString }),
);
