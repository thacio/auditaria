/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { simpleGit } from 'simple-git';
import { getErrorMessage } from '../../utils/errors.js';
import type { ExtensionInstallMetadata } from '@google/gemini-cli-core';
import { ExtensionUpdateState } from '../../ui/state/extensions.js';
import * as os from 'node:os';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

function getGitHubToken(): string | undefined {
  return process.env['GITHUB_TOKEN'];
}

/**
 * Clones a Git repository to a specified local path.
 * @param installMetadata The metadata for the extension to install.
 * @param destination The destination path to clone the repository to.
 */
export async function cloneFromGit(
  installMetadata: ExtensionInstallMetadata,
  destination: string,
): Promise<void> {
  try {
    const git = simpleGit(destination);
    let sourceUrl = installMetadata.source;
    const token = getGitHubToken();
    if (token) {
      try {
        const parsedUrl = new URL(sourceUrl);
        if (
          parsedUrl.protocol === 'https:' &&
          parsedUrl.hostname === 'github.com'
        ) {
          if (!parsedUrl.username) {
            parsedUrl.username = token;
          }
          sourceUrl = parsedUrl.toString();
        }
      } catch {
        // If source is not a valid URL, we don't inject the token.
        // We let git handle the source as is.
      }
    }
    await git.clone(sourceUrl, './', ['--depth', '1']);

    const remotes = await git.getRemotes(true);
    if (remotes.length === 0) {
      throw new Error(
        `Unable to find any remotes for repo ${installMetadata.source}`,
      );
    }

    const refToFetch = installMetadata.ref || 'HEAD';

    await git.fetch(remotes[0].name, refToFetch);

    // After fetching, checkout FETCH_HEAD to get the content of the fetched ref.
    // This results in a detached HEAD state, which is fine for this purpose.
    await git.checkout('FETCH_HEAD');
  } catch (error) {
    throw new Error(
      `Failed to clone Git repository from ${installMetadata.source}`,
      {
        cause: error,
      },
    );
  }
}

function parseGitHubRepo(source: string): { owner: string; repo: string } {
  // The source should be "owner/repo" or a full GitHub URL.
  const parts = source.split('/');
  if (!source.includes('://') && parts.length !== 2) {
    throw new Error(
      `Invalid GitHub repository source: ${source}. Expected "owner/repo".`,
    );
  }
  const owner = parts.at(-2);
  const repo = parts.at(-1)?.replace('.git', '');

  if (!owner || !repo) {
    throw new Error(`Invalid GitHub repository source: ${source}`);
  }
  return { owner, repo };
}

async function fetchFromGithub(
  owner: string,
  repo: string,
  ref?: string,
): Promise<{ assets: Asset[]; tag_name: string }> {
  const endpoint = ref ? `releases/tags/${ref}` : 'releases/latest';
  const url = `https://api.github.com/repos/${owner}/${repo}/${endpoint}`;
  return await fetchJson(url);
}

export async function checkForExtensionUpdate(
  installMetadata: ExtensionInstallMetadata,
): Promise<ExtensionUpdateState> {
  if (
    installMetadata.type !== 'git' &&
    installMetadata.type !== 'github-release'
  ) {
    return ExtensionUpdateState.NOT_UPDATABLE;
  }
  try {
    if (installMetadata.type === 'git') {
      const git = simpleGit(installMetadata.source);
      const remotes = await git.getRemotes(true);
      if (remotes.length === 0) {
        console.error('No git remotes found.');
        return ExtensionUpdateState.ERROR;
      }
      const remoteUrl = remotes[0].refs.fetch;
      if (!remoteUrl) {
        console.error(`No fetch URL found for git remote ${remotes[0].name}.`);
        return ExtensionUpdateState.ERROR;
      }

      // Determine the ref to check on the remote.
      const refToCheck = installMetadata.ref || 'HEAD';

      const lsRemoteOutput = await git.listRemote([
        remotes[0].name,
        refToCheck,
      ]);

      if (typeof lsRemoteOutput !== 'string' || lsRemoteOutput.trim() === '') {
        console.error(`Git ref ${refToCheck} not found.`);
        return ExtensionUpdateState.ERROR;
      }

      const remoteHash = lsRemoteOutput.split('\t')[0];
      const localHash = await git.revparse(['HEAD']);

      if (!remoteHash) {
        console.error(
          `Unable to parse hash from git ls-remote output "${lsRemoteOutput}"`,
        );
        return ExtensionUpdateState.ERROR;
      }
      if (remoteHash === localHash) {
        return ExtensionUpdateState.UP_TO_DATE;
      }
      return ExtensionUpdateState.UPDATE_AVAILABLE;
    } else {
      const { source, ref } = installMetadata;
      if (!source) {
        return ExtensionUpdateState.ERROR;
      }
      const { owner, repo } = parseGitHubRepo(source);

      const releaseData = await fetchFromGithub(
        owner,
        repo,
        installMetadata.ref,
      );
      if (releaseData.tag_name !== ref) {
        return ExtensionUpdateState.UPDATE_AVAILABLE;
      }
      return ExtensionUpdateState.UP_TO_DATE;
    }
  } catch (error) {
    console.error(
      `Failed to check for updates for extension "${installMetadata.source}": ${getErrorMessage(error)}`,
    );
    return ExtensionUpdateState.ERROR;
  }
}

