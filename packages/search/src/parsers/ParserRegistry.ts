/**
 * Registry for document parsers.
 * Manages parser registration and selection based on file type.
 */

import { Registry } from '../core/Registry.js';
import type {
  DocumentParser,
  ParsedDocument,
  ParserOptions,
  ParserRegistryOptions,
} from './types.js';
import { OfficeParserAdapter } from './OfficeParserAdapter.js';
import { PdfParseAdapter } from './PdfParseAdapter.js';
import { MarkitdownParser } from './MarkitdownParser.js';
import { PlainTextParser } from './PlainTextParser.js';

// ============================================================================
// ParserRegistry Class
// ============================================================================

/**
 * Registry for document parsers with file-type-based selection.
 */
export class ParserRegistry {
  private readonly registry: Registry<DocumentParser>;
  private readonly defaultOptions: ParserOptions;

  constructor(options?: ParserRegistryOptions) {
    this.registry = new Registry<DocumentParser>();
    this.defaultOptions = options?.defaultOptions ?? {};
  }

  /**
   * Register a parser.
   */
  register(parser: DocumentParser): void {
    this.registry.register(parser);
  }

  /**
   * Unregister a parser by name.
   */
  unregister(name: string): boolean {
    return this.registry.unregister(name);
  }

  /**
   * Get a parser by name.
   */
  get(name: string): DocumentParser | undefined {
    return this.registry.get(name);
  }

  /**
   * Get all registered parsers.
   */
  getAll(): DocumentParser[] {
    return this.registry.getAll();
  }

  /**
   * Get the number of registered parsers.
   */
  get size(): number {
    return this.registry.size;
  }

  /**
   * Find the best parser for a file.
   *
   * @param filePath - Path to the file
   * @param mimeType - Optional MIME type
   * @returns The best matching parser, or undefined if none match
   */
  findParserForFile(
    filePath: string,
    mimeType?: string,
  ): DocumentParser | undefined {
    const parsers = this.registry.getAll();

    for (const parser of parsers) {
      if (parser.supports(filePath, mimeType)) {
        return parser;
      }
    }

    return undefined;
  }

  /**
   * Find all parsers that can handle a file.
   *
   * @param filePath - Path to the file
   * @param mimeType - Optional MIME type
   * @returns Array of matching parsers, sorted by priority
   */
  findAllParsersForFile(filePath: string, mimeType?: string): DocumentParser[] {
    const parsers = this.registry.getAll();
    return parsers.filter((parser) => parser.supports(filePath, mimeType));
  }

  /**
   * Parse a file using the best available parser.
   *
   * @param filePath - Path to the file
   * @param options - Parser options (merged with defaults)
   * @returns Parsed document
   * @throws Error if no parser can handle the file
   */
  async parse(
    filePath: string,
    options?: ParserOptions,
  ): Promise<ParsedDocument> {
    const parser = this.findParserForFile(filePath);

    if (!parser) {
      throw new Error(`No parser available for file: ${filePath}`);
    }

    const mergedOptions = { ...this.defaultOptions, ...options };
    return parser.parse(filePath, mergedOptions);
  }

  /**
   * Parse a file with a specific parser.
   *
   * @param parserName - Name of the parser to use
   * @param filePath - Path to the file
   * @param options - Parser options
   * @returns Parsed document
   * @throws Error if the parser is not found
   */
  async parseWith(
    parserName: string,
    filePath: string,
    options?: ParserOptions,
  ): Promise<ParsedDocument> {
    const parser = this.registry.get(parserName);

    if (!parser) {
      throw new Error(`Parser not found: ${parserName}`);
    }

    const mergedOptions = { ...this.defaultOptions, ...options };
    return parser.parse(filePath, mergedOptions);
  }

  /**
   * Check if any parser can handle the given file.
   */
  canParse(filePath: string, mimeType?: string): boolean {
    return this.findParserForFile(filePath, mimeType) !== undefined;
  }

  /**
   * Get all supported file extensions across all parsers.
   */
  getSupportedExtensions(): string[] {
    const extensions = new Set<string>();

    for (const parser of this.registry.getAll()) {
      for (const ext of parser.supportedExtensions) {
        if (ext !== '*') {
          extensions.add(ext);
        }
      }
    }

    return Array.from(extensions).sort();
  }

  /**
   * Clear all registered parsers.
   */
  clear(): void {
    this.registry.clear();
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a new ParserRegistry with default parsers registered.
 *
 * Parser priority order (higher = preferred):
 * - OfficeParserAdapter (200): DOCX, PPTX, XLSX, ODT, ODP, ODS
 * - PdfParseAdapter (200): PDF
 * - MarkitdownParser (100): General-purpose fallback for many formats
 * - PlainTextParser (1): Last-resort fallback for any text file
 */
export function createParserRegistry(
  options?: ParserRegistryOptions,
): ParserRegistry {
  const registry = new ParserRegistry(options);

  // Register specialized parsers first (highest priority)
  registry.register(new OfficeParserAdapter()); // Priority 200 - Office docs
  registry.register(new PdfParseAdapter()); // Priority 200 - PDF files
  registry.register(new MarkitdownParser()); // Priority 100 - general-purpose
  registry.register(new PlainTextParser()); // Priority 1 - fallback

  return registry;
}

/**
 * Create an empty ParserRegistry without default parsers.
 */
export function createEmptyParserRegistry(
  options?: ParserRegistryOptions,
): ParserRegistry {
  return new ParserRegistry(options);
}
