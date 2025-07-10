/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@thacio/auditaria-cli-core';

import { Message, MessageType } from '../types.js';
import { Config } from '@thacio/auditaria-cli-core';
import { LoadedSettings } from '../../config/settings.js';

export function createShowMemoryAction(
  config: Config | null,
  settings: LoadedSettings,
  addMessage: (message: Message) => void,
) {
  return async () => {
    if (!config) {
      addMessage({
        type: MessageType.ERROR,
        content: t('memory.config_not_available', 'Configuration not available. Cannot show memory.'),
        timestamp: new Date(),
      });
      return;
    }

    const debugMode = config.getDebugMode();

    if (debugMode) {
      console.log('[DEBUG] Show Memory command invoked.');
    }

    const currentMemory = config.getUserMemory();
    const fileCount = config.getGeminiMdFileCount();
    const contextFileName = settings.merged.contextFileName;
    const contextFileNames = Array.isArray(contextFileName)
      ? contextFileName
      : [contextFileName];

    if (debugMode) {
      console.log(
        `[DEBUG] Showing memory. Content from config.getUserMemory() (first 200 chars): ${currentMemory.substring(0, 200)}...`,
      );
      console.log(`[DEBUG] Number of context files loaded: ${fileCount}`);
    }

    if (fileCount > 0) {
      const allNamesTheSame = new Set(contextFileNames).size < 2;
      const name = allNamesTheSame ? contextFileNames[0] : 'context';
      addMessage({
        type: MessageType.INFO,
        content: t('memory.loaded_files', 'Loaded memory from {count} {name} file{plural}.', { count: fileCount, name: name ?? 'context', plural: fileCount > 1 ? 's' : '' }),
        timestamp: new Date(),
      });
    }

    if (currentMemory && currentMemory.trim().length > 0) {
      addMessage({
        type: MessageType.INFO,
        content: t('memory.current_content', 'Current combined memory content:\n```markdown\n{content}\n```', { content: currentMemory }),
        timestamp: new Date(),
      });
    } else {
      addMessage({
        type: MessageType.INFO,
        content: fileCount > 0
          ? t('memory.loaded_but_empty', 'Hierarchical memory (GEMINI.md or other context files) is loaded but content is empty.')
          : t('memory.not_loaded', 'No hierarchical memory (GEMINI.md or other context files) is currently loaded.'),
        timestamp: new Date(),
      });
    }
  };
}
