/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { setLanguage } from '@google/gemini-cli-core';
import type { SupportedLanguage } from '@google/gemini-cli-core';

import { useState, useCallback } from 'react';
import type { LoadedSettings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';
import type { HistoryItem } from '../types.js';
import { MessageType } from '../types.js';

interface UseLanguageCommandReturn {
  isLanguageDialogOpen: boolean;
  openLanguageDialog: () => void;
  handleLanguageSelect: (languageCode: SupportedLanguage | undefined) => void;
}

export const useLanguageCommand = (
  loadedSettings: LoadedSettings,
  setLanguageError: (error: string | null) => void,
  addItem: (item: Omit<HistoryItem, 'id'>, timestamp: number) => void,
  refreshStatic?: () => void,
): UseLanguageCommandReturn => {
  // Initial state: Dialog is closed for slash command usage
  const [isLanguageDialogOpen, setIsLanguageDialogOpen] = useState(false);

  const openLanguageDialog = useCallback(() => {
    setIsLanguageDialogOpen(true);
  }, []);

  const applyLanguage = useCallback(
    async (languageCode: SupportedLanguage | undefined) => {
      if (!languageCode) {
        setLanguageError('No language selected.');
        return false;
      }

      try {
        await setLanguage(languageCode);
        setLanguageError(null);

        // Add success message to history
        addItem(
          {
            type: MessageType.INFO,
            text: `Language changed to ${languageCode}.`,
          },
          Date.now(),
        );

        return true;
      } catch (error) {
        console.error('Failed to apply language:', error);
        setLanguageError(
          `Failed to apply language "${languageCode}". Please try again.`,
        );
        return false;
      }
    },
    [setLanguageError, addItem],
  );

  const handleLanguageSelect = useCallback(
    async (languageCode: SupportedLanguage | undefined) => {
      if (!languageCode) {
        // Just close the dialog if no language selected
        setIsLanguageDialogOpen(false);
        return;
      }

      try {
        // Save the language setting to User scope so it persists across sessions.
        loadedSettings.setValue(
          SettingScope.User,
          'ui.language',
          languageCode,
        );

        // Apply the language
        const success = await applyLanguage(languageCode);

        if (success) {
          setIsLanguageDialogOpen(false);

          // Force refresh the static content to show new language
          if (refreshStatic) {
            refreshStatic();
          }
        }
        // If not successful, keep dialog open and error message is already set
      } catch (error) {
        console.error('Failed to save language setting:', error);
        setLanguageError('Failed to save language setting. Please try again.');
      }
    },
    [loadedSettings, applyLanguage, setLanguageError, refreshStatic],
  );

  return {
    isLanguageDialogOpen,
    openLanguageDialog,
    handleLanguageSelect,
  };
};
