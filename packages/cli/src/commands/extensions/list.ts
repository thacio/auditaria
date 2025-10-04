/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { loadUserExtensions, toOutputString } from '../../config/extension.js';
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
    console.log(
      extensions
        .map((extension, _): string => toOutputString(extension, process.cwd()))
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
