/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@thacio/auditaria-cli-core';

import fs from 'fs/promises';
import * as os from 'os';
import semver from 'semver';

type WarningCheck = {
  id: string;
  check: (workspaceRoot: string) => Promise<string | null>;
};

// Individual warning checks
const homeDirectoryCheck: WarningCheck = {
  id: 'home-directory',
  check: async (workspaceRoot: string) => {
    try {
      const [workspaceRealPath, homeRealPath] = await Promise.all([
        fs.realpath(workspaceRoot),
        fs.realpath(os.homedir()),
      ]);

      if (workspaceRealPath === homeRealPath) {
        return t('startup.home_directory_warning', 'You are running Gemini CLI in your home directory. It is recommended to run in a project-specific directory.');
      }
      return null;
    } catch (_err: unknown) {
      return t('startup.directory_verification_error', 'Could not verify the current directory due to a file system error.');
    }
  },
};

const nodeVersionCheck: WarningCheck = {
  id: 'node-version',
  check: async (_workspaceRoot: string) => {
    const minMajor = 20;
    const major = semver.major(process.versions.node);
    if (major < minMajor) {
      return t('startup.node_version_warning', 'You are using Node.js v{currentVersion}. Gemini CLI requires Node.js {minVersion} or higher for best results.', {
        currentVersion: process.versions.node,
        minVersion: minMajor.toString()
      });
    }
    return null;
  },
};

// All warning checks
const WARNING_CHECKS: readonly WarningCheck[] = [
  homeDirectoryCheck,
  nodeVersionCheck,
];

export async function getUserStartupWarnings(
  workspaceRoot: string,
): Promise<string[]> {
  const results = await Promise.all(
    WARNING_CHECKS.map((check) => check.check(workspaceRoot)),
  );
  return results.filter((msg) => msg !== null);
}
