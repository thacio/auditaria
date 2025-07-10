/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import updateNotifier from 'update-notifier';
import semver from 'semver';
import { getPackageJson } from '../../utils/package.js';
import { t } from '@thacio/auditaria-cli-core';

export async function checkForUpdates(): Promise<string | null> {
  try {
    const packageJson = await getPackageJson();
    if (!packageJson || !packageJson.name || !packageJson.version) {
      return null;
    }
    const notifier = updateNotifier({
      pkg: {
        name: packageJson.name,
        version: packageJson.version,
      },
      // check every time
      updateCheckInterval: 0,
      // allow notifier to run in scripts
      shouldNotifyInNpmScript: true,
    });

    if (
      notifier.update &&
      semver.gt(notifier.update.latest, notifier.update.current)
    ) {
      return t('update.available', 'Gemini CLI update available! {current} → {latest}\nRun npm install -g {packageName} to update', { current: notifier.update.current, latest: notifier.update.latest, packageName: packageJson.name });
    }

    return null;
  } catch (e) {
    console.warn('Failed to check for updates: ' + e);
    return null;
  }
}
