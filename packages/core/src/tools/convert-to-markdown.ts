/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_FEATURE: Convert to Markdown tool for reading unsupported file formats
// This tool uses parsers from the search package (MarkitdownParser and OfficeParserAdapter)

import path from 'node:path';
import fs from 'node:fs';
import type { ToolInvocation, ToolLocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import type { Config } from '../config/config.js';
import { CONVERT_TO_MARKDOWN_TOOL_NAME } from './tool-names.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { ToolErrorType } from './tool-error.js';
import { isNodeError } from '../utils/errors.js';

/**
 * Supported file extensions for conversion to Markdown.
 *
 * Via MarkitdownParser (markitdown-ts):
 * - PDF (.pdf)
 * - Word (.docx)
 * - Excel (.xlsx)
 * - Text-based formats (.csv, .xml, .rss, .atom)
 * - Jupyter Notebooks (.ipynb)
 *
 * Via OfficeParserAdapter (officeparser):
 * - PowerPoint (.pptx)
 * - OpenDocument formats (.odt, .odp, .ods)
 *
 * NOT supported:
 * - HTML (.html, .htm) - disabled due to bundling issues
 * - ZIP files (.zip) - unzipper not bundled
 * - Images and audio - use read_file instead (native Gemini support)
 */
const SUPPORTED_EXTENSIONS = new Set([
  // Office Documents (MarkitdownParser)
  '.pdf',
  '.docx',
  '.xlsx',
  // Plain text and structured data (MarkitdownParser)
  '.csv',
  '.xml',
  '.rss',
  '.atom',
  // Jupyter Notebooks (MarkitdownParser)
  '.ipynb',
  // PowerPoint (OfficeParserAdapter)
  '.pptx',
  // OpenDocument formats (OfficeParserAdapter)
  '.odt',
  '.odp',
  '.ods',
]);

/**
 * Extensions that should use OfficeParserAdapter instead of MarkitdownParser
 */
const OFFICE_PARSER_EXTENSIONS = new Set([
  '.pptx',
  '.xlsx',
  '.odt',
  '.odp',
  '.ods',
]);

/**
 * Parameters for the ConvertToMarkdown tool
 */
export interface ConvertToMarkdownToolParams {
  /**
   * The path to the file to convert
   */
  file_path: string;
}

class ConvertToMarkdownToolInvocation extends BaseToolInvocation<
  ConvertToMarkdownToolParams,
  ToolResult
> {
  private readonly resolvedPath: string;

  constructor(
    private readonly config: Config,
    params: ConvertToMarkdownToolParams,
    messageBus: MessageBus,
    toolName?: string,
    displayName?: string,
  ) {
    super(params, messageBus, toolName, displayName);
    this.resolvedPath = path.resolve(
      this.config.getTargetDir(),
      this.params.file_path,
    );
  }

  getDescription(): string {
    const relativePath = makeRelative(
      this.resolvedPath,
      this.config.getTargetDir(),
    );
    return `Converting ${shortenPath(relativePath)} to Markdown`;
  }

  override toolLocations(): ToolLocation[] {
    return [{ path: this.resolvedPath }];
  }

  async execute(): Promise<ToolResult> {
    const ext = path.extname(this.resolvedPath).toLowerCase();

    // Check if file exists
    if (!fs.existsSync(this.resolvedPath)) {
      return {
        llmContent: `File not found: ${this.resolvedPath}`,
        returnDisplay: 'File not found',
        error: {
          message: `File not found: ${this.resolvedPath}`,
          type: ToolErrorType.FILE_NOT_FOUND,
        },
      };
    }

    // Check if extension is supported
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      const supportedList = Array.from(SUPPORTED_EXTENSIONS).sort().join(', ');
      return {
        llmContent: `Unsupported file format: ${ext}. Supported formats: ${supportedList}`,
        returnDisplay: `Unsupported format: ${ext}`,
        error: {
          message: `Unsupported file format: ${ext}`,
          type: ToolErrorType.INVALID_TOOL_PARAMS,
        },
      };
    }

    try {
      // Dynamic import to avoid loading search package if not needed
      const searchPackage = await import('@thacio/auditaria-search');

      let result: { text: string; title?: string | null };

      // Use OfficeParserAdapter for pptx and OpenDocument formats
      // Use MarkitdownParser for everything else
      if (OFFICE_PARSER_EXTENSIONS.has(ext)) {
        const parser = new searchPackage.OfficeParserAdapter();
        result = await parser.parse(this.resolvedPath);
      } else {
        const parser = new searchPackage.MarkitdownParser();
        result = await parser.parse(this.resolvedPath);
      }

      if (!result || !result.text) {
        throw new Error('Conversion returned empty result');
      }

      const markdown = result.text;
      const title = result.title || path.basename(this.resolvedPath);

      // Build the output
      let llmContent = `# Converted: ${title}\n\n`;
      llmContent += `**Source file:** ${this.resolvedPath}\n`;
      llmContent += `**Format:** ${ext}\n\n`;
      llmContent += `---\n\n`;
      llmContent += markdown;

      const relativePath = makeRelative(
        this.resolvedPath,
        this.config.getTargetDir(),
      );

      return {
        llmContent,
        returnDisplay: `Converted ${shortenPath(relativePath)} (${ext}) to Markdown`,
      };
    } catch (error: unknown) {
      let errorMsg: string;
      let errorType = ToolErrorType.UNKNOWN;

      if (isNodeError(error)) {
        errorMsg = `Error converting file '${this.resolvedPath}': ${error.message}`;
        if (error.code === 'EACCES') {
          errorType = ToolErrorType.PERMISSION_DENIED;
        }
      } else if (error instanceof Error) {
        errorMsg = `Error converting file: ${error.message}`;
      } else {
        errorMsg = `Error converting file: ${String(error)}`;
      }

      return {
        llmContent: errorMsg,
        returnDisplay: errorMsg,
        error: {
          message: errorMsg,
          type: errorType,
        },
      };
    }
  }
}

