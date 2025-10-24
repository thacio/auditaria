/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { getErrorMessage } from '../../utils/errors.js';
import { debugLogger, t } from '@thacio/auditaria-cli-core';
import { ExtensionManager } from '../../config/extension-manager.js';
import { requestConsentNonInteractive } from '../../config/extensions/consent.js';
import { loadSettings } from '../../config/settings.js';
import { promptForSetting } from '../../config/extensions/extensionSettings.js';

export async function handleList() {
  try {
    const workspaceDir = process.cwd();
    const extensionManager = new ExtensionManager({
      workspaceDir,
      requestConsent: requestConsentNonInteractive,
      requestSetting: promptForSetting,
      loadedSettings: loadSettings(workspaceDir),
    });
    const extensions = extensionManager.loadExtensions();
    if (extensions.length === 0) {
      debugLogger.log(
        t('commands.extensions.list.no_extensions', 'No extensions installed.'),
      );
      return;
    }
    debugLogger.log(
      extensions
        .map((extension, _): string =>
          extensionManager.toOutputString(extension),
        )
        .join('\n\n'),
    );
  } catch (error) {
    debugLogger.error(getErrorMessage(error));
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
