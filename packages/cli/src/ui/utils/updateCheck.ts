/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import updateNotifier, { UpdateInfo } from 'update-notifier';
import semver from 'semver';
import { getPackageJson } from '../../utils/package.js';
import { t } from '@thacio/auditaria-cli-core';


export interface UpdateObject {
  message: string;
  update: UpdateInfo;
}

/**
 * From a nightly and stable update, determines which is the "best" one to offer.
 * The rule is to always prefer nightly if the base versions are the same.
 */
function getBestAvailableUpdate(
  nightly?: UpdateInfo,
  stable?: UpdateInfo,
): UpdateInfo | null {
  if (!nightly) return stable || null;
  if (!stable) return nightly || null;

  const nightlyVer = nightly.latest;
  const stableVer = stable.latest;

  if (
    semver.coerce(stableVer)?.version === semver.coerce(nightlyVer)?.version
  ) {
    return nightly;
  }

  return semver.gt(stableVer, nightlyVer) ? stable : nightly;
}

export async function checkForUpdates(): Promise<UpdateObject | null> {
  try {
    // Skip update check when running from source (development mode)
    if (process.env.DEV === 'true') {
      return null;
    }
    const packageJson = await getPackageJson();
    if (!packageJson || !packageJson.name || !packageJson.version) {
      return null;
    }

    const { name, version: currentVersion } = packageJson;
    const isNightly = currentVersion.includes('nightly');
    const createNotifier = (distTag: 'latest' | 'nightly') =>
      updateNotifier({
        pkg: {
          name,
          version: currentVersion,
        },
        updateCheckInterval: 0,
        shouldNotifyInNpmScript: true,
        distTag,
      });

    if (isNightly) {
      const [nightlyUpdateInfo, latestUpdateInfo] = await Promise.all([
        createNotifier('nightly').fetchInfo(),
        createNotifier('latest').fetchInfo(),
      ]);

      const bestUpdate = getBestAvailableUpdate(
        nightlyUpdateInfo,
        latestUpdateInfo,
      );

      if (bestUpdate && semver.gt(bestUpdate.latest, currentVersion)) {
        const message = t('update.available_nightly', 'A new version of Auditaria CLI is available! {current} → {latest}', { current: currentVersion, latest: bestUpdate.latest });
        return {
          message,
          update: { ...bestUpdate, current: currentVersion },
        };
      }
    } else {
      const updateInfo = await createNotifier('latest').fetchInfo();

      if (updateInfo && semver.gt(updateInfo.latest, currentVersion)) {
        const message = t('update.available', 'Auditaria CLI update available! {current} → {latest}\nRun npm install -g {packageName} to update', { current: currentVersion, latest: updateInfo.latest, packageName: packageJson.name });
        return {
          message,
          update: { ...updateInfo, current: currentVersion },
        };
      }
    }

    return null;
  } catch (e) {
    console.warn('Failed to check for updates: ' + e);
    return null;
  }
}
