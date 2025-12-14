/**
 * Type declarations for external modules without TypeScript definitions.
 */

declare module 'officeparser' {
  /**
   * Configuration options for officeparser.
   */
  export interface OfficeParserConfig {
    newlineDelimiter?: string;
    ignoreNotes?: boolean;
    putNotesAtLast?: boolean;
    outputErrorToConsole?: boolean;
  }

  /**
   * Parse an Office document file and extract text content (async version).
   * @param filePath - Path to the file or buffer
   * @param config - Optional configuration
   * @returns Promise resolving to extracted text
   */
  export function parseOfficeAsync(
    filePath: string | Buffer | ArrayBuffer,
    config?: OfficeParserConfig,
  ): Promise<string>;

  /**
   * Parse an Office document file and extract text content (callback version).
   * @param filePath - Path to the file or buffer
   * @param config - Configuration options or callback
   * @param callback - Callback function (text, error)
   */
  export function parseOffice(
    filePath: string | Buffer | ArrayBuffer,
    configOrCallback?:
      | OfficeParserConfig
      | ((text: string, error: Error | undefined) => void),
    callback?: (text: string, error: Error | undefined) => void,
  ): void;
}

declare module 'markitdown-ts' {
  /**
   * Result from converting a document.
   */
  export interface ConvertResult {
    markdown: string;
    text_content?: string;
    title?: string;
  }

  /**
   * Options for converting a buffer.
   */
  export interface ConvertBufferOptions {
    file_extension: string;
  }

  /**
   * MarkItDown converter class.
   */
  export class MarkItDown {
    /**
     * Convert a file to markdown.
     * @param filePath - Path to the file or URL
     * @returns Promise resolving to ConvertResult
     */
    convert(filePath: string): Promise<ConvertResult | null>;

    /**
     * Convert a buffer to markdown.
     * @param buffer - Buffer containing file data
     * @param options - Options including file_extension
     * @returns Promise resolving to ConvertResult
     */
    convertBuffer(
      buffer: Buffer,
      options: ConvertBufferOptions,
    ): Promise<ConvertResult | null>;
  }
}

declare module 'xxhash-wasm' {
  interface Hasher {
    update(data: Buffer | string): this;
    digest(encoding?: 'hex'): string;
  }

  /**
   * Create a 64-bit xxhash hasher.
   */
  export function xxhash64(): Promise<Hasher>;
}
