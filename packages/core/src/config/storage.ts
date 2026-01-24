/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import {
  AUDITARIA_DIR, // AUDITARIA_FEATURE
  resolveConfigDir, // AUDITARIA_FEATURE
  getConfigDirFallbacks, // AUDITARIA_FEATURE
  homedir, // Added from upstream for test isolation
} from '../utils/paths.js';

export const GOOGLE_ACCOUNTS_FILENAME = 'google_accounts.json';
export const OAUTH_FILE = 'oauth_creds.json';
const TMP_DIR_NAME = 'tmp';
const BIN_DIR_NAME = 'bin';

export class Storage {
  private readonly targetDir: string;

  constructor(targetDir: string) {
    this.targetDir = targetDir;
  }

  // AUDITARIA_MODIFY_START: Use fallback resolution for global config directory
  static getGlobalGeminiDir(): string {
    const homeDir = homedir();
    if (!homeDir) {
      return path.join(os.tmpdir(), AUDITARIA_DIR);
    }
    const configDir = resolveConfigDir(homeDir);
    return path.join(homeDir, configDir);
  }

  static getGlobalConfigDirFallbacks(): string[] {
    const homeDir = os.homedir();
    if (!homeDir) {
      return [path.join(os.tmpdir(), AUDITARIA_DIR)];
    }
    return getConfigDirFallbacks().map((dir) => path.join(homeDir, dir));
    // AUDITARIA_MODIFY_END
  }

  static getMcpOAuthTokensPath(): string {
    return path.join(Storage.getGlobalGeminiDir(), 'mcp-oauth-tokens.json');
  }

  // AUDITARIA_MODIFY_START: Check for settings.json in both directories, file-level fallback
  static getGlobalSettingsPath(): string {
    const homeDir = os.homedir();
    if (!homeDir) {
      return path.join(os.tmpdir(), AUDITARIA_DIR, 'settings.json');
    }
    // Check for settings.json file in each config directory
    for (const configDir of getConfigDirFallbacks()) {
      const settingsPath = path.join(homeDir, configDir, 'settings.json');
      if (fs.existsSync(settingsPath)) {
        return settingsPath;
      }
    }
    // Default to auditaria for new installations
    return path.join(homeDir, AUDITARIA_DIR, 'settings.json');
  }
  // AUDITARIA_MODIFY_END

  static getInstallationIdPath(): string {
    return path.join(Storage.getGlobalGeminiDir(), 'installation_id');
  }

  static getGoogleAccountsPath(): string {
    return path.join(Storage.getGlobalGeminiDir(), GOOGLE_ACCOUNTS_FILENAME);
  }

  static getUserCommandsDir(): string {
    return path.join(Storage.getGlobalGeminiDir(), 'commands');
  }

  static getUserSkillsDir(): string {
    return path.join(Storage.getGlobalGeminiDir(), 'skills');
  }

  static getGlobalMemoryFilePath(): string {
    return path.join(Storage.getGlobalGeminiDir(), 'memory.md');
  }

  static getUserPoliciesDir(): string {
    return path.join(Storage.getGlobalGeminiDir(), 'policies');
  }

  static getUserAgentsDir(): string {
    return path.join(Storage.getGlobalGeminiDir(), 'agents');
  }

