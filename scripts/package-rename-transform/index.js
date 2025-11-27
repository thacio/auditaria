/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ESBuild plugin for package name transformation
 * Transforms @google/gemini-cli* to @thacio/auditaria-cli* at build time
 *
 * AUDITARIA_FEATURE: This allows source code to stay clean (identical to upstream)
 * while the final bundle uses the fork's package names.
 */

import fs from 'node:fs';

const PLUGIN_NAME = 'package-rename-transform';

/**
 * Load configuration from environment variables
 * PACKAGE_RENAME=false to disable (enabled by default)
 */
function loadConfig() {
  return {
    enabled: process.env.PACKAGE_RENAME !== 'false',
  };
}

/**
 * ESBuild plugin that transforms package names in the final bundle output
 * Uses onEnd hook to process after all other transformations are complete
 */
export function packageRenamePlugin(options = {}) {
  return {
    name: PLUGIN_NAME,
    setup(build) {
      const config = loadConfig();
      const enabled = options.enabled ?? config.enabled;

      if (!enabled) {
        console.log(`[${PLUGIN_NAME}] disabled`);
        return;
      }

      console.log(`[${PLUGIN_NAME}] enabled`);

      // Use onEnd to transform the final bundle output
      // This runs AFTER all other transformations (including i18n)
      build.onEnd(async (_result) => {
        // Get output files from build config
        const outfile = build.initialOptions.outfile;

        if (!outfile) {
          console.log(`[${PLUGIN_NAME}] No outfile specified, skipping`);
          return;
        }

        try {
          // Check if file exists
          if (!fs.existsSync(outfile)) {
            console.log(`[${PLUGIN_NAME}] Output file not found: ${outfile}`);
            return;
          }

          // Read the bundled output
          let content = await fs.promises.readFile(outfile, 'utf8');

          // Count occurrences before transformation
          const matches = content.match(/@google\/gemini-cli/g);
          const matchCount = matches ? matches.length : 0;

          if (matchCount === 0) {
            // console.log(`[${PLUGIN_NAME}] No @google/gemini-cli references found`);
            return;
          }

          // Transform: @google/gemini-cli* → @thacio/auditaria-cli*
          content = content.replace(
            /@google\/gemini-cli/g,
            '@thacio/auditaria-cli',
          );

          // Write back the transformed content
          await fs.promises.writeFile(outfile, content, 'utf8');

          console.log(
            `[${PLUGIN_NAME}] Transformed ${matchCount} occurrences in ${outfile}`,
          );
        } catch (error) {
          console.error(`[${PLUGIN_NAME}] Error: ${error.message}`);
        }
      });
    },
  };
}

export default packageRenamePlugin;
