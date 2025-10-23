/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import {
  loadExtensions,
  requestConsentNonInteractive,
} from '../../config/extension.js';
import { debugLogger, t } from '@thacio/auditaria-cli-core';
import {
  updateAllUpdatableExtensions,
  type ExtensionUpdateInfo,
  checkForAllExtensionUpdates,
  updateExtension,
} from '../../config/extensions/update.js';
import { checkForExtensionUpdate } from '../../config/extensions/github.js';
import { getErrorMessage } from '../../utils/errors.js';
import { ExtensionUpdateState } from '../../ui/state/extensions.js';
import { ExtensionEnablementManager } from '../../config/extensions/extensionEnablement.js';

interface UpdateArgs {
  name?: string;
  all?: boolean;
}

const updateOutput = (info: ExtensionUpdateInfo) =>
  t(
    'commands.extensions.update.success',
    `Extension "${info.name}" successfully updated: ${info.originalVersion} → ${info.updatedVersion}.`,
    {
      name: info.name,
      originalVersion: info.originalVersion,
      updatedVersion: info.updatedVersion,
    },
  );

export async function handleUpdate(args: UpdateArgs) {
  const workingDir = process.cwd();
  const extensionEnablementManager = new ExtensionEnablementManager(
    // Force enable named extensions, otherwise we will only update the enabled
    // ones.
    args.name ? [args.name] : [],
  );
  const extensions = loadExtensions(extensionEnablementManager);
  if (args.name) {
    try {
      const extension = extensions.find(
        (extension) => extension.name === args.name,
      );
      if (!extension) {
        debugLogger.log(
          t(
            'commands.extensions.update.extension_not_found',
            `Extension "${args.name}" not found.`,
            { name: args.name },
          ),
        );
        return;
      }
      if (!extension.installMetadata) {
        debugLogger.log(
          t(
            'commands.extensions.update.missing_install_metadata',
            `Unable to install extension "${args.name}" due to missing install metadata`,
            { name: args.name },
          ),
        );
        return;
      }
      const updateState = await checkForExtensionUpdate(
        extension,
        extensionEnablementManager,
      );
      if (updateState !== ExtensionUpdateState.UPDATE_AVAILABLE) {
        debugLogger.log(
          t(
            'commands.extensions.update.already_up_to_date',
            `Extension "${args.name}" is already up to date.`,
            { name: args.name },
          ),
        );
        return;
      }
      // TODO(chrstnb): we should list extensions if the requested extension is not installed.
      const updatedExtensionInfo = (await updateExtension(
        extension,
        extensionEnablementManager,
        workingDir,
        requestConsentNonInteractive,
        updateState,
        () => {},
      ))!;
      if (
        updatedExtensionInfo.originalVersion !==
        updatedExtensionInfo.updatedVersion
      ) {
        debugLogger.log(updateOutput(updatedExtensionInfo));
      } else {
        debugLogger.log(
          t(
            'commands.extensions.update.already_up_to_date',
            `Extension "${args.name}" is already up to date.`,
            { name: args.name },
          ),
        );
      }
    } catch (error) {
      debugLogger.error(getErrorMessage(error));
    }
  }
  if (args.all) {
    try {
      const extensionState = new Map();
      await checkForAllExtensionUpdates(
        extensions,
        extensionEnablementManager,
        (action) => {
          if (action.type === 'SET_STATE') {
            extensionState.set(action.payload.name, {
              status: action.payload.state,
            });
          }
        },
        workingDir,
      );
      let updateInfos = await updateAllUpdatableExtensions(
        workingDir,
        requestConsentNonInteractive,
        extensions,
        extensionState,
        extensionEnablementManager,
        () => {},
      );
      updateInfos = updateInfos.filter(
        (info) => info.originalVersion !== info.updatedVersion,
      );
      if (updateInfos.length === 0) {
        debugLogger.log(
          t(
            'commands.extensions.update.no_extensions',
            'No extensions to update.',
          ),
        );
        return;
      }
      debugLogger.log(updateInfos.map((info) => updateOutput(info)).join('\n'));
    } catch (error) {
      debugLogger.error(getErrorMessage(error));
    }
  }
}

export const updateCommand: CommandModule = {
  command: 'update [<name>] [--all]',
  describe: t(
    'commands.extensions.update.description',
    'Updates all extensions or a named extension to the latest version.',
  ),
  builder: (yargs) =>
    yargs
      .positional('name', {
        describe: t(
          'commands.extensions.update.name_description',
          'The name of the extension to update.',
        ),
        type: 'string',
      })
      .option('all', {
        describe: t(
          'commands.extensions.update.all_description',
          'Update all extensions.',
        ),
        type: 'boolean',
      })
      .conflicts('name', 'all')
      .check((argv) => {
        if (!argv.all && !argv.name) {
          throw new Error(
            t(
              'commands.extensions.update.missing_argument',
              'Either an extension name or --all must be provided',
            ),
          );
        }
        return true;
      }),
  handler: async (argv) => {
    await handleUpdate({
      name: argv['name'] as string | undefined,
      all: argv['all'] as boolean | undefined,
    });
  },
};
