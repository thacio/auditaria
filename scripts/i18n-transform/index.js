/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ESBuild plugin for automatic i18n transformation
 * Transforms user-facing strings at build time without modifying source code
 */

import { debugLogger } from './debug-logger.js';
import { transformCode } from './babel-transformer.js';
import { ExclusionManager } from './exclusion-manager.js';
import path from 'node:path';
import fs from 'node:fs';

const PLUGIN_NAME = 'i18n-transform';

/**
 * Load configuration from i18n.config.js with environment variable overrides
 */
async function loadConfig() {
  let fileConfig = {};

  try {
    const configPath = path.join(process.cwd(), 'i18n.config.js');
    if (fs.existsSync(configPath)) {
      const configModule = await import(`file://${configPath}`);
      fileConfig = configModule.default || {};
      debugLogger.debug('Loaded config from i18n.config.js');
    }
  } catch (error) {
    debugLogger.debug(`Could not load i18n.config.js: ${error.message}`);
  }

  // Environment variables override config file
  return {
    enabled:
      process.env.I18N_TRANSFORM !== undefined
        ? process.env.I18N_TRANSFORM === 'true'
        : (fileConfig.enabled ?? false),
    debug:
      process.env.I18N_DEBUG !== undefined
        ? process.env.I18N_DEBUG === 'true'
        : (fileConfig.debug ?? false),
    report:
      process.env.I18N_REPORT !== undefined
        ? process.env.I18N_REPORT === 'true'
        : (fileConfig.report ?? false),
  };
}

export function i18nTransformPlugin(options = {}) {
  // Options passed directly to plugin override everything
  const pluginOptions = { ...options };

  return {
    name: PLUGIN_NAME,
    async setup(build) {
      // Load config and merge with plugin options
      const config = await loadConfig();
      const finalConfig = {
        enabled: pluginOptions.enabled ?? config.enabled,
        debug: pluginOptions.debug ?? config.debug,
        report: pluginOptions.report ?? config.report,
      };

      if (!finalConfig.enabled) {
        debugLogger.info('i18n-transform plugin is disabled');
        return;
      }

      debugLogger.setDebugMode(finalConfig.debug);
      debugLogger.info('i18n-transform plugin enabled');

      const exclusionManager = new ExclusionManager();
      const transformationStats = {
        filesProcessed: 0,
        stringsTransformed: 0,
        errors: [],
        fileDetails: [],
      };

      // Initialize on build start
      build.onStart(() => {
        debugLogger.info('Starting i18n transformation build...');
        exclusionManager.loadExclusions();
        transformationStats.filesProcessed = 0;
        transformationStats.stringsTransformed = 0;
        transformationStats.errors = [];
        transformationStats.fileDetails = [];
      });

      // Transform TypeScript/TSX and JavaScript files (for dist processing)
      build.onLoad({ filter: /\.(ts|tsx|js|jsx)$/ }, async (args) => {
        const filePath = args.path;

        // Check if file should be excluded
        if (exclusionManager.isExcluded(filePath)) {
          debugLogger.debug(`Skipping excluded file: ${filePath}`);
          return null;
        }

        try {
          const source = await fs.promises.readFile(filePath, 'utf8');

          // Skip files that are already transformed or don't need transformation
          if (
            source.includes('// @i18n-transformed') ||
            !needsTransformation(source)
          ) {
            return null;
          }

          debugLogger.debug(`Processing file: ${filePath}`);

          const transformed = await transformCode(source, filePath, {
            debug: finalConfig.debug,
          });

          if (transformed.modified) {
            transformationStats.filesProcessed++;
            transformationStats.stringsTransformed +=
              transformed.transformCount;

            if (transformed.transformations?.length > 0) {
              transformationStats.fileDetails.push({
                file: path.relative(process.cwd(), filePath),
                count: transformed.transformCount,
                transformations: transformed.transformations,
              });
            }

            debugLogger.info(
              `Transformed ${transformed.transformCount} strings in ${path.basename(filePath)}`,
            );

            const finalCode = `// @i18n-transformed\n${transformed.code}`;

            return {
              contents: finalCode,
              loader: path.extname(filePath).slice(1),
            };
          }
        } catch (error) {
          const errorMsg = `Error transforming ${filePath}: ${error.message}`;
          debugLogger.error(errorMsg);
          transformationStats.errors.push(errorMsg);
        }

        return null;
      });

      // Report statistics on build end
      build.onEnd(() => {
        // Extract TOML descriptions (for report only, files not modified)
        const tomlDetails = extractTomlDescriptions();
        if (tomlDetails.length > 0) {
          transformationStats.fileDetails.push(...tomlDetails);
          const tomlCount = tomlDetails.reduce((sum, f) => sum + f.count, 0);
          debugLogger.info(`TOML descriptions extracted: ${tomlCount} from ${tomlDetails.length} files`);
        }

        debugLogger.info('='.repeat(50));
        debugLogger.info('i18n Transformation Summary:');
        debugLogger.info(
          `Files processed: ${transformationStats.filesProcessed}`,
        );
        debugLogger.info(
          `Strings transformed: ${transformationStats.stringsTransformed}`,
        );

        if (transformationStats.errors.length > 0) {
          debugLogger.warn(
            `Errors encountered: ${transformationStats.errors.length}`,
          );
          transformationStats.errors.forEach((err) => debugLogger.warn(err));
        }

        if (finalConfig.report) {
          writeTransformationReport(transformationStats);
        }

        debugLogger.info('='.repeat(50));
      });
    },
  };
}

