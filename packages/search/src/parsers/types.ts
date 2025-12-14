/**
 * Types and interfaces for document parsers.
 * Parsers convert various file formats into plain text for indexing.
 */

// ============================================================================
// Parsed Document Types
// ============================================================================

/**
 * Result of parsing a document.
 */
export interface ParsedDocument {
  /** Extracted plain text content */
  text: string;
  /** Document title (from metadata or content) */
  title: string | null;
  /** Document metadata extracted during parsing */
  metadata: DocumentMetadata;
  /** Whether this document requires OCR processing for full text extraction */
  requiresOcr: boolean;
  /** Regions that need OCR processing (for documents with embedded images) */
  ocrRegions?: OcrRegion[];
}

/**
 * Metadata extracted from a document.
 */
export interface DocumentMetadata {
  /** Document title (from metadata or first heading) */
  title?: string;
  /** Document author */
  author?: string;
  /** Creation date */
  createdAt?: Date;
  /** Last modified date */
  modifiedAt?: Date;
  /** Number of pages (for paginated documents) */
  pageCount?: number;
  /** Detected language (ISO 639-1 code) */
  language?: string;
  /** Word count */
  wordCount?: number;
  /** Character count */
  charCount?: number;
  /** Additional metadata fields */
  [key: string]: unknown;
}

/**
 * Region in a document that requires OCR processing.
 */
export interface OcrRegion {
  /** Page number (1-indexed) */
  page: number;
  /** Bounding box of the region */
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** Raw image data for the region */
  imageData?: Buffer;
  /** Suggested OCR language */
  language?: string;
}

// ============================================================================
// Parser Interface
// ============================================================================

/**
 * Options for document parsing.
 */
export interface ParserOptions {
  /** Extract metadata from the document */
  extractMetadata?: boolean;
  /** Detect regions that need OCR */
  detectOcrRegions?: boolean;
  /** Maximum text length to extract (0 = unlimited) */
  maxTextLength?: number;
  /** Encoding for text files */
  encoding?: BufferEncoding;
  /** Custom options for specific parsers */
  [key: string]: unknown;
}

/**
 * Interface for document parsers.
 * Each parser handles one or more file types.
 */
export interface DocumentParser {
  /** Unique name for this parser */
  name: string;
  /** File extensions this parser supports (with leading dot) */
  supportedExtensions: string[];
  /** MIME types this parser supports */
  supportedMimeTypes: string[];
  /** Priority for parser selection (higher = preferred) */
  priority: number;

  /**
   * Check if this parser supports the given file.
   *
   * @param filePath - Path to the file
   * @param mimeType - Optional MIME type
   * @returns True if this parser can handle the file
   */
  supports(filePath: string, mimeType?: string): boolean;

  /**
   * Parse a file from disk.
   *
   * @param filePath - Path to the file
   * @param options - Parser options
   * @returns Parsed document
   */
  parse(filePath: string, options?: ParserOptions): Promise<ParsedDocument>;

  /**
   * Parse a file from a buffer.
   *
   * @param buffer - File contents
   * @param fileName - Original file name (for extension detection)
   * @param options - Parser options
   * @returns Parsed document
   */
  parseBuffer(
    buffer: Buffer,
    fileName: string,
    options?: ParserOptions,
  ): Promise<ParsedDocument>;
}

// ============================================================================
// Parser Registry Types
// ============================================================================

/**
 * Options for creating a parser registry.
 */
export interface ParserRegistryOptions {
  /** Default options passed to all parsers */
  defaultOptions?: ParserOptions;
}

/**
 * Parser registration info.
 */
export interface ParserRegistration {
  parser: DocumentParser;
  registeredAt: Date;
}

/**
 * Statistics about parser usage.
 */
export interface ParserStats {
  name: string;
  supportedExtensions: string[];
  priority: number;
  parseCount: number;
  totalParseTime: number;
  averageParseTime: number;
  errorCount: number;
}

