/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */
// AUDITARIA_ARTIFACTS: keep bundler/image engines out of normal CLI startup.
import type { ExportInput, ExportOptions, ExportResult } from './types.js';

export async function exportHtml(
  input: ExportInput,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const converter = await import('./exportHtml.js');
  return converter.exportHtml(input, options);
}
