/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import {
  loadUserExtensions,
  toOutputString,
  ExtensionStorage,
} from '../../config/extension.js';
import { ExtensionEnablementManager } from '../../config/extensions/extensionEnablement.js';
import { t } from '@thacio/auditaria-cli-core';
import { getErrorMessage } from '../../utils/errors.js';

export async function handleList() {
  try {
    const extensions = loadUserExtensions();
    if (extensions.length === 0) {
      console.log(
        t('commands.extensions.list.no_extensions', 'No extensions installed.'),
      );
      return;
    }
    const manager = new ExtensionEnablementManager(
      ExtensionStorage.getUserExtensionsDir(),
    );
    const cwd = process.cwd();
    console.log(
      extensions
        .map((extension): string => {
          const isEnabled = manager.isEnabled(extension.config.name, cwd);
          return toOutputString(extension, isEnabled);
        })
        .join('\n\n'),
    );
  } catch (error) {
    console.error(getErrorMessage(error));
    process.exit(1);
  }
}

export const listCommand: CommandModule = {
  command: 'list',
  describe: t(
    'commands.extensions.list.description',
    'Lists installed extensions.',
  ),
  builder: (yargs) => yargs,
  handler: async () => {
    await handleList();
  },
};
