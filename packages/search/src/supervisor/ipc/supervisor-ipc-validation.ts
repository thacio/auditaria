/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChildToMainMessage,
  MainToChildMessage,
} from './supervisor-ipc-types.js';
import {
  type Guard,
  anyOf,
  objectOf,
  oneOf,
  isNumber,
  isString,
  isBoolean,
  optional,
  isUnknown,
  arrayOf,
} from '../../core/validation.js';
import { isPartialSearchConfig } from '../../config/config-validation.js';

export const isChildToMainMessage: Guard<ChildToMainMessage> = anyOf(
  objectOf({ type: oneOf('supervisor_ready'), memoryUsageMb: isNumber }),
  objectOf({
    type: oneOf('supervisor_result'),
    id: isString,
    success: isBoolean,
    result: optional(isUnknown),
    error: optional(isString),
  }),
  objectOf({
    type: oneOf('supervisor_event'),
    event: isString,
    data: isUnknown,
  }),
  objectOf({
    type: oneOf('supervisor_memory'),
    memoryUsageMb: isNumber,
    heapUsedMb: isNumber,
    heapTotalMb: isNumber,
  }),
  objectOf({
    type: oneOf('supervisor_error'),
    id: optional(isString),
    error: isString,
    fatal: isBoolean,
  }),
  objectOf({
    type: oneOf('supervisor_pong'),
    id: isString,
    memoryUsageMb: isNumber,
  }),
  objectOf({ type: oneOf('supervisor_shutting_down'), id: isString }),
);

export const isMainToChildMessage: Guard<MainToChildMessage> = anyOf(
  objectOf({
    type: oneOf('supervisor_init'),
    id: isString,
    rootPath: isString,
    databasePath: isString,
    config: isPartialSearchConfig,
  }),
  objectOf({
    type: oneOf('supervisor_call'),
    id: isString,
    method: isString,
    args: arrayOf(isUnknown),
  }),
  objectOf({ type: oneOf('supervisor_shutdown'), id: isString }),
  objectOf({ type: oneOf('supervisor_ping'), id: isString }),
);
