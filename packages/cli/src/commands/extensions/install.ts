/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import {
  debugLogger,
  t,
  type ExtensionInstallMetadata,
} from '@thacio/auditaria-cli-core';
import { getErrorMessage } from '../../utils/errors.js';
import { stat } from 'node:fs/promises';
import {
  INSTALL_WARNING_MESSAGE,
  requestConsentNonInteractive,
} from '../../config/extensions/consent.js';
import { ExtensionManager } from '../../config/extension-manager.js';
import { loadSettings } from '../../config/settings.js';
import { promptForSetting } from '../../config/extensions/extensionSettings.js';

interface InstallArgs {
  source: string;
  ref?: string;
  autoUpdate?: boolean;
  allowPreRelease?: boolean;
  consent?: boolean;
}

export async function handleInstall(args: InstallArgs) {
  try {
    let installMetadata: ExtensionInstallMetadata;
    const { source } = args;
    if (
      source.startsWith('http://') ||
      source.startsWith('https://') ||
      source.startsWith('git@') ||
      source.startsWith('sso://')
    ) {
      installMetadata = {
        source,
        type: 'git',
        ref: args.ref,
        autoUpdate: args.autoUpdate,
        allowPreRelease: args.allowPreRelease,
      };
    } else {
      if (args.ref || args.autoUpdate) {
        throw new Error(
          t(
            'commands.extensions.install.local_no_ref_auto_update',
            '--ref and --auto-update are not applicable for local extensions.',
          ),
        );
      }
      try {
        await stat(source);
        installMetadata = {
          source,
          type: 'local',
        };
      } catch {
        throw new Error(
          t(
            'commands.extensions.install.source_not_found',
            'Install source not found.',
          ),
        );
      }
    }

    const requestConsent = args.consent
      ? () => Promise.resolve(true)
      : requestConsentNonInteractive;
    if (args.consent) {
      debugLogger.log(
        t(
          'commands.extensions.install.consent_message',
          'You have consented to the following:',
        ),
      );
      debugLogger.log(INSTALL_WARNING_MESSAGE);
    }

    const workspaceDir = process.cwd();
    const extensionManager = new ExtensionManager({
      workspaceDir,
      requestConsent,
      requestSetting: promptForSetting,
      settings: loadSettings(workspaceDir).merged,
    });
    await extensionManager.loadExtensions();
    const name: string =
      await extensionManager.installOrUpdateExtension(installMetadata);
    debugLogger.log(
      t(
        'commands.extensions.install.success',
        `Extension "${name}" installed successfully and enabled.`,
        { extensionName: name as string },
      ),
    );
  } catch (error) {
    debugLogger.error(getErrorMessage(error));
    process.exit(1);
  }
}

export const installCommand: CommandModule = {
  command: 'install <source> [--auto-update] [--pre-release]',
  describe: t(
    'commands.extensions.install.description',
    'Installs an extension from a git repository URL or a local path.',
  ),
  builder: (yargs) =>
    yargs
      .positional('source', {
        describe: t(
          'commands.extensions.install.source_description',
          'The github URL or local path of the extension to install.',
        ),
        type: 'string',
        demandOption: true,
      })
      .option('ref', {
        describe: t(
          'commands.extensions.install.ref_description',
          'The git ref to install from.',
        ),
        type: 'string',
      })
      .option('auto-update', {
        describe: t(
          'commands.extensions.install.auto_update_description',
          'Enable auto-update for this extension.',
        ),
        type: 'boolean',
      })
      .option('pre-release', {
        describe: t(
          'commands.extensions.install.pre_release_description',
          'Enable pre-release versions for this extension.',
        ),
        type: 'boolean',
      })
      .option('consent', {
        describe: t(
          'commands.extensions.install.consent_description',
          'Acknowledge the security risks of installing an extension and skip the confirmation prompt.',
        ),
        type: 'boolean',
        default: false,
      })
      .check((argv) => {
        if (!argv.source) {
          throw new Error(
            t(
              'commands.extensions.install.source_required',
              'The source argument must be provided.',
            ),
          );
        }
        return true;
      }),
  handler: async (argv) => {
    await handleInstall({
      source: argv['source'] as string,
      ref: argv['ref'] as string | undefined,
      autoUpdate: argv['auto-update'] as boolean | undefined,
      allowPreRelease: argv['pre-release'] as boolean | undefined,
      consent: argv['consent'] as boolean | undefined,
    });
  },
};
