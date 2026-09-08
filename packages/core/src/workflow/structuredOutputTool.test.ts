/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  CALL_ID_PARAM,
  STRUCTURED_OUTPUT_OK,
  bridgeSchemaFor,
  registerStructuredOutput,
  releaseStructuredOutput,
  structuredOutputSchemaFor,
  submitStructuredOutput,
} from './structuredOutputTool.js';

const SCHEMA = {
  type: 'object',
  properties: { n: { type: 'integer' }, word: { type: 'string' } },
  required: ['n', 'word'],
};

describe('StructuredOutput registry', () => {
  it('serves the registered schema per call id and releases it', () => {
    registerStructuredOutput('c1', SCHEMA);
    expect(structuredOutputSchemaFor('c1')).toEqual(SCHEMA);
    expect(structuredOutputSchemaFor('c2')).toBeUndefined();
    releaseStructuredOutput('c1');
    expect(structuredOutputSchemaFor('c1')).toBeUndefined();
  });

  it('adds the hidden call-id field to the bridge-facing schema', () => {
    const bridged = bridgeSchemaFor(SCHEMA);
    expect(Object.keys(bridged['properties'] as object)).toEqual([
      'n',
      'word',
      CALL_ID_PARAM,
    ]);
    expect(bridged['required']).toEqual(['n', 'word']);
  });

  it('validates submissions, counts failures, captures the first valid value once', async () => {
    const { captured, entry } = registerStructuredOutput('c3', SCHEMA);
    const bad = submitStructuredOutput('c3', {
      n: 'three',
      [CALL_ID_PARAM]: 'c3',
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('Output does not match required schema');
    expect(entry.failures).toBe(1);
    const good = submitStructuredOutput('c3', {
      n: 3,
      word: 'three',
      [CALL_ID_PARAM]: 'c3',
    });
    expect(good).toEqual({ text: STRUCTURED_OUTPUT_OK, isError: false });
    expect(await captured).toEqual({ n: 3, word: 'three' });
    const again = submitStructuredOutput('c3', { n: 4, word: 'four' });
    expect(again.isError).toBe(false);
    expect(entry.value).toEqual({ n: 3, word: 'three' }); // first valid wins
    releaseStructuredOutput('c3');
    expect(submitStructuredOutput('c3', { n: 1, word: 'x' }).isError).toBe(
      true,
    );
  });
});