// ============================================================================
// Helper Types
// ============================================================================

/**
 * Supported file categories.
 */
export type FileCategory =
  | 'document' // DOCX, PDF, etc.
  | 'spreadsheet' // XLSX, CSV, etc.
  | 'presentation' // PPTX, etc.
  | 'text' // TXT, MD, etc.
  | 'code' // Source code files
  | 'data' // JSON, YAML, XML, etc.
  | 'media' // Images, audio, video
  | 'archive' // ZIP, etc.
  | 'email' // MSG, EML, etc.
  | 'web' // HTML, RSS, etc.
  | 'notebook' // Jupyter notebooks
  | 'other';

/**
 * Get file category from extension.
 */
export function getFileCategory(extension: string): FileCategory {
  const ext = extension.toLowerCase().replace(/^\./, '');

  const categories: Record<string, FileCategory> = {
    // Documents
    docx: 'document',
    doc: 'document',
    pdf: 'document',
    odt: 'document',
    rtf: 'document',

    // Spreadsheets
    xlsx: 'spreadsheet',
    xls: 'spreadsheet',
    ods: 'spreadsheet',
    csv: 'spreadsheet',

    // Presentations
    pptx: 'presentation',
    ppt: 'presentation',
    odp: 'presentation',

    // Text
    txt: 'text',
    md: 'text',
    markdown: 'text',
    rst: 'text',

    // Code
    js: 'code',
    ts: 'code',
    py: 'code',
    java: 'code',
    c: 'code',
    cpp: 'code',
    h: 'code',
    cs: 'code',
    go: 'code',
    rs: 'code',
    rb: 'code',
    php: 'code',
    swift: 'code',
    kt: 'code',
    scala: 'code',
    r: 'code',
    sql: 'code',
    sh: 'code',
    bash: 'code',
    ps1: 'code',

    // Data
    json: 'data',
    yaml: 'data',
    yml: 'data',
    xml: 'data',
    toml: 'data',
    ini: 'data',

    // Media
    png: 'media',
    jpg: 'media',
    jpeg: 'media',
    gif: 'media',
    webp: 'media',
    svg: 'media',
    mp3: 'media',
    mp4: 'media',
    wav: 'media',
    avi: 'media',
    mov: 'media',
    webm: 'media',

    // Archives
    zip: 'archive',
    tar: 'archive',
    gz: 'archive',
    rar: 'archive',
    '7z': 'archive',

    // Email
    msg: 'email',
    eml: 'email',

    // Web
    html: 'web',
    htm: 'web',
    rss: 'web',
    atom: 'web',

    // Notebooks
    ipynb: 'notebook',
  };

  return categories[ext] || 'other';
}

/**
 * Get MIME type from extension.
 */
export function getMimeType(extension: string): string {
  const ext = extension.toLowerCase().replace(/^\./, '');

  const mimeTypes: Record<string, string> = {
    // Documents
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
    pdf: 'application/pdf',
    odt: 'application/vnd.oasis.opendocument.text',
    rtf: 'application/rtf',

    // Spreadsheets
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    csv: 'text/csv',

    // Presentations
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ppt: 'application/vnd.ms-powerpoint',
    odp: 'application/vnd.oasis.opendocument.presentation',

    // Text
    txt: 'text/plain',
    md: 'text/markdown',
    markdown: 'text/markdown',

    // Data
    json: 'application/json',
    yaml: 'text/yaml',
    yml: 'text/yaml',
    xml: 'application/xml',

    // Web
    html: 'text/html',
    htm: 'text/html',

    // Media
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    wav: 'audio/wav',

    // Archives
    zip: 'application/zip',

    // Email
    msg: 'application/vnd.ms-outlook',
    eml: 'message/rfc822',

    // Notebooks
    ipynb: 'application/x-ipynb+json',
  };

  return mimeTypes[ext] || 'application/octet-stream';
}
