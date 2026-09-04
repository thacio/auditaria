/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  LATEST_ONLY_MESSAGE_TYPES,
  parseClientMessage,
  readBoolean,
  readNumber,
  readRequestId,
  readString,
  webSafeReplacer,
} from './protocol.js';

const strip = (value: unknown) =>
  JSON.parse(JSON.stringify(value, webSafeReplacer)) as unknown;

describe('webSafeReplacer', () => {
  it('replaces Gemini inline and file data with a placeholder', () => {
    expect(
      strip({
        parts: [
          { text: 'hello' },
          { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
          { fileData: { fileUri: 'gs://x' } },
        ],
      }),
    ).toEqual({
      parts: [
        { text: 'hello' },
        { text: 'Binary content provided.' },
        { text: 'Binary content provided.' },
      ],
    });
  });

  it('replaces Claude base64 image blocks', () => {
    expect(
      strip([
        { type: 'image', source: { type: 'base64', data: 'AAAA' } },
        { type: 'image', source: { type: 'url', url: 'https://x' } },
      ]),
    ).toEqual([
      { type: 'text', text: 'Binary content provided.' },
      { type: 'image', source: { type: 'url', url: 'https://x' } },
    ]);
  });

  it('keeps parts that already carry text', () => {
    const part = { text: 'kept', inlineData: { data: 'x' } };
    expect(strip(part)).toEqual(part);
  });
});

describe('client message guards', () => {
  it('accepts only objects with a string type', () => {
    expect(parseClientMessage({ type: 'ack', lastSequence: 3 })).toEqual({
      type: 'ack',
      lastSequence: 3,
    });
    expect(parseClientMessage({ type: 3 })).toBeNull();
    expect(parseClientMessage(['ack'])).toBeNull();
    expect(parseClientMessage('ack')).toBeNull();
    expect(parseClientMessage(null)).toBeNull();
  });

  it('reads typed fields and ignores wrong types', () => {
    const message = parseClientMessage({
      type: 'x',
      s: 'str',
      n: 4,
      nan: Number.NaN,
      b: false,
      requestId: 'r1',
    });
    if (!message) throw new Error('expected a message');
    expect(readString(message, 's')).toBe('str');
    expect(readString(message, 'n')).toBeUndefined();
    expect(readNumber(message, 'n')).toBe(4);
    expect(readNumber(message, 'nan')).toBeUndefined();
    expect(readNumber(message, 's')).toBeUndefined();
    expect(readBoolean(message, 'b')).toBe(false);
    expect(readBoolean(message, 's')).toBeUndefined();
    expect(readRequestId(message)).toBe('r1');
  });
});

describe('LATEST_ONLY_MESSAGE_TYPES', () => {
  it('keeps live console output out of the snapshot set', () => {
    expect(LATEST_ONLY_MESSAGE_TYPES.has('console_messages')).toBe(false);
    expect(LATEST_ONLY_MESSAGE_TYPES.has('file_tree_response')).toBe(true);
  });
});
