/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import { EOL } from 'os';
import { spawn } from 'child_process';
import { rgPath } from '@lvce-editor/ripgrep';
import { t } from '../i18n/index.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  ToolInvocation,
  ToolResult,
} from './tools.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { getErrorMessage, isNodeError } from '../utils/errors.js';
import { Config } from '../config/config.js';

const DEFAULT_TOTAL_MAX_MATCHES = 20000;

/**
 * Parameters for the GrepTool
 */
export interface RipGrepToolParams {
  /**
   * The regular expression pattern to search for in file contents
   */
  pattern: string;

  /**
   * The directory to search in (optional, defaults to current directory relative to root)
   */
  path?: string;

  /**
   * File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")
   */
  include?: string;
}

/**
 * Result object for a single grep match
 */
interface GrepMatch {
  filePath: string;
  lineNumber: number;
  line: string;
}

class GrepToolInvocation extends BaseToolInvocation<
  RipGrepToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: RipGrepToolParams,
  ) {
    super(params);
  }

  /**
   * Checks if a path is within the root directory and resolves it.
   * @param relativePath Path relative to the root directory (or undefined for root).
   * @returns The absolute path if valid and exists, or null if no path specified (to search all directories).
   * @throws {Error} If path is outside root, doesn't exist, or isn't a directory.
   */
  private resolveAndValidatePath(relativePath?: string): string | null {
    // If no path specified, return null to indicate searching all workspace directories
    if (!relativePath) {
      return null;
    }

    const targetPath = path.resolve(this.config.getTargetDir(), relativePath);

    // Security Check: Ensure the resolved path is within workspace boundaries
    const workspaceContext = this.config.getWorkspaceContext();
    if (!workspaceContext.isPathWithinWorkspace(targetPath)) {
      const directories = workspaceContext.getDirectories();
      throw new Error(
        t('tools.ripgrep.path_outside_workspace', 
          'Path validation failed: Attempted path "{path}" resolves outside the allowed workspace directories: {directories}',
          { path: relativePath, directories: directories.join(', ') }
        ),
      );
    }

    // Check existence and type after resolving
    try {
      const stats = fs.statSync(targetPath);
      if (!stats.isDirectory()) {
        throw new Error(t('tools.ripgrep.path_not_directory', 'Path is not a directory: {path}', { path: targetPath }));
      }
    } catch (error: unknown) {
      if (isNodeError(error) && error.code !== 'ENOENT') {
        throw new Error(t('tools.ripgrep.path_not_exist', 'Path does not exist: {path}', { path: targetPath }));
      }
      throw new Error(
        t('tools.ripgrep.path_access_failed', 'Failed to access path stats for {path}: {error}', 
          { path: targetPath, error: String(error) }
        ),
      );
    }

    return targetPath;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    try {
      const workspaceContext = this.config.getWorkspaceContext();
      const searchDirAbs = this.resolveAndValidatePath(this.params.path);
      const searchDirDisplay = this.params.path || '.';

      // Determine which directories to search
      let searchDirectories: readonly string[];
      if (searchDirAbs === null) {
        // No path specified - search all workspace directories
        searchDirectories = workspaceContext.getDirectories();
      } else {
        // Specific path provided - search only that directory
        searchDirectories = [searchDirAbs];
      }

      let allMatches: GrepMatch[] = [];
      const totalMaxMatches = DEFAULT_TOTAL_MAX_MATCHES;

      if (this.config.getDebugMode()) {
        console.log(`[GrepTool] Total result limit: ${totalMaxMatches}`);
      }

      for (const searchDir of searchDirectories) {
        const searchResult = await this.performRipgrepSearch({
          pattern: this.params.pattern,
          path: searchDir,
          include: this.params.include,
          signal,
        });

        if (searchDirectories.length > 1) {
          const dirName = path.basename(searchDir);
          searchResult.forEach((match) => {
            match.filePath = path.join(dirName, match.filePath);
          });
        }

        allMatches = allMatches.concat(searchResult);

        if (allMatches.length >= totalMaxMatches) {
          allMatches = allMatches.slice(0, totalMaxMatches);
          break;
        }
      }

      let searchLocationDescription: string;
      if (searchDirAbs === null) {
        const numDirs = workspaceContext.getDirectories().length;
        searchLocationDescription =
          numDirs > 1
            ? t('tools.ripgrep.search_location_workspace_multiple', 'across {count} workspace directories', { count: numDirs })
            : t('tools.ripgrep.search_location_workspace_single', 'in the workspace directory');
      } else {
        searchLocationDescription = t('tools.ripgrep.search_location_path', 'in path "{path}"', { path: searchDirDisplay });
      }

      if (allMatches.length === 0) {
        const filter = this.params.include ? ` (filter: "${this.params.include}")` : '';
        const noMatchMsg = t('tools.ripgrep.no_matches_detailed', 
          'No matches found for pattern "{pattern}" {searchLocation}{filter}.', 
          { pattern: this.params.pattern, searchLocation: searchLocationDescription, filter }
        );
        return { llmContent: noMatchMsg, returnDisplay: t('tools.ripgrep.no_matches', 'No matches found') };
      }

      const wasTruncated = allMatches.length >= totalMaxMatches;

      const matchesByFile = allMatches.reduce(
        (acc, match) => {
          const fileKey = match.filePath;
          if (!acc[fileKey]) {
            acc[fileKey] = [];
          }
          acc[fileKey].push(match);
          acc[fileKey].sort((a, b) => a.lineNumber - b.lineNumber);
          return acc;
        },
        {} as Record<string, GrepMatch[]>,
      );

      const matchCount = allMatches.length;
      const matchTerm = matchCount === 1 ? 'match' : 'matches';
      const filter = this.params.include ? ` (filter: "${this.params.include}")` : '';

      let llmContent = t('tools.ripgrep.matches_found_detailed',
        'Found {count} {term} for pattern "{pattern}" {searchLocation}{filter}',
        { count: matchCount, term: matchTerm, pattern: this.params.pattern, searchLocation: searchLocationDescription, filter }
      );

      if (wasTruncated) {
        llmContent += t('tools.ripgrep.matches_limited', ' (results limited to {limit} matches for performance)', { limit: totalMaxMatches });
      }

      llmContent += `:\n---\n`;

      for (const filePath in matchesByFile) {
        llmContent += `File: ${filePath}\n`;
        matchesByFile[filePath].forEach((match) => {
          const trimmedLine = match.line.trim();
          llmContent += `L${match.lineNumber}: ${trimmedLine}\n`;
        });
        llmContent += '---\n';
      }

      let displayMessage = wasTruncated
        ? t('tools.ripgrep.matches_found_limited', 'Found {count} {term} (limited)', { count: matchCount, term: matchTerm })
        : t('tools.ripgrep.matches_found', 'Found {count} {term}', { count: matchCount, term: matchTerm });

      return {
        llmContent: llmContent.trim(),
        returnDisplay: displayMessage,
      };
    } catch (error) {
      console.error(`Error during GrepLogic execution: ${error}`);
      const errorMessage = getErrorMessage(error);
      return {
        llmContent: t('tools.ripgrep.search_error', 'Error during grep search operation: {error}', { error: errorMessage }),
        returnDisplay: t('tools.ripgrep.search_error_display', 'Error: {error}', { error: errorMessage }),
      };
    }
  }

  private parseRipgrepOutput(output: string, basePath: string): GrepMatch[] {
    const results: GrepMatch[] = [];
    if (!output) return results;

    const lines = output.split(EOL);

    for (const line of lines) {
      if (!line.trim()) continue;

      const firstColonIndex = line.indexOf(':');
      if (firstColonIndex === -1) continue;

      const secondColonIndex = line.indexOf(':', firstColonIndex + 1);
      if (secondColonIndex === -1) continue;

      const filePathRaw = line.substring(0, firstColonIndex);
      const lineNumberStr = line.substring(
        firstColonIndex + 1,
        secondColonIndex,
      );
      const lineContent = line.substring(secondColonIndex + 1);

      const lineNumber = parseInt(lineNumberStr, 10);

      if (!isNaN(lineNumber)) {
        const absoluteFilePath = path.resolve(basePath, filePathRaw);
        const relativeFilePath = path.relative(basePath, absoluteFilePath);

        results.push({
          filePath: relativeFilePath || path.basename(absoluteFilePath),
          lineNumber,
          line: lineContent,
        });
      }
    }
    return results;
  }

  private async performRipgrepSearch(options: {
    pattern: string;
    path: string;
    include?: string;
    signal: AbortSignal;
  }): Promise<GrepMatch[]> {
    const { pattern, path: absolutePath, include } = options;

    const rgArgs = [
      '--line-number',
      '--no-heading',
      '--with-filename',
      '--ignore-case',
      '--regexp',
      pattern,
    ];

    if (include) {
      rgArgs.push('--glob', include);
    }

    const excludes = [
      '.git',
      'node_modules',
      'bower_components',
      '*.log',
      '*.tmp',
      'build',
      'dist',
      'coverage',
    ];
    excludes.forEach((exclude) => {
      rgArgs.push('--glob', `!${exclude}`);
    });

    rgArgs.push('--threads', '4');
    rgArgs.push(absolutePath);

    try {
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(rgPath, rgArgs, {
          windowsHide: true,
        });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        const cleanup = () => {
          if (options.signal.aborted) {
            child.kill();
          }
        };

        options.signal.addEventListener('abort', cleanup, { once: true });

        child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
        child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

        child.on('error', (err) => {
          options.signal.removeEventListener('abort', cleanup);
          reject(
            new Error(
              t('tools.ripgrep.ripgrep_start_failed', 
                'Failed to start ripgrep: {error}. Please ensure @lvce-editor/ripgrep is properly installed.',
                { error: err.message }
              ),
            ),
          );
        });

        child.on('close', (code) => {
          options.signal.removeEventListener('abort', cleanup);
          const stdoutData = Buffer.concat(stdoutChunks).toString('utf8');
          const stderrData = Buffer.concat(stderrChunks).toString('utf8');

          if (code === 0) {
            resolve(stdoutData);
          } else if (code === 1) {
            resolve(''); // No matches found
          } else {
            reject(
              new Error(
                t('tools.ripgrep.ripgrep_exit_error', 'ripgrep exited with code {code}: {error}', 
                  { code, error: stderrData }
                ),
              ),
            );
          }
        });
      });

      return this.parseRipgrepOutput(output, absolutePath);
    } catch (error: unknown) {
      console.error(t('tools.ripgrep.ripgrep_failed', 'GrepLogic: ripgrep failed: {error}', { error: getErrorMessage(error) }));
      throw error;
    }
  }

  /**
   * Gets a description of the grep operation
   * @param params Parameters for the grep operation
   * @returns A string describing the grep
   */
  getDescription(): string {
    let description = `'${this.params.pattern}'`;
    if (this.params.include) {
      description += ` in ${this.params.include}`;
    }
    if (this.params.path) {
      const resolvedPath = path.resolve(
        this.config.getTargetDir(),
        this.params.path,
      );
      if (
        resolvedPath === this.config.getTargetDir() ||
        this.params.path === '.'
      ) {
        description += ` within ./`;
      } else {
        const relativePath = makeRelative(
          resolvedPath,
          this.config.getTargetDir(),
        );
        description += ` within ${shortenPath(relativePath)}`;
      }
    } else {
      // When no path is specified, indicate searching all workspace directories
      const workspaceContext = this.config.getWorkspaceContext();
      const directories = workspaceContext.getDirectories();
      if (directories.length > 1) {
        description += ` across all workspace directories`;
      }
    }
    return description;
  }
}

