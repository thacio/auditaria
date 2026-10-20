/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// pdf-parse 1.x passes its input to PDF.js, which accepts Uint8Array.
// The upstream @types declaration incorrectly restricts this to Node Buffer.
declare module 'pdf-parse' {
  function parse(
    data: Uint8Array,
    options?: { max?: number },
  ): Promise<{
    numpages: number;
    numrender: number;
    info: {
      Title?: string;
      Author?: string;
      Creator?: string;
      Producer?: string;
      CreationDate?: string;
      ModDate?: string;
      [key: string]: unknown;
    };
    metadata: unknown;
    text: string;
    version: string;
  }>;
  export = parse;
}