// Helper function to check if a file needs transformation
function needsTransformation(source) {
  const patterns = [
    '<Text',
    'console.',
    'description:',
    'title:',
    'label:',
    'message:',
    // Special case patterns for exported arrays and Records
    'INFORMATIVE_TIPS',
    'WITTY_LOADING_PHRASES',
    'finishReasonMessages',
    'commandDescriptions',
  ];

  return patterns.some((pattern) => source.includes(pattern));
}

// Write transformation report to file
function writeTransformationReport(stats) {
  const jsonReportPath = path.join(process.cwd(), 'i18n-transform-report.json');
  const textReportPath = path.join(process.cwd(), 'i18n-transform-report.txt');

  try {
    fs.writeFileSync(jsonReportPath, JSON.stringify(stats, null, 2));
    debugLogger.info(`JSON report written to: ${jsonReportPath}`);

    let textReport = '='.repeat(80) + '\n';
    textReport += 'I18N TRANSFORMATION REPORT\n';
    textReport += '='.repeat(80) + '\n\n';
    textReport += `Files processed: ${stats.filesProcessed}\n`;
    textReport += `Total strings transformed: ${stats.stringsTransformed}\n`;
    textReport += `Errors: ${stats.errors.length}\n\n`;

    if (stats.fileDetails && stats.fileDetails.length > 0) {
      textReport += '-'.repeat(80) + '\n';
      textReport += 'DETAILED TRANSFORMATIONS BY FILE\n';
      textReport += '-'.repeat(80) + '\n\n';

      for (const fileInfo of stats.fileDetails) {
        textReport += `\n${fileInfo.file} (${fileInfo.count} transformations)\n`;
        textReport += '-'.repeat(60) + '\n';

        for (const tr of fileInfo.transformations) {
          textReport += `  [${tr.type}] Line ${tr.line}\n`;
          textReport += `    Original:    "${tr.original}"\n`;
          if (tr.note) {
            textReport += `    Note:        ${tr.note}\n\n`;
          } else {
            textReport += `    Transformed: t('${tr.original}')\n\n`;
          }
        }
      }
    }

    if (stats.errors.length > 0) {
      textReport += '\n' + '-'.repeat(80) + '\n';
      textReport += 'ERRORS\n';
      textReport += '-'.repeat(80) + '\n';
      for (const err of stats.errors) {
        textReport += `  ${err}\n`;
      }
    }

    fs.writeFileSync(textReportPath, textReport);
    debugLogger.info(`Text report written to: ${textReportPath}`);
  } catch (error) {
    debugLogger.error(`Failed to write report: ${error.message}`);
  }
}

/**
 * Extract descriptions from TOML files (custom commands, etc.)
 * These are user-facing strings that need translation but we don't modify the TOML files
 * @returns {Array} Array of file details with TOML descriptions
 */
function extractTomlDescriptions() {
  const tomlDetails = [];
  const tomlDirs = [
    '.gemini/commands',
    '.auditaria/commands',
    'packages/cli/src/commands/extensions/examples',
  ];

  for (const dir of tomlDirs) {
    const fullDir = path.join(process.cwd(), dir);
    if (!fs.existsSync(fullDir)) continue;

    const tomlFiles = findTomlFiles(fullDir);
    for (const tomlFile of tomlFiles) {
      try {
        const content = fs.readFileSync(tomlFile, 'utf8');
        const descriptions = parseTomlDescriptions(content);

        if (descriptions.length > 0) {
          const relativePath = path.relative(process.cwd(), tomlFile);
          tomlDetails.push({
            file: relativePath,
            count: descriptions.length,
            transformations: descriptions.map((desc) => ({
              type: 'TOML:description',
              line: desc.line,
              original: desc.value,
              note: 'Extract only - TOML file not modified',
            })),
          });
        }
      } catch (error) {
        debugLogger.warn(`Failed to parse TOML file ${tomlFile}: ${error.message}`);
      }
    }
  }

  return tomlDetails;
}

/**
 * Recursively find all .toml files in a directory
 */
function findTomlFiles(dir) {
  const files = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...findTomlFiles(fullPath));
      } else if (entry.name.endsWith('.toml')) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    // Ignore permission errors, etc.
  }
  return files;
}

/**
 * Parse description values from TOML content
 * Looks for: description = "..."
 */
function parseTomlDescriptions(content) {
  const descriptions = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match: description = "..." or description = '...'
    const match = line.match(/^\s*description\s*=\s*["'](.+?)["']\s*$/);
    if (match) {
      descriptions.push({
        line: i + 1,
        value: match[1],
      });
    }
  }

  return descriptions;
}

export default i18nTransformPlugin;