export async function downloadFromGitHubRelease(
  installMetadata: ExtensionInstallMetadata,
  destination: string,
): Promise<string> {
  const { source, ref } = installMetadata;
  const { owner, repo } = parseGitHubRepo(source);

  try {
    const releaseData = await fetchFromGithub(owner, repo, ref);
    if (
      !releaseData ||
      !releaseData.assets ||
      releaseData.assets.length === 0
    ) {
      throw new Error(
        `No release assets found for ${owner}/${repo} at tag ${ref}`,
      );
    }

    const asset = findReleaseAsset(releaseData.assets);
    if (!asset) {
      throw new Error(
        `No suitable release asset found for platform ${os.platform()}-${os.arch()}`,
      );
    }

    const downloadedAssetPath = path.join(
      destination,
      path.basename(asset.browser_download_url),
    );
    await downloadFile(asset.browser_download_url, downloadedAssetPath);

    extractFile(downloadedAssetPath, destination);

    const files = await fs.promises.readdir(destination);
    const extractedDirName = files.find((file) => {
      const filePath = path.join(destination, file);
      return fs.statSync(filePath).isDirectory();
    });

    if (extractedDirName) {
      const extractedDirPath = path.join(destination, extractedDirName);
      const extractedDirFiles = await fs.promises.readdir(extractedDirPath);
      for (const file of extractedDirFiles) {
        await fs.promises.rename(
          path.join(extractedDirPath, file),
          path.join(destination, file),
        );
      }
      await fs.promises.rmdir(extractedDirPath);
    }

    await fs.promises.unlink(downloadedAssetPath);
    return releaseData.tag_name;
  } catch (error) {
    throw new Error(
      `Failed to download release from ${installMetadata.source}: ${getErrorMessage(error)}`,
    );
  }
}

interface Asset {
  name: string;
  browser_download_url: string;
}

export function findReleaseAsset(assets: Asset[]): Asset | undefined {
  const platform = os.platform();
  const arch = os.arch();

  const platformArchPrefix = `${platform}.${arch}.`;
  const platformPrefix = `${platform}.`;

  // Check for platform + architecture specific asset
  const platformArchAsset = assets.find((asset) =>
    asset.name.toLowerCase().startsWith(platformArchPrefix),
  );
  if (platformArchAsset) {
    return platformArchAsset;
  }

  // Check for platform specific asset
  const platformAsset = assets.find((asset) =>
    asset.name.toLowerCase().startsWith(platformPrefix),
  );
  if (platformAsset) {
    return platformAsset;
  }

  // Check for generic asset if only one is available
  const genericAsset = assets.find(
    (asset) =>
      !asset.name.toLowerCase().includes('darwin') &&
      !asset.name.toLowerCase().includes('linux') &&
      !asset.name.toLowerCase().includes('win32'),
  );
  if (assets.length === 1) {
    return genericAsset;
  }

  return undefined;
}

async function fetchJson(
  url: string,
): Promise<{ assets: Asset[]; tag_name: string }> {
  const headers: { 'User-Agent': string; Authorization?: string } = {
    'User-Agent': 'gemini-cli',
  };
  const token = getGitHubToken();
  if (token) {
    headers.Authorization = `token ${token}`;
  }
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers }, (res) => {
        if (res.statusCode !== 200) {
          return reject(
            new Error(`Request failed with status code ${res.statusCode}`),
          );
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString();
          resolve(JSON.parse(data) as { assets: Asset[]; tag_name: string });
        });
      })
      .on('error', reject);
  });
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const headers: { 'User-agent': string; Authorization?: string } = {
    'User-agent': 'gemini-cli',
  };
  const token = getGitHubToken();
  if (token) {
    headers.Authorization = `token ${token}`;
  }
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          downloadFile(res.headers.location!, dest).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          return reject(
            new Error(`Request failed with status code ${res.statusCode}`),
          );
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve as () => void));
      })
      .on('error', reject);
  });
}

function extractFile(file: string, dest: string) {
  if (file.endsWith('.tar.gz')) {
    execSync(`tar -xzf ${file} -C ${dest}`);
  } else if (file.endsWith('.zip')) {
    execSync(`unzip ${file} -d ${dest}`);
  } else {
    throw new Error(`Unsupported file extension for extraction: ${file}`);
  }
}
