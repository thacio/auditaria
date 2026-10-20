/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SearchSystemConfig, DeepPartial } from '../config.js';
import {
  type Guard,
  objectOf,
  optional,
  anyOf,
  oneOf,
  isString,
  isBoolean,
  arrayOf,
  isNumber,
} from '../core/validation.js';

export const isPartialSearchConfig: Guard<DeepPartial<SearchSystemConfig>> =
  objectOf({
    database: optional(
      objectOf({
        backend: optional(oneOf('sqlite', 'pglite', 'lancedb', 'libsql')),
        path: optional(isString),
        inMemory: optional(isBoolean),
        backupEnabled: optional(isBoolean),
      }),
    ),
    indexing: optional(
      objectOf({
        ignorePaths: optional(arrayOf(isString)),
        includePaths: optional(arrayOf(isString)),
        fileTypes: optional(arrayOf(isString)),
        maxFileSize: optional(isNumber),
        respectGitignore: optional(isBoolean),
        prepareWorkers: optional(isNumber),
        preparedBufferSize: optional(isNumber),
        useChildProcess: optional(isBoolean),
        childProcessBatchSize: optional(isNumber),
        supervisorStrategy: optional(
          oneOf('in-process', 'child-process', 'none'),
        ),
        supervisorRestartThreshold: optional(isNumber),
        supervisorMemoryThresholdMb: optional(isNumber),
      }),
    ),
    chunking: optional(
      objectOf({
        maxChunkSize: optional(isNumber),
        chunkOverlap: optional(isNumber),
      }),
    ),
    embeddings: optional(
      objectOf({
        pythonCommand: optional(isString),
        multimodal: optional(isBoolean),
        model: optional(isString),
        batchSize: optional(isNumber),
        dimensions: optional(isNumber),
        useWorkerThread: optional(isBoolean),
        device: optional(oneOf('auto', 'cpu', 'dml', 'cuda')),
        quantization: optional(oneOf('auto', 'fp32', 'fp16', 'q8', 'q4')),
        preferGpuForIndexing: optional(isBoolean),
        workerHeapSizeMb: optional(isNumber),
        preferPythonEmbedder: optional(isBoolean),
        cacheDir: optional(isString),
      }),
    ),
    search: optional(
      objectOf({
        defaultLimit: optional(isNumber),
        defaultStrategy: optional(oneOf('hybrid', 'semantic', 'keyword')),
        semanticWeight: optional(isNumber),
        keywordWeight: optional(isNumber),
        rrfK: optional(isNumber),
      }),
    ),
    ocr: optional(
      objectOf({
        enabled: optional(isBoolean),
        concurrency: optional(isNumber),
        maxRetries: optional(isNumber),
        retryDelay: optional(isNumber),
        processAfterMainQueue: optional(isBoolean),
        autoDetectLanguage: optional(isBoolean),
        defaultLanguages: optional(arrayOf(isString)),
        minConfidence: optional(isNumber),
      }),
    ),
    vectorIndex: optional(
      objectOf({
        type: optional(oneOf('hnsw', 'ivfflat', 'none')),
        deferIndexCreation: optional(isBoolean),
        createIndex: optional(isBoolean),
        useHalfVec: optional(isBoolean),
        hnswM: optional(isNumber),
        hnswEfConstruction: optional(isNumber),
        ivfflatLists: optional(anyOf(isNumber, oneOf('auto'))),
        ivfflatProbes: optional(isNumber),
      }),
    ),
  });