  // AUDITARIA_MODIFY_START: Updated system settings paths with fallback to legacy gemini-cli paths
  static getSystemSettingsPath(): string {
    if (process.env['GEMINI_CLI_SYSTEM_SETTINGS_PATH']) {
      return process.env['GEMINI_CLI_SYSTEM_SETTINGS_PATH'];
    }
    // Check auditaria paths first, then fall back to gemini-cli
    if (os.platform() === 'darwin') {
      const auditariaPath =
        '/Library/Application Support/AuditariaCli/settings.json';
      const geminiPath = '/Library/Application Support/GeminiCli/settings.json';
      if (fs.existsSync(auditariaPath)) return auditariaPath;
      if (fs.existsSync(geminiPath)) return geminiPath;
      return auditariaPath; // Default to auditaria for new installations
    } else if (os.platform() === 'win32') {
      const auditariaPath = 'C:\\ProgramData\\auditaria-cli\\settings.json';
      const geminiPath = 'C:\\ProgramData\\gemini-cli\\settings.json';
      if (fs.existsSync(auditariaPath)) return auditariaPath;
      if (fs.existsSync(geminiPath)) return geminiPath;
      return auditariaPath; // Default to auditaria for new installations
    } else {
      const auditariaPath = '/etc/auditaria-cli/settings.json';
      const geminiPath = '/etc/gemini-cli/settings.json';
      if (fs.existsSync(auditariaPath)) return auditariaPath;
      if (fs.existsSync(geminiPath)) return geminiPath;
      return auditariaPath; // Default to auditaria for new installations
    }
  }
  // AUDITARIA_MODIFY_END

  static getSystemPoliciesDir(): string {
    return path.join(path.dirname(Storage.getSystemSettingsPath()), 'policies');
  }

  static getGlobalTempDir(): string {
    return path.join(Storage.getGlobalGeminiDir(), TMP_DIR_NAME);
  }

  static getGlobalBinDir(): string {
    return path.join(Storage.getGlobalTempDir(), BIN_DIR_NAME);
  }

  // AUDITARIA_MODIFY_START: Use fallback resolution for project config directory
  getGeminiDir(): string {
    const configDir = resolveConfigDir(this.targetDir);
    return path.join(this.targetDir, configDir);
  }

  // AUDITARIA: Get all possible project config directories for searching
  getConfigDirFallbacks(): string[] {
    return getConfigDirFallbacks().map((dir) => path.join(this.targetDir, dir));
  }
  // AUDITARIA_MODIFY_END

  getProjectTempDir(): string {
    const hash = this.getFilePathHash(this.getProjectRoot());
    const tempDir = Storage.getGlobalTempDir();
    return path.join(tempDir, hash);
  }

  ensureProjectTempDirExists(): void {
    fs.mkdirSync(this.getProjectTempDir(), { recursive: true });
  }

  static getOAuthCredsPath(): string {
    return path.join(Storage.getGlobalGeminiDir(), OAUTH_FILE);
  }

  getProjectRoot(): string {
    return this.targetDir;
  }

  private getFilePathHash(filePath: string): string {
    return crypto.createHash('sha256').update(filePath).digest('hex');
  }

  getHistoryDir(): string {
    const hash = this.getFilePathHash(this.getProjectRoot());
    const historyDir = path.join(Storage.getGlobalGeminiDir(), 'history');
    return path.join(historyDir, hash);
  }

  // AUDITARIA_MODIFY_START: Check for settings.json in both directories, file-level fallback
  getWorkspaceSettingsPath(): string {
    // Check for settings.json file in each config directory
    for (const configDir of getConfigDirFallbacks()) {
      const settingsPath = path.join(
        this.targetDir,
        configDir,
        'settings.json',
      );
      if (fs.existsSync(settingsPath)) {
        return settingsPath;
      }
    }
    // Default to auditaria for new installations
    return path.join(this.targetDir, AUDITARIA_DIR, 'settings.json');
  }
  // AUDITARIA_MODIFY_END

  getProjectCommandsDir(): string {
    return path.join(this.getGeminiDir(), 'commands');
  }

  getProjectSkillsDir(): string {
    return path.join(this.getGeminiDir(), 'skills');
  }

  getProjectAgentsDir(): string {
    return path.join(this.getGeminiDir(), 'agents');
  }

  getProjectTempCheckpointsDir(): string {
    return path.join(this.getProjectTempDir(), 'checkpoints');
  }

  getExtensionsDir(): string {
    return path.join(this.getGeminiDir(), 'extensions');
  }

  getExtensionsConfigPath(): string {
    return path.join(this.getExtensionsDir(), 'gemini-extension.json');
  }

  getHistoryFilePath(): string {
    return path.join(this.getProjectTempDir(), 'shell_history');
  }
}
