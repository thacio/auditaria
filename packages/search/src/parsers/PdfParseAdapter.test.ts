/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { PdfParseAdapter } from './PdfParseAdapter.js';

it('parses a real PDF from disk and buffer without corrupting the input', async () => {
  const path = fileURLToPath(new URL('./fixtures/access.pdf', import.meta.url));
  const buffer = await readFile(path);
  const original = Buffer.from(buffer);
  const parser = new PdfParseAdapter();
  for (const parsed of [
    await parser.parse(path),
    await parser.parseBuffer(buffer, 'access.pdf'),
  ]) {
    expect(parsed.text).toContain('Multi-factor authentication');
    expect(parsed.metadata.pageCount).toBe(1);
    expect(parsed.requiresOcr).toBe(false);
  }
  expect(buffer).toEqual(original);
});
