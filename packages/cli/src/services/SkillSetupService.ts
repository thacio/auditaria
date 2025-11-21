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
  constructor(
    private workingDirectory: string
  ) {}

  /**
   * Generic skill setup - works for any skill
   *
   * @param config Skill configuration
   * @returns Setup result with success status and message
   */
  async setupSkill(config: {
    skillName: string;        // e.g., 'docx-writing-skill'
    downloadUrl: string;      // Platform-specific download URL
    zipFileName: string;      // e.g., 'parser-windows.zip'
  }): Promise<{
    success: boolean;
    message: string;
    installPath?: string;     // .auditaria/skills/{skillName}/
  }> {
    const { skillName, downloadUrl, zipFileName } = config;

    try {
      // Create skills directory if it doesn't exist
      const skillsDir = path.join(this.workingDirectory, '.auditaria', 'skills');

      if (!fs.existsSync(skillsDir)) {
        fs.mkdirSync(skillsDir, { recursive: true });
      }

      // Define paths
      const zipPath = path.join(this.workingDirectory, '.auditaria', zipFileName);
      const skillInstallPath = path.join(skillsDir, skillName);

      // Download the skill ZIP first (before deleting old installation)
      await this.downloadFile(downloadUrl, zipPath);

      // Extract the ZIP
      await this.extractZip(zipPath, skillsDir);

      // Determine extracted folder path
      const platform = this.detectPlatform();
      const extractedFolderName = `parser-${platform}`;
      const extractedPath = path.join(skillsDir, extractedFolderName);

      // Now that download and extract succeeded, remove old installation if it exists
      if (fs.existsSync(skillInstallPath)) {
        fs.rmSync(skillInstallPath, { recursive: true, force: true });
      }

      // Rename extracted folder to skillName if needed
      // The ZIP might extract to a folder like "parser-windows", we need to rename it
      if (fs.existsSync(extractedPath)) {
        if (extractedPath !== skillInstallPath) {
          fs.renameSync(extractedPath, skillInstallPath);
        }
      }

      // Set executable permissions on Unix
      if (platform !== 'windows') {
        this.setExecutablePermissions(skillInstallPath);
      }

      // Clean up ZIP file
      if (fs.existsSync(zipPath)) {
        fs.unlinkSync(zipPath);
      }

      // Verify installation
      if (!fs.existsSync(skillInstallPath)) {
        return {
          success: false,
          message: `Installation failed: Skill directory not found at ${skillInstallPath}`
        };
      }

      return {
        success: true,
        message: `Skill ${skillName} installed successfully!`,
        installPath: skillInstallPath
      };

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`Failed to setup skill ${config.skillName}:`, error);

      // Clean up ZIP file on failure
      const zipPath = path.join(this.workingDirectory, '.auditaria', zipFileName);
      if (fs.existsSync(zipPath)) {
        fs.unlinkSync(zipPath);
      }

      return {
        success: false,
        message: `Installation failed: ${errorMsg}`
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
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close();
          if (fs.existsSync(destination)) {
            fs.unlinkSync(destination); // Remove incomplete file
          }
          file = fs.createWriteStream(destination);
          https.get(response.headers.location, handleResponse).on('error', reject);
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
      throw new Error(`Failed to extract ZIP: ${error instanceof Error ? error.message : String(error)}`);
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
          console.debug(`Set executable permissions: ${filePath}`);
        }
      }
    } catch (error) {
      console.warn(`Failed to set executable permissions: ${error}`);
      // Don't throw - this is not critical
    }
  }
}
