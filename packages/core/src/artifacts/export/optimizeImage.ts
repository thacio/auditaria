/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_ARTIFACTS: only accept smaller PNGs with identical decoded pixels.
import sharp from 'sharp';

export async function optimizePng(input: Buffer): Promise<Buffer> {
  try {
    const metadata = await sharp(input).metadata();
    if ((metadata.pages ?? 1) > 1 || metadata.bitsPerSample !== 8) return input;
    const output = await sharp(input)
      .keepMetadata()
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
    if (output.length >= input.length) return input;
    const before = await sharp(input).ensureAlpha().raw().toBuffer();
    const after = await sharp(output).ensureAlpha().raw().toBuffer();
    return before.equals(after) ? output : input;
  } catch {
    // Original bytes remain valid even if optimization is unavailable.
    return input;
  }
}
