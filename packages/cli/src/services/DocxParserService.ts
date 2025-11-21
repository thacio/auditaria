/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * DOCX Parser Service
 *
 * This service is SPECIFIC to the docx-writing-skill.
 * It finds the parser executable and invokes it.
 *
 * This is NOT generic - it's only for parser.
 *
 * Responsibilities:
 * - Detect if parser executable exists
 * - Track parser availability status
 * - Execute parser binary on markdown files
 * - Handle file-in-use errors
 * - Open generated DOCX with system default application
 */
export class DocxParserService {
  private parserPath: string | null = null;
  private isAvailable: boolean = false;

  constructor(
    private workingDirectory: string
  ) {
    this.detectParser();
  }

  /**
   * Detect parser executable
   */
  private detectParser(): void {
    const platform = process.platform;
    const executable = platform === 'win32' ? 'parser.exe' : 'parser';

    // Check primary location
    const parserPath = path.join(
      this.workingDirectory,
      '.auditaria/skills/docx-writing-skill',
      executable
    );

    if (fs.existsSync(parserPath)) {
      this.parserPath = parserPath;
      this.isAvailable = true;
    } else {
      this.isAvailable = false;
      this.parserPath = null;
    }
  }

  /**
   * Check if parser is available
   */
  isParserAvailable(): boolean {
    return this.isAvailable;
  }

  /**
   * Get parser executable path
   */
  getParserPath(): string | null {
    return this.parserPath;
  }

  /**
   * Parse markdown file to DOCX
   *
   * @param mdFilePath Absolute path to markdown file
   * @returns Parse result with success status and output path or error
   */
  async parseMarkdownToDocx(mdFilePath: string): Promise<{
    success: boolean;
    outputPath?: string;
    error?: string;
  }> {
    if (!this.isAvailable || !this.parserPath) {
      return {
        success: false,
        error: 'DOCX parser not installed. Run: /setup-skill docx-writing-skill'
      };
    }

    // Verify input file exists
    if (!fs.existsSync(mdFilePath)) {
      return {
        success: false,
        error: `Input file not found: ${mdFilePath}`
      };
    }

    try {
      // Execute: parser.exe input.md
      // Parser creates output.docx in same directory
      await execFileAsync(this.parserPath, [mdFilePath]);

      // Calculate expected output path
      const outputPath = mdFilePath.replace(/\.md$/i, '.docx');

      if (!fs.existsSync(outputPath)) {
        return {
          success: false,
          error: 'Parser executed but output file not found'
        };
      }

      return {
        success: true,
        outputPath
      };
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Detect file-in-use errors
      if (errorMsg.includes('being used by another process') ||
          errorMsg.includes('Permission denied') ||
          errorMsg.includes('EACCES') ||
          errorMsg.includes('EBUSY')) {
        return {
          success: false,
          error: 'File is currently open in another application. Please close it and try again.'
        };
      }

      return {
        success: false,
        error: `Parser error: ${errorMsg}`
      };
    }
  }

  /**
   * Refresh parser detection (call after installing skill)
   */
  refresh(): void {
    this.detectParser();
  }

  /**
   * Open DOCX file with system default application
   *
   * @param docxPath Absolute path to DOCX file
   */
  async openDocxFile(docxPath: string): Promise<void> {
    try {
      if (process.platform === 'win32') {
        // Windows: Use PowerShell Invoke-Item
        await execAsync(`powershell -Command "Invoke-Item '${docxPath}'"`);
      } else if (process.platform === 'darwin') {
        // macOS: Use open
        await execAsync(`open "${docxPath}"`);
      } else {
        // Linux: Use xdg-open
        await execAsync(`xdg-open "${docxPath}"`);
      }
    } catch (error) {
      // Don't throw - opening file is optional convenience feature
      console.warn(`Failed to open DOCX file: ${error}`);
    }
  }
}
