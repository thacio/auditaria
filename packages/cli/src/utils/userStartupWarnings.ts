/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@google/gemini-cli-core';

import fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';

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

const rootDirectoryCheck: WarningCheck = {
  id: 'root-directory',
  check: async (workspaceRoot: string) => {
    try {
      const workspaceRealPath = await fs.realpath(workspaceRoot);

      // Check for Unix root directory
      if (path.dirname(workspaceRealPath) === workspaceRealPath) {
        return t('startup.root_directory_warning', 'Warning: You are running Auditaria CLI in the root directory. Your entire folder structure will be used for context. It is strongly recommended to run in a project-specific directory.');
      }

      return null;
    } catch (_err: unknown) {
      return t('startup.directory_verification_error', 'Could not verify the current directory due to a file system error.');
    }
  },
};

// All warning checks
const WARNING_CHECKS: readonly WarningCheck[] = [
  homeDirectoryCheck,
  rootDirectoryCheck,
];

export async function getUserStartupWarnings(
  workspaceRoot: string,
): Promise<string[]> {
  const results = await Promise.all(
    WARNING_CHECKS.map((check) => check.check(workspaceRoot)),
  );
  return results.filter((msg) => msg !== null);
}
