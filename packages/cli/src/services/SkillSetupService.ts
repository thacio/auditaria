/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IncomingMessage } from 'node:http';
import extract from 'extract-zip';

/**
 * Generic Skill Setup Service
 *
 * This service handles downloading and extracting ANY skill.
 * It does NOT contain skill-specific logic - that belongs in skill-specific services.
 *
 * Responsibilities:
 * - Detect platform (Windows/Linux/macOS)
 * - Download skill ZIP from URL
 * - Extract to .auditaria/skills/{skillName}/
 * - Set executable permissions on Unix
 * - Clean up temporary files
 */
export class SkillSetupService {
  constructor(private workingDirectory: string) {}

  /**
   * Generic skill setup - works for any skill
   *
   * @param config Skill configuration
   * @returns Setup result with success status and message
   */
  async setupSkill(config: {
    skillName: string; // e.g., 'docx-writing-skill'
    downloadUrl: string; // Platform-specific download URL
    zipFileName: string; // e.g., 'parser-windows.zip'
    password?: string; // Optional: for password-protected release ZIPs
  }): Promise<{
    success: boolean;
    message: string;
    installPath?: string; // .auditaria/skills/{skillName}/
  }> {
    const { skillName, downloadUrl, zipFileName, password } = config;

    try {
      // Create skills directory if it doesn't exist
      const skillsDir = path.join(
        this.workingDirectory,
        '.auditaria',
        'skills',
      );

      if (!fs.existsSync(skillsDir)) {
        fs.mkdirSync(skillsDir, { recursive: true });
      }

      // Define paths
      const zipPath = path.join(
        this.workingDirectory,
        '.auditaria',
        zipFileName,
      );
      const skillInstallPath = path.join(skillsDir, skillName);

      // Download the skill ZIP first (before deleting old installation)
      await this.downloadFile(downloadUrl, zipPath);

      // Extract the ZIP (password-protected ZIPs take the adm-zip path;
      // plain ZIPs keep the existing extract-zip behavior)
      if (password) {
        await this.extractZipWithPassword(zipPath, skillsDir, password);
      } else {
        await this.extractZip(zipPath, skillsDir);
      }

      // Determine extracted folder path
      const platform = this.detectPlatform();
      const extractedFolderName = `parser-${platform}`;
      const extractedPath = path.join(skillsDir, extractedFolderName);

      if (!fs.existsSync(extractedPath)) {
        if (fs.existsSync(zipPath)) {
          fs.unlinkSync(zipPath);
        }
        return {
          success: false,
          message: `Installation failed: expected ${extractedFolderName}/ inside the downloaded ZIP`,
        };
      }

      // Multi-OS shared-folder layout: the skill root holds the shared,
      // platform-independent content (SKILL.md, templates/, assets/, docs)
      // and each OS keeps its binaries in its own parser-<os>/ subfolder.
      // Setup only ever replaces ITS OWN platform's subfolder, so users on
      // different OSes sharing the project folder (cloud drive) can each run
      // /setup-skill once and coexist:
      //   docx-writing-skill/parser-windows/parser.exe
      //   docx-writing-skill/parser-macos/parser
      //   docx-writing-skill/parser-linux/parser
      fs.mkdirSync(skillInstallPath, { recursive: true });

      const platformInstallPath = path.join(
        skillInstallPath,
        extractedFolderName,
      );
      if (fs.existsSync(platformInstallPath)) {
        fs.rmSync(platformInstallPath, { recursive: true, force: true });
      }
      fs.renameSync(extractedPath, platformInstallPath);

      // Copy the shared (platform-independent) content up to the skill root,
      // overwriting whatever a previous setup left there. Anything named
      // parser* (the executable and any future parser support files) is
      // platform-specific and stays only in the platform subfolder.
      for (const entry of fs.readdirSync(platformInstallPath)) {
        if (entry.toLowerCase().startsWith('parser')) {
          continue;
        }
        const from = path.join(platformInstallPath, entry);
        const to = path.join(skillInstallPath, entry);
        fs.rmSync(to, { recursive: true, force: true });
        fs.cpSync(from, to, { recursive: true });
      }

      // Remove THIS platform's legacy root binary (pre-multi-OS layout).
      // Other platforms' legacy binaries are left untouched — their owners
      // migrate the same way by re-running /setup-skill on their machine.
      const legacyBinary = path.join(
        skillInstallPath,
        platform === 'windows' ? 'parser.exe' : 'parser',
      );
      if (fs.existsSync(legacyBinary)) {
        fs.rmSync(legacyBinary, { force: true });
      }

      // Set executable permissions on Unix
      if (platform !== 'windows') {
        this.setExecutablePermissions(platformInstallPath);
      }

      // Clean up ZIP file
      if (fs.existsSync(zipPath)) {
        fs.unlinkSync(zipPath);
      }

      // Verify installation
      const executable = platform === 'windows' ? 'parser.exe' : 'parser';
      if (!fs.existsSync(path.join(platformInstallPath, executable))) {
        return {
          success: false,
          message: `Installation failed: ${executable} not found at ${platformInstallPath}`,
        };
      }

      return {
        success: true,
        message: `Skill ${skillName} installed successfully for ${platform}! (installs for other OSes in the shared folder are preserved)`,
        installPath: skillInstallPath,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.error(`Failed to setup skill ${config.skillName}:`, error);

      // Clean up ZIP file on failure
      const zipPath = path.join(
        this.workingDirectory,
        '.auditaria',
        zipFileName,
      );
      if (fs.existsSync(zipPath)) {
        fs.unlinkSync(zipPath);
      }

      return {
        success: false,
        message: `Installation failed: ${errorMsg}`,
      };
    }
  }

  /**
   * Detect current platform
   */
  detectPlatform(): 'windows' | 'linux' | 'macos' {
    if (process.platform === 'win32') return 'windows';
    if (process.platform === 'darwin') return 'macos';
    return 'linux';
  }

  /**
   * Download file from URL with redirect handling
   */
  private async downloadFile(url: string, destination: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let file = fs.createWriteStream(destination);

      const handleResponse = (response: IncomingMessage) => {
        // Handle redirects (301, 302, 307, 308)
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          file.close();
          if (fs.existsSync(destination)) {
            fs.unlinkSync(destination); // Remove incomplete file
          }
          file = fs.createWriteStream(destination);
          https
            .get(response.headers.location, handleResponse)
            .on('error', reject);
          return;
        }

        if (response.statusCode !== 200) {
          file.close();
          if (fs.existsSync(destination)) {
            fs.unlinkSync(destination);
          }
          reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
          return;
        }

        response.pipe(file);

        // A mid-download connection reset (common behind corporate
        // proxies/firewalls) emits 'error' on the response stream. pipe()
        // does NOT forward that to `file`, so without this listener it
        // becomes an uncaughtException that silently kills the whole CLI.
        // Handle it and reject so it surfaces as a normal error message.
        response.on('error', (err) => {
          file.close();
          if (fs.existsSync(destination)) {
            fs.unlinkSync(destination);
          }
          reject(err);
        });

        file.on('finish', () => {
          file.close();
          resolve();
        });

        file.on('error', (err) => {
          file.close();
          if (fs.existsSync(destination)) {
            fs.unlinkSync(destination);
          }
          reject(err);
        });
      };

      https.get(url, handleResponse).on('error', (err) => {
        if (fs.existsSync(destination)) {
          fs.unlinkSync(destination);
        }
        reject(err);
      });
    });
  }

  /**
   * Extract ZIP file
   */
  private async extractZip(zipPath: string, extractTo: string): Promise<void> {
    try {
      await extract(zipPath, { dir: path.resolve(extractTo) });
    } catch (error) {
      throw new Error(
        `Failed to extract ZIP: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Extract a password-protected ZIP file.
   *
   * Uses adm-zip, which decrypts the classic ZipCrypto encryption
   * (`zip -P <password>` / 7-Zip "ZipCrypto" method). AES-encrypted ZIPs are
   * NOT supported — release archives must be created with ZipCrypto.
   *
   * adm-zip is fully synchronous and buffer-based (it reads the archive once
   * into memory, with no async streams). That matters here: a streaming
   * reader emits 'error' on internal fd/decompression streams that have no
   * listener (a wrong password, a truncated/corrupt download, or a file
   * momentarily locked by OneDrive/antivirus), and an unhandled stream
   * 'error' is an uncaughtException — there is no uncaughtException handler,
   * so it silently kills the whole CLI. With adm-zip every such failure is a
   * synchronous throw caught below and surfaced as a normal error message.
   */
  private async extractZipWithPassword(
    zipPath: string,
    extractTo: string,
    password: string,
  ): Promise<void> {
    try {
      const { default: AdmZip } = await import('adm-zip');
      // Read the whole archive up-front (one atomic read) instead of doing
      // many random-access fd reads, which is what can transiently fail on a
      // OneDrive-synced / antivirus-scanned file.
      const zip = new AdmZip(fs.readFileSync(zipPath));

      const destRoot = path.resolve(extractTo);
      for (const entry of zip.getEntries()) {
        // Normalize and contain paths (zip-slip protection). A plain
        // startsWith check is bypassable at separator boundaries
        // (e.g. "skills-evil" starts with "skills"), so compare via relative.
        const destPath = path.resolve(destRoot, entry.entryName);
        const rel = path.relative(destRoot, destPath);
        if (
          !rel ||
          rel === '..' ||
          rel.startsWith('..' + path.sep) ||
          path.isAbsolute(rel)
        ) {
          continue;
        }

        if (entry.isDirectory) {
          fs.mkdirSync(destPath, { recursive: true });
          continue;
        }

        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        // Synchronous ZipCrypto decryption via the archive-level reader
        // (the typed API that accepts the password). adm-zip throws "Wrong
        // Password" (verified against the entry's CRC) on a bad password and
        // "Invalid or unsupported zip format" on a truncated/corrupt archive
        // — both caught below.
        const content = zip.readFile(entry, password);
        if (content === null) {
          throw new Error(`could not read entry ${entry.entryName}`);
        }
        fs.writeFileSync(destPath, content);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (
        /wrong password|bad_password|missing_password|invalid password|password/i.test(
          msg,
        )
      ) {
        throw new Error('Failed to extract ZIP: invalid password');
      }
      throw new Error(`Failed to extract ZIP: ${msg}`);
    }
  }

  /**
   * Set executable permissions on all files in directory (Unix only)
   */
  private setExecutablePermissions(directory: string): void {
    try {
      const files = fs.readdirSync(directory);

      for (const file of files) {
        const filePath = path.join(directory, file);
        const stats = fs.statSync(filePath);

        if (stats.isFile()) {
          // Set executable permissions (755 = rwxr-xr-x)
          fs.chmodSync(filePath, 0o755);
          // eslint-disable-next-line no-console
          console.debug(`Set executable permissions: ${filePath}`);
        }
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`Failed to set executable permissions: ${error}`);
      // Don't throw - this is not critical
    }
  }
}
