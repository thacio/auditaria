/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { debugLogger, t } from '@google/gemini-cli-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import semver from 'semver';
import { getErrorMessage } from '../../utils/errors.js';
import type { ExtensionConfig } from '../../config/extension.js';
import { ExtensionManager } from '../../config/extension-manager.js';
import { requestConsentNonInteractive } from '../../config/extensions/consent.js';
import { promptForSetting } from '../../config/extensions/extensionSettings.js';
import { loadSettings } from '../../config/settings.js';

interface ValidateArgs {
  path: string;
}

export async function handleValidate(args: ValidateArgs) {
  try {
    await validateExtension(args);
    debugLogger.log(
      t(
        'commands.extensions.validate.success',
        `Extension ${args.path} has been successfully validated.`,
        { path: args.path },
      ),
    );
  } catch (error) {
    debugLogger.error(getErrorMessage(error));
    process.exit(1);
  }
}

async function validateExtension(args: ValidateArgs) {
  const workspaceDir = process.cwd();
  const extensionManager = new ExtensionManager({
    workspaceDir,
    requestConsent: requestConsentNonInteractive,
    requestSetting: promptForSetting,
    settings: loadSettings(workspaceDir).merged,
  });
  const absoluteInputPath = path.resolve(args.path);
  const extensionConfig: ExtensionConfig =
    extensionManager.loadExtensionConfig(absoluteInputPath);
  const warnings: string[] = [];
  const errors: string[] = [];

  if (extensionConfig.contextFileName) {
    const contextFileNames = Array.isArray(extensionConfig.contextFileName)
      ? extensionConfig.contextFileName
      : [extensionConfig.contextFileName];

    const missingContextFiles: string[] = [];
    for (const contextFilePath of contextFileNames) {
      const contextFileAbsolutePath = path.resolve(
        absoluteInputPath,
        contextFilePath,
      );
      if (!fs.existsSync(contextFileAbsolutePath)) {
        missingContextFiles.push(contextFilePath);
      }
    }
    if (missingContextFiles.length > 0) {
      errors.push(
        t(
          'commands.extensions.validate.missing_context_files',
          `The following context files referenced in gemini-extension.json are missing: ${missingContextFiles}`,
          { files: missingContextFiles.join(', ') },
        ),
      );
    }
  }

  if (!semver.valid(extensionConfig.version)) {
    warnings.push(
      t(
        'commands.extensions.validate.invalid_semver',
        `Warning: Version '${extensionConfig.version}' does not appear to be standard semver (e.g., 1.0.0).`,
        { version: extensionConfig.version },
      ),
    );
  }

  if (warnings.length > 0) {
    debugLogger.warn(
      t('commands.extensions.validate.warnings_header', 'Validation warnings:'),
    );
    for (const warning of warnings) {
      debugLogger.warn(`  - ${warning}`);
    }
  }

  if (errors.length > 0) {
    debugLogger.error(
      t(
        'commands.extensions.validate.errors_header',
        'Validation failed with the following errors:',
      ),
    );
    for (const error of errors) {
      debugLogger.error(`  - ${error}`);
    }
    throw new Error(
      t('commands.extensions.validate.failed', 'Extension validation failed.'),
    );
  }
}

export const validateCommand: CommandModule = {
  command: 'validate <path>',
  describe: t(
    'commands.extensions.validate.description',
    'Validates an extension from a local path.',
  ),
  builder: (yargs) =>
    yargs.positional('path', {
      describe: t(
        'commands.extensions.validate.path_description',
        'The path of the extension to validate.',
      ),
      type: 'string',
      demandOption: true,
    }),
  handler: async (args) => {
    await handleValidate({
      path: args['path'] as string,
    });
  },
};
