/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { 
  t,
  MCPServerConfig, 
  GeminiCLIExtension,
  Storage,
} from '@google/gemini-cli-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { simpleGit } from 'simple-git';

export const EXTENSIONS_DIRECTORY_NAME = '.gemini/extensions';

export const EXTENSIONS_CONFIG_FILENAME = 'gemini-extension.json';
export const INSTALL_METADATA_FILENAME = '.gemini-extension-install.json';

export interface Extension {
  path: string;
  config: ExtensionConfig;
  contextFiles: string[];
  installMetadata?: ExtensionInstallMetadata | undefined;
}

export interface ExtensionConfig {
  name: string;
  version: string;
  mcpServers?: Record<string, MCPServerConfig>;
  contextFileName?: string | string[];
  excludeTools?: string[];
}

export interface ExtensionInstallMetadata {
  source: string;
  type: 'git' | 'local';
}

export interface ExtensionUpdateInfo {
  originalVersion: string;
  updatedVersion: string;
}

export class ExtensionStorage {
  private readonly extensionName: string;

  constructor(extensionName: string) {
    this.extensionName = extensionName;
  }

  getExtensionDir(): string {
    return path.join(
      ExtensionStorage.getUserExtensionsDir(),
      this.extensionName,
    );
  }

  getConfigPath(): string {
    return path.join(this.getExtensionDir(), EXTENSIONS_CONFIG_FILENAME);
  }

  static getSettingsPath(): string {
    return process.cwd();
  }

  static getUserExtensionsDir(): string {
    const storage = new Storage(os.homedir());
    return storage.getExtensionsDir();
  }

  static async createTmpDir(): Promise<string> {
    return await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'gemini-extension'),
    );
  }
}

export function loadExtensions(workspaceDir: string): Extension[] {
  const allExtensions = [
    ...loadExtensionsFromDir(workspaceDir),
    ...loadExtensionsFromDir(os.homedir()),
  ];

  const uniqueExtensions = new Map<string, Extension>();
  for (const extension of allExtensions) {
    if (!uniqueExtensions.has(extension.config.name)) {
      uniqueExtensions.set(extension.config.name, extension);
    }
  }

  return Array.from(uniqueExtensions.values());
}

export function loadUserExtensions(): Extension[] {
  const userExtensions = loadExtensionsFromDir(os.homedir());

  const uniqueExtensions = new Map<string, Extension>();
  for (const extension of userExtensions) {
    if (!uniqueExtensions.has(extension.config.name)) {
      uniqueExtensions.set(extension.config.name, extension);
    }
  }

  return Array.from(uniqueExtensions.values());
}

export function loadExtensionsFromDir(dir: string): Extension[] {
  const storage = new Storage(dir);
  const extensionsDir = storage.getExtensionsDir();
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

export function loadExtension(extensionDir: string): Extension | null {
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
      path: extensionDir,
      config,
      contextFiles,
      installMetadata: loadInstallMetadata(extensionDir),
    };
  } catch (e) {
    console.error(
      t('extension.parse_error', 'Warning: error parsing extension config in {path}: {error}', { path: configFilePath, error: String(e) }),
    );
    return null;
  }
}

