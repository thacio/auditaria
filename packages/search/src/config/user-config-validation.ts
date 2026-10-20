/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import type { UserConfigFile } from './user-config.js';
import {
  type Guard,
  objectOf,
  optional,
  isString,
  anyOf,
  oneOf,
  isNumber,
} from '../core/validation.js';
import { isPartialSearchConfig } from './config-validation.js';

export const isUserConfigFile: Guard<UserConfigFile> = objectOf({
  $version: optional(isString),
  config: optional(isPartialSearchConfig),
  backendOptions: optional(
    objectOf({
      libsql: optional(
        objectOf({
          metric: optional(oneOf('cosine', 'l2', 'inner_product')),
          compressNeighbors: optional(
            anyOf(
              oneOf('float8'),
              oneOf('float1bit'),
              (value: unknown): value is null => value === null,
            ),
          ),
          maxNeighbors: optional(isNumber),
        }),
      ),
      pglite: optional(objectOf({})),
      sqlite: optional(objectOf({ indexPath: optional(isString) })),
      lancedb: optional(
        objectOf({
          numPartitions: optional(isNumber),
          numSubVectors: optional(isNumber),
        }),
      ),
    }),
  ),
});
