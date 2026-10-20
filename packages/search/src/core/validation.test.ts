/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseMessage as parseIndexingMessage } from '../indexing/child-process-types.js';
import { parseStorageMessage } from '../indexing/storage-writer-types.js';
import { parseMessage as parseSupervisorMessage } from '../supervisor/ipc/supervisor-ipc-types.js';
import { isUserConfigFile } from '../config/user-config-validation.js';
import { isStorageWriterRequest } from '../indexing/storage-writer-validation.js';
import { readJsonRecord, readJsonStrings } from './validation.js';

describe('search input boundaries', () => {
  it.each([
    'null',
    '[]',
    '{"type":"ready","memoryUsageMb":"1024"}',
    '{"type":"progress","event":"unknown","processed":1,"total":2,"memoryUsageMb":1}',
    '{"type":"batch_complete","id":"batch","hasMore":false,"stats":{}}',
  ])('rejects invalid indexing messages: %s', (line) => {
    expect(() => parseIndexingMessage(line)).toThrow(TypeError);
  });

  it('rejects malformed write acknowledgements before resolving requests', () => {
    expect(() =>
      parseStorageMessage(
        JSON.stringify({
          type: 'document_written',
          id: 'write',
          documentId: 'doc',
          chunkIds: [123],
          chunksWritten: 1,
          embeddingsWritten: 1,
          memoryUsageMb: 64,
        }),
      ),
    ).toThrow(TypeError);
  });

  it('drops malformed supervisor messages while preserving arbitrary results', () => {
    expect(
      parseSupervisorMessage(
        '{"type":"supervisor_result","id":12,"success":true}',
      ),
    ).toBeNull();
    const response = {
      type: 'supervisor_result',
      id: 'stats',
      success: true,
      result: { totalDocuments: 12 },
    };
    expect(parseSupervisorMessage(JSON.stringify(response))).toEqual(response);
  });

  it('requires numbers and real string arrays in user settings', () => {
    expect(
      isUserConfigFile({ config: { search: { defaultLimit: '10' } } }),
    ).toBe(false);
    expect(
      isUserConfigFile({ config: { indexing: { fileTypes: ['.pdf', 1] } } }),
    ).toBe(false);
    expect(
      isUserConfigFile({
        config: { search: { defaultLimit: 10 } },
        _docs: 'comment',
      }),
    ).toBe(true);
  });

  it('does not accept a JSON string as a document modification date', () => {
    const request = {
      type: 'write_document',
      id: 'write',
      document: {
        filePath: '/evidence.txt',
        fileName: 'evidence.txt',
        fileExtension: '.txt',
        fileSize: 20,
        fileHash: 'hash',
        fileModifiedAt: '2026-10-20T00:00:00Z',
      },
      chunks: [],
      embeddings: [],
      isReindex: false,
    };
    expect(isStorageWriterRequest(request)).toBe(false);
    expect(
      isStorageWriterRequest({
        ...request,
        document: {
          ...request.document,
          fileModifiedAt: new Date(request.document.fileModifiedAt),
        },
      }),
    ).toBe(true);
  });

  it('rejects corrupt stored tags and metadata without silently changing their shape', () => {
    expect(() => readJsonRecord('[]')).toThrow(TypeError);
    expect(() => readJsonStrings('["audit",3]')).toThrow(TypeError);
    expect(readJsonRecord('{"source":"audit"}')).toEqual({ source: 'audit' });
  });
});