function loadInstallMetadata(
  extensionDir: string,
): ExtensionInstallMetadata | undefined {
  const metadataFilePath = path.join(extensionDir, INSTALL_METADATA_FILENAME);
  try {
    const configContent = fs.readFileSync(metadataFilePath, 'utf-8');
    const metadata = JSON.parse(configContent) as ExtensionInstallMetadata;
    return metadata;
  } catch (_e) {
    return undefined;
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

export function annotateActiveExtensions(
  extensions: Extension[],
  enabledExtensionNames: string[],
): GeminiCLIExtension[] {
  const annotatedExtensions: GeminiCLIExtension[] = [];

  if (enabledExtensionNames.length === 0) {
    return extensions.map((extension) => ({
      name: extension.config.name,
      version: extension.config.version,
      isActive: true,
      path: extension.path,
    }));
  }

  const lowerCaseEnabledExtensions = new Set(
    enabledExtensionNames.map((e) => e.trim().toLowerCase()),
  );

  if (
    lowerCaseEnabledExtensions.size === 1 &&
    lowerCaseEnabledExtensions.has('none')
  ) {
    return extensions.map((extension) => ({
      name: extension.config.name,
      version: extension.config.version,
      isActive: false,
      path: extension.path,
    }));
  }

  const notFoundNames = new Set(lowerCaseEnabledExtensions);

  for (const extension of extensions) {
    const lowerCaseName = extension.config.name.toLowerCase();
    const isActive = lowerCaseEnabledExtensions.has(lowerCaseName);

    if (isActive) {
      notFoundNames.delete(lowerCaseName);
    }

    annotatedExtensions.push({
      name: extension.config.name,
      version: extension.config.version,
      isActive,
      path: extension.path,
    });
  }

  for (const requestedName of notFoundNames) {
    console.error(t('extension.not_found', 'Extension not found: {name}', { name: requestedName }));
  }

  return annotatedExtensions;
}

/**
 * Clones a Git repository to a specified local path.
 * @param gitUrl The Git URL to clone.
 * @param destination The destination path to clone the repository to.
 */
async function cloneFromGit(
  gitUrl: string,
  destination: string,
): Promise<void> {
  try {
    // TODO(chrstnb): Download the archive instead to avoid unnecessary .git info.
    await simpleGit().clone(gitUrl, destination, ['--depth', '1']);
  } catch (error) {
    throw new Error(`Failed to clone Git repository from ${gitUrl}`, {
      cause: error,
    });
  }
}

/**
 * Copies an extension from a source to a destination path.
 * @param source The source path of the extension.
 * @param destination The destination path to copy the extension to.
 */
async function copyExtension(
  source: string,
  destination: string,
): Promise<void> {
  await fs.promises.cp(source, destination, { recursive: true });
}

export async function installExtension(
  installMetadata: ExtensionInstallMetadata,
): Promise<string> {
  const extensionsDir = ExtensionStorage.getUserExtensionsDir();
  await fs.promises.mkdir(extensionsDir, { recursive: true });

  // Convert relative paths to absolute paths for the metadata file.
  if (
    installMetadata.type === 'local' &&
    !path.isAbsolute(installMetadata.source)
  ) {
    installMetadata.source = path.resolve(
      process.cwd(),
      installMetadata.source,
    );
  }

  let localSourcePath: string;
  let tempDir: string | undefined;
  if (installMetadata.type === 'git') {
    tempDir = await ExtensionStorage.createTmpDir();
    await cloneFromGit(installMetadata.source, tempDir);
    localSourcePath = tempDir;
  } else {
    localSourcePath = installMetadata.source;
  }
  let newExtensionName: string | undefined;
  try {
    const newExtension = loadExtension(localSourcePath);
    if (!newExtension) {
      throw new Error(
        `Invalid extension at ${installMetadata.source}. Please make sure it has a valid gemini-extension.json file.`,
      );
    }

    // ~/.gemini/extensions/{ExtensionConfig.name}.
    newExtensionName = newExtension.config.name;
    const extensionStorage = new ExtensionStorage(newExtensionName);
    const destinationPath = extensionStorage.getExtensionDir();

    const installedExtensions = loadUserExtensions();
    if (
      installedExtensions.some(
        (installed) => installed.config.name === newExtensionName,
      )
    ) {
      throw new Error(
        `Extension "${newExtensionName}" is already installed. Please uninstall it first.`,
      );
    }

    await copyExtension(localSourcePath, destinationPath);

    const metadataString = JSON.stringify(installMetadata, null, 2);
    const metadataPath = path.join(destinationPath, INSTALL_METADATA_FILENAME);
    await fs.promises.writeFile(metadataPath, metadataString);
  } finally {
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  }

  return newExtensionName;
}

export async function uninstallExtension(extensionName: string): Promise<void> {
  const installedExtensions = loadUserExtensions();
  if (
    !installedExtensions.some(
      (installed) => installed.config.name === extensionName,
    )
  ) {
    throw new Error(t('commands.extensions.uninstall.not_found', `Extension "${extensionName}" not found.`, { extensionName }));
  }
  const storage = new ExtensionStorage(extensionName);
  return await fs.promises.rm(storage.getExtensionDir(), {
    recursive: true,
    force: true,
  });
}

export function toOutputString(extension: Extension): string {
  let output = `${extension.config.name} (${extension.config.version})`;
  output += `\n Path: ${extension.path}`;
  if (extension.installMetadata) {
    output += `\n Source: ${extension.installMetadata.source}`;
  }
  if (extension.contextFiles.length > 0) {
    output += `\n Context files:`;
    extension.contextFiles.forEach((contextFile) => {
      output += `\n  ${contextFile}`;
    });
  }
  if (extension.config.mcpServers) {
    output += `\n MCP servers:`;
    Object.keys(extension.config.mcpServers).forEach((key) => {
      output += `\n  ${key}`;
    });
  }
  if (extension.config.excludeTools) {
    output += `\n Excluded tools:`;
    extension.config.excludeTools.forEach((tool) => {
      output += `\n  ${tool}`;
    });
  }
  return output;
}

export async function updateExtension(
  extensionName: string,
): Promise<ExtensionUpdateInfo | undefined> {
  const installedExtensions = loadUserExtensions();
  const extension = installedExtensions.find(
    (installed) => installed.config.name === extensionName,
  );
  if (!extension) {
    throw new Error(
      t('commands.extensions.update.not_found', `Extension "${extensionName}" not found. Run auditaria extensions list to see available extensions.`, { extensionName }),
    );
  }
  if (!extension.installMetadata) {
    throw new Error(
      t('commands.extensions.update.missing_metadata', `Extension cannot be updated because it is missing the .gemini-extension-install.json file. To update manually, uninstall and then reinstall the updated version.`),
    );
  }
  const originalVersion = extension.config.version;
  const tempDir = await ExtensionStorage.createTmpDir();
  try {
    await copyExtension(extension.path, tempDir);
    await uninstallExtension(extensionName);
    await installExtension(extension.installMetadata);

    const updatedExtension = loadExtension(extension.path);
    if (!updatedExtension) {
      throw new Error(t('commands.extensions.update.not_found_after_install', 'Updated extension not found after installation.'));
    }
    const updatedVersion = updatedExtension.config.version;
    return {
      originalVersion,
      updatedVersion,
    };
  } catch (e) {
    console.error(t('commands.extensions.update.error_rolling_back', `Error updating extension, rolling back. ${e}`, { error: String(e) }));
    await copyExtension(tempDir, extension.path);
    throw e;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}
