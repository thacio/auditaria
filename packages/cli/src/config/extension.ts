/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@thacio/auditaria-cli-core';

import { MCPServerConfig } from '@thacio/auditaria-cli-core';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const EXTENSIONS_DIRECTORY_NAME = path.join('.gemini', 'extensions');
export const EXTENSIONS_CONFIG_FILENAME = 'gemini-extension.json';

export interface Extension {
  config: ExtensionConfig;
  contextFiles: string[];
}

export interface ExtensionConfig {
  name: string;
  version: string;
  mcpServers?: Record<string, MCPServerConfig>;
  contextFileName?: string | string[];
  excludeTools?: string[];
}

export function loadExtensions(workspaceDir: string): Extension[] {
  const allExtensions = [
    ...loadExtensionsFromDir(workspaceDir),
    ...loadExtensionsFromDir(os.homedir()),
  ];

  const uniqueExtensions = new Map<string, Extension>();
  for (const extension of allExtensions) {
    if (!uniqueExtensions.has(extension.config.name)) {
      console.log(
        t('extension.loading', 'Loading extension: {name} (version: {version})', { name: extension.config.name, version: extension.config.version }),
      );
      uniqueExtensions.set(extension.config.name, extension);
    }
  }

  return Array.from(uniqueExtensions.values());
}

function loadExtensionsFromDir(dir: string): Extension[] {
  const extensionsDir = path.join(dir, EXTENSIONS_DIRECTORY_NAME);
  if (!fs.existsSync(extensionsDir)) {
    return [];
  }

  const extensions: Extension[] = [];
  for (const subdir of fs.readdirSync(extensionsDir)) {
    const extensionDir = path.join(extensionsDir, subdir);

    const extension = loadExtension(extensionDir);
    if (extension != null) {
      extensions.push(extension);
    }
  }
  return extensions;
}

function loadExtension(extensionDir: string): Extension | null {
  if (!fs.statSync(extensionDir).isDirectory()) {
    console.error(
      t('extension.unexpected_file', 'Warning: unexpected file {path} in extensions directory.', { path: extensionDir }),
    );
    return null;
  }

  const configFilePath = path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME);
  if (!fs.existsSync(configFilePath)) {
    console.error(
      t('extension.missing_config', 'Warning: extension directory {dir} does not contain a config file {config}.', { dir: extensionDir, config: configFilePath }),
    );
    return null;
  }

  try {
    const configContent = fs.readFileSync(configFilePath, 'utf-8');
    const config = JSON.parse(configContent) as ExtensionConfig;
    if (!config.name || !config.version) {
      console.error(
        t('extension.invalid_config', 'Invalid extension config in {path}: missing name or version.', { path: configFilePath }),
      );
      return null;
    }

    const contextFiles = getContextFileNames(config)
      .map((contextFileName) => path.join(extensionDir, contextFileName))
      .filter((contextFilePath) => fs.existsSync(contextFilePath));

    return {
      config,
      contextFiles,
    };
  } catch (e) {
    console.error(
      t('extension.parse_error', 'Warning: error parsing extension config in {path}: {error}', { path: configFilePath, error: String(e) }),
    );
    return null;
  }
}

function getContextFileNames(config: ExtensionConfig): string[] {
  if (!config.contextFileName) {
    return ['GEMINI.md'];
  } else if (!Array.isArray(config.contextFileName)) {
    return [config.contextFileName];
  }
  return config.contextFileName;
}

export function filterActiveExtensions(
  extensions: Extension[],
  enabledExtensionNames: string[],
): Extension[] {
  if (enabledExtensionNames.length === 0) {
    return extensions;
  }

  const lowerCaseEnabledExtensions = new Set(
    enabledExtensionNames.map((e) => e.trim().toLowerCase()),
  );

  if (
    lowerCaseEnabledExtensions.size === 1 &&
    lowerCaseEnabledExtensions.has('none')
  ) {
    if (extensions.length > 0) {
      console.log(t('extension.all_disabled', 'All extensions are disabled.'));
    }
    return [];
  }

  const activeExtensions: Extension[] = [];
  const notFoundNames = new Set(lowerCaseEnabledExtensions);

  for (const extension of extensions) {
    const lowerCaseName = extension.config.name.toLowerCase();
    if (lowerCaseEnabledExtensions.has(lowerCaseName)) {
      console.log(
        t('extension.activated', 'Activated extension: {name} (version: {version})', { name: extension.config.name, version: extension.config.version }),
      );
      activeExtensions.push(extension);
      notFoundNames.delete(lowerCaseName);
    } else {
      console.log(t('extension.disabled', 'Disabled extension: {name}', { name: extension.config.name }));
    }
  }

  for (const requestedName of notFoundNames) {
    console.log(t('extension.not_found', 'Extension not found: {name}', { name: requestedName }));
  }

  return activeExtensions;
}