/**
 * Implementation of the Grep tool logic (moved from CLI)
 */
export class RipGrepTool extends BaseDeclarativeTool<
  RipGrepToolParams,
  ToolResult
> {
  static readonly Name = 'search_file_content';

  constructor(private readonly config: Config) {
    super(
      RipGrepTool.Name,
      'SearchText',
      'Searches for a regular expression pattern within the content of files in a specified directory (or current working directory). Can filter files by a glob pattern. Returns the lines containing matches, along with their file paths and line numbers. Total results limited to 20,000 matches like VSCode.',
      Kind.Search,
      {
        properties: {
          pattern: {
            description:
              "The regular expression (regex) pattern to search for within file contents (e.g., 'function\\s+myFunction', 'import\\s+\\{.*\\}\\s+from\\s+.*').",
            type: 'string',
          },
          path: {
            description:
              'Optional: The absolute path to the directory to search within. If omitted, searches the current working directory.',
            type: 'string',
          },
          include: {
            description:
              "Optional: A glob pattern to filter which files are searched (e.g., '*.js', '*.{ts,tsx}', 'src/**'). If omitted, searches all files (respecting potential global ignores).",
            type: 'string',
          },
        },
        required: ['pattern'],
        type: 'object',
      },
    );
  }

  /**
   * Checks if a path is within the root directory and resolves it.
   * @param relativePath Path relative to the root directory (or undefined for root).
   * @returns The absolute path if valid and exists, or null if no path specified (to search all directories).
   * @throws {Error} If path is outside root, doesn't exist, or isn't a directory.
   */
  private resolveAndValidatePath(relativePath?: string): string | null {
    // If no path specified, return null to indicate searching all workspace directories
    if (!relativePath) {
      return null;
    }

    const targetPath = path.resolve(this.config.getTargetDir(), relativePath);

    // Security Check: Ensure the resolved path is within workspace boundaries
    const workspaceContext = this.config.getWorkspaceContext();
    if (!workspaceContext.isPathWithinWorkspace(targetPath)) {
      const directories = workspaceContext.getDirectories();
      throw new Error(
        t('tools.ripgrep.path_outside_workspace', 
          'Path validation failed: Attempted path "{path}" resolves outside the allowed workspace directories: {directories}',
          { path: relativePath, directories: directories.join(', ') }
        ),
      );
    }

    // Check existence and type after resolving
    try {
      const stats = fs.statSync(targetPath);
      if (!stats.isDirectory()) {
        throw new Error(t('tools.ripgrep.path_not_directory', 'Path is not a directory: {path}', { path: targetPath }));
      }
    } catch (error: unknown) {
      if (isNodeError(error) && error.code !== 'ENOENT') {
        throw new Error(t('tools.ripgrep.path_not_exist', 'Path does not exist: {path}', { path: targetPath }));
      }
      throw new Error(
        t('tools.ripgrep.path_access_failed', 'Failed to access path stats for {path}: {error}', 
          { path: targetPath, error: String(error) }
        ),
      );
    }

    return targetPath;
  }

  /**
   * Validates the parameters for the tool
   * @param params Parameters to validate
   * @returns An error message string if invalid, null otherwise
   */
  override validateToolParams(params: RipGrepToolParams): string | null {
    const errors = SchemaValidator.validate(
      this.schema.parametersJsonSchema,
      params,
    );
    if (errors) {
      return errors;
    }

    // Only validate path if one is provided
    if (params.path) {
      try {
        this.resolveAndValidatePath(params.path);
      } catch (error) {
        return getErrorMessage(error);
      }
    }

    return null; // Parameters are valid
  }

  protected createInvocation(
    params: RipGrepToolParams,
  ): ToolInvocation<RipGrepToolParams, ToolResult> {
    return new GrepToolInvocation(this.config, params);
  }
}
