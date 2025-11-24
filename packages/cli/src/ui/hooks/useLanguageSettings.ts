/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { initI18n, setLanguage } from '@google/gemini-cli-core';
import type { SupportedLanguage } from '@google/gemini-cli-core';

import { useState, useCallback, useEffect } from 'react';
import type { LoadedSettings , LoadableSettingScope } from '../../config/settings.js';
import type { HistoryItem } from '../types.js';
import { MessageType } from '../types.js';

interface UseLanguageSettingsReturn {
  isLanguageDialogOpen: boolean;
  openLanguageDialog: () => void;
  handleLanguageSelect: (
    languageCode: SupportedLanguage | undefined,
    scope: LoadableSettingScope,
  ) => void;
  isFirstTimeSetup: boolean;
}

export const useLanguageSettings = (
  loadedSettings: LoadedSettings,
  setLanguageError: (error: string | null) => void,
  addItem: (item: Omit<HistoryItem, 'id'>, timestamp: number) => void,
  refreshStatic?: () => void,
): UseLanguageSettingsReturn => {
  // Determine if this is first-time setup (no language setting exists)
  const hasLanguageSetting = loadedSettings.merged.ui?.language !== undefined;
  const isFirstTimeSetup = !hasLanguageSetting;

  // Initial state: Open dialog if no language is set
  const [isLanguageDialogOpen, setIsLanguageDialogOpen] =
    useState(isFirstTimeSetup);

  // Apply initial language on component mount
  useEffect(() => {
    const currentLanguage = loadedSettings.merged.ui?.language;

    if (currentLanguage) {
      // Language is already set, initialize with that language
      initI18n(currentLanguage).catch((error) => {
        console.error('Failed to initialize i18n with saved language:', error);
        setLanguageError(
          `Failed to load language "${currentLanguage}". Using default.`,
        );
      });
    } else if (!isFirstTimeSetup) {
      // This shouldn't happen, but fallback to English if no language is set
      // and it's not first-time setup
      initI18n('en').catch((error) => {
        console.error(
          'Failed to initialize i18n with fallback language:',
          error,
        );
      });
    }
  }, [loadedSettings.merged.ui?.language, isFirstTimeSetup, setLanguageError]);

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
    async (
      languageCode: SupportedLanguage | undefined,
      scope: LoadableSettingScope,
    ) => {
      if (!languageCode) {
        // If no language selected and it's first-time setup, don't allow proceeding
        if (isFirstTimeSetup) {
          setLanguageError('You must select a language to continue.');
          return;
        }
        // Otherwise, just close the dialog
        setIsLanguageDialogOpen(false);
        return;
      }

      try {
        // Save the language setting
        loadedSettings.setValue(scope, 'ui.language', languageCode);

        // Apply the language
        const success = await applyLanguage(languageCode);

        if (success) {
          setIsLanguageDialogOpen(false);

          // Force refresh the static content to show new language
          if (refreshStatic) {
            refreshStatic();
          }

          // For first-time setup, show welcome message
          if (isFirstTimeSetup) {
            addItem(
              {
                type: MessageType.INFO,
                text: `Welcome! Language has been set to ${languageCode}. You can change it anytime using the /language command.`,
              },
              Date.now(),
            );
          }
        }
        // If not successful, keep dialog open and error message is already set
      } catch (error) {
        console.error('Failed to save language setting:', error);
        setLanguageError(
          'Failed to save language setting. Please try again.',
        );
      }
    },
    [
      loadedSettings,
      applyLanguage,
      isFirstTimeSetup,
      addItem,
      setLanguageError,
      refreshStatic,
    ],
  );

  return {
    isLanguageDialogOpen,
    openLanguageDialog,
    handleLanguageSelect,
    isFirstTimeSetup,
  };
};
