/**
 * Document parsers module exports.
 */

// Types
export type {
  ParsedDocument,
  DocumentMetadata,
  OcrRegion,
  ParserOptions,
  DocumentParser,
  ParserRegistryOptions,
} from './types.js';

// Parsers
export {
  OfficeParserAdapter,
  createOfficeParser,
} from './OfficeParserAdapter.js';
export { PdfParseAdapter, createPdfParser } from './PdfParseAdapter.js';
export {
  MarkitdownParser,
  createMarkitdownParser,
} from './MarkitdownParser.js';
export { PlainTextParser, createPlainTextParser } from './PlainTextParser.js';

// Registry
export {
  ParserRegistry,
  createParserRegistry,
  createEmptyParserRegistry,
} from './ParserRegistry.js';
