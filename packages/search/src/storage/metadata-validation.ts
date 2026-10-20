/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseMetadata } from './metadata.js';
import {
  type Guard,
  objectOf,
  isString,
  anyOf,
  oneOf,
  isBoolean,
  optional,
  isNumber,
  allOf,
  arrayOf,
} from '../core/validation.js';

export const isDatabaseMetadata: Guard<DatabaseMetadata> = objectOf({
  version: isString,
  backend: oneOf('sqlite', 'pglite', 'lancedb', 'libsql'),
  createdAt: isString,
  updatedAt: isString,
  vectorIndex: objectOf({
    type: oneOf('hnsw', 'ivfflat', 'none'),
    useHalfVec: isBoolean,
    createIndex: optional(isBoolean),
    hnswM: optional(isNumber),
    hnswEfConstruction: optional(isNumber),
    ivfflatLists: optional(isNumber),
    ivfflatProbes: optional(isNumber),
  }),
  embeddings: objectOf({
    model: isString,
    dimensions: isNumber,
    quantization: oneOf('fp32', 'fp16', 'q8', 'q4'),
  }),
  backendOptions: optional(
    anyOf(
      allOf(
        objectOf({ backend: oneOf('libsql') }),
        objectOf({
          metric: oneOf('cosine', 'l2', 'inner_product'),
          compressNeighbors: anyOf(
            oneOf('float8'),
            oneOf('float1bit'),
            (value: unknown): value is null => value === null,
          ),
          maxNeighbors: isNumber,
        }),
      ),
      allOf(objectOf({ backend: oneOf('pglite') }), objectOf({})),
      allOf(
        objectOf({ backend: oneOf('sqlite') }),
        objectOf({ indexPath: optional(isString) }),
      ),
      allOf(
        objectOf({ backend: oneOf('lancedb') }),
        objectOf({
          numPartitions: optional(isNumber),
          numSubVectors: optional(isNumber),
        }),
      ),
    ),
  ),
  stats: optional(
    objectOf({
      documentCount: optional(isNumber),
      chunkCount: optional(isNumber),
      updatedAt: optional(isString),
    }),
  ),
  _schema: optional(
    objectOf({
      vectorIndexTypes: arrayOf(isString),
      quantizationOptions: arrayOf(isString),
      createIndex: isString,
    }),
  ),
});