/**
 * Tool for converting various file formats to Markdown.
 *
 * This tool is useful for reading file formats that are not natively supported
 * by the read_file tool, such as Word documents (.docx), Excel spreadsheets (.xlsx),
 * PowerPoint presentations (.pptx), and other document formats.
 *
 * Uses parsers from the search package:
 * - MarkitdownParser (markitdown-ts) for PDF, DOCX, XLSX, CSV, XML, IPYNB
 * - OfficeParserAdapter (officeparser) for PPTX, ODT, ODP, ODS
 */
export class ConvertToMarkdownTool extends BaseDeclarativeTool<
  ConvertToMarkdownToolParams,
  ToolResult
> {
  static readonly Name = CONVERT_TO_MARKDOWN_TOOL_NAME;
  static readonly Bridgeable = true; // AUDITARIA_CLAUDE_PROVIDER: auto-bridge to external providers via MCP

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      ConvertToMarkdownTool.Name,
      'ConvertToMarkdown',
      `Converts various file formats to Markdown text for reading.

**Supported formats:**
- .docx (Word documents)
- .xlsx (Excel spreadsheets)
- .pptx (PowerPoint presentations)
- .pdf (PDF documents)
- .csv, .xml, .rss, .atom (structured data)
- .ipynb (Jupyter notebooks)
- .odt, .odp, .ods (OpenDocument formats)

**NOT supported:** .html, .zip, images, audio

**IMPORTANT NOTES:**
1. Use this tool when \`read_file\` fails or returns binary/garbled content
2. Use this tool when \`read_file\` fails due to file size (read_file has a 20MB limit)
3. For .docx, .xlsx, and .pptx files, this is the PRIMARY tool to use - read_file cannot parse these formats
4. For images, audio, and PDF files, prefer \`read_file\` which has native support

**Examples:**
- Reading a Word document: \`convert_to_markdown\` with file_path: "report.docx"
- Reading an Excel file: \`convert_to_markdown\` with file_path: "data.xlsx"
- Reading a PowerPoint: \`convert_to_markdown\` with file_path: "presentation.pptx"
- Reading a large PDF that read_file rejected: \`convert_to_markdown\` with file_path: "large-manual.pdf"`,
      Kind.Read,
      {
        properties: {
          file_path: {
            description:
              'The path to the file to convert. Supported: .docx, .xlsx, .pptx, .pdf, .csv, .xml, .rss, .atom, .ipynb, .odt, .odp, .ods',
            type: 'string',
          },
        },
        required: ['file_path'],
        type: 'object',
      },
      messageBus,
      true, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  protected override validateToolParamValues(
    params: ConvertToMarkdownToolParams,
  ): string | null {
    if (!params.file_path || params.file_path.trim() === '') {
      return "The 'file_path' parameter must be non-empty.";
    }

    const resolvedPath = path.resolve(
      this.config.getTargetDir(),
      params.file_path,
    );

    // Check workspace boundaries
    const workspaceContext = this.config.getWorkspaceContext();
    const projectTempDir = this.config.storage.getProjectTempDir();
    const resolvedProjectTempDir = path.resolve(projectTempDir);
    const isWithinTempDir =
      resolvedPath.startsWith(resolvedProjectTempDir + path.sep) ||
      resolvedPath === resolvedProjectTempDir;

    if (
      !workspaceContext.isPathWithinWorkspace(resolvedPath) &&
      !isWithinTempDir
    ) {
      const directories = workspaceContext.getDirectories();
      return `File path must be within one of the workspace directories: ${directories.join(', ')} or within the project temp directory: ${projectTempDir}`;
    }

    // Validate extension
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      const supportedList = Array.from(SUPPORTED_EXTENSIONS).sort().join(', ');
      return `Unsupported file format: ${ext}. Supported formats: ${supportedList}`;
    }

    return null;
  }

  protected createInvocation(
    params: ConvertToMarkdownToolParams,
    messageBus: MessageBus,
    toolName?: string,
    displayName?: string,
  ): ToolInvocation<ConvertToMarkdownToolParams, ToolResult> {
    return new ConvertToMarkdownToolInvocation(
      this.config,
      params,
      messageBus,
      toolName,
      displayName,
    );
  }
}
