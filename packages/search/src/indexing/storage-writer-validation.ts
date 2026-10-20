/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  StorageWriterResponse,
  StorageWriterRequest,
} from './storage-writer-types.js';
import {
  type Guard,
  anyOf,
  objectOf,
  oneOf,
  isNumber,
  isString,
  isBoolean,
  optional,
  arrayOf,
  isDate,
  isRecord,
} from '../core/validation.js';
import { isPartialSearchConfig } from '../config/config-validation.js';

export const isStorageWriterResponse: Guard<StorageWriterResponse> = anyOf(
  objectOf({ type: oneOf('ready'), memoryUsageMb: isNumber }),
  objectOf({
    type: oneOf('init_complete'),
    id: isString,
    success: isBoolean,
    error: optional(isString),
    memoryUsageMb: isNumber,
  }),
  objectOf({
    type: oneOf('document_written'),
    id: isString,
    documentId: isString,
    chunkIds: arrayOf(isString),
    chunksWritten: isNumber,
    embeddingsWritten: isNumber,
    memoryUsageMb: isNumber,
  }),
  objectOf({
    type: oneOf('document_status_updated'),
    id: isString,
    documentId: isString,
    memoryUsageMb: isNumber,
  }),
  objectOf({
    type: oneOf('checkpoint_complete'),
    id: isString,
    memoryUsageMb: isNumber,
  }),
  objectOf({
    type: oneOf('stats_response'),
    id: isString,
    documentsWritten: isNumber,
    chunksWritten: isNumber,
    embeddingsWritten: isNumber,
    memoryUsageMb: isNumber,
  }),
  objectOf({
    type: oneOf('error'),
    id: optional(isString),
    error: isString,
    fatal: isBoolean,
  }),
);

export const isStorageWriterRequest: Guard<StorageWriterRequest> = anyOf(
  objectOf({
    type: oneOf('init'),
    id: isString,
    databasePath: isString,
    rootPath: isString,
    config: isPartialSearchConfig,
  }),
  objectOf({
    type: oneOf('write_document'),
    id: isString,
    document: objectOf({
      filePath: isString,
      fileName: isString,
      fileExtension: isString,
      fileSize: isNumber,
      fileHash: isString,
      mimeType: optional(
        anyOf(isString, (value: unknown): value is null => value === null),
      ),
      title: optional(
        anyOf(isString, (value: unknown): value is null => value === null),
      ),
      author: optional(
        anyOf(isString, (value: unknown): value is null => value === null),
      ),
      language: optional(
        anyOf(isString, (value: unknown): value is null => value === null),
      ),
      pageCount: optional(
        anyOf(isNumber, (value: unknown): value is null => value === null),
      ),
      status: optional(
        oneOf(
          'pending',
          'parsing',
          'chunking',
          'embedding',
          'indexed',
          'failed',
        ),
      ),
      ocrStatus: optional(
        oneOf(
          'not_needed',
          'pending',
          'processing',
          'completed',
          'failed',
          'skipped',
        ),
      ),
      fileModifiedAt: isDate,
      metadata: optional(isRecord),
    }),
    chunks: arrayOf(
      objectOf({
        chunkIndex: isNumber,
        text: isString,
        startOffset: isNumber,
        endOffset: isNumber,
        page: optional(
          anyOf(isNumber, (value: unknown): value is null => value === null),
        ),
        section: optional(
          anyOf(isString, (value: unknown): value is null => value === null),
        ),
        tokenCount: optional(
          anyOf(isNumber, (value: unknown): value is null => value === null),
        ),
      }),
    ),
    embeddings: arrayOf(arrayOf(isNumber)),
    isReindex: isBoolean,
  }),
  objectOf({
    type: oneOf('update_document_status'),
    id: isString,
    documentId: isString,
    status: oneOf(
      'pending',
      'parsing',
      'chunking',
      'embedding',
      'indexed',
      'failed',
    ),
    indexedAt: optional(isString),
    metadata: optional(isRecord),
  }),
  objectOf({ type: oneOf('checkpoint'), id: isString }),
  objectOf({ type: oneOf('stats'), id: isString }),
  objectOf({ type: oneOf('shutdown'), id: isString }),
);
