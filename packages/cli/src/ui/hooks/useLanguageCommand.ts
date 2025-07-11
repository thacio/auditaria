/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t, setLanguage } from '@thacio/auditaria-cli-core';
import type { SupportedLanguage } from '@thacio/auditaria-cli-core';

import { useState, useCallback } from 'react';
import { LoadedSettings, SettingScope } from '../../config/settings.js';
import { type HistoryItem, MessageType } from '../types.js';

interface UseLanguageCommandReturn {
  isLanguageDialogOpen: boolean;
  openLanguageDialog: () => void;
  handleLanguageSelect: (
    languageCode: SupportedLanguage | undefined,
    scope: SettingScope,
  ) => void;
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
        setLanguageError(t('language.no_language_selected', 'No language selected.'));
        return false;
      }

      try {
        await setLanguage(languageCode);
        setLanguageError(null);
        
        // Add success message to history
        addItem(
          {
            type: MessageType.INFO,
            text: t('language.changed_successfully', 'Language changed to {language}.', 
              { language: languageCode }
            ),
          },
          Date.now(),
        );
        
        return true;
      } catch (error) {
        console.error('Failed to apply language:', error);
        setLanguageError(
          t('language.application_failed', 'Failed to apply language "{language}". Please try again.', 
            { language: languageCode }
          )
        );
        return false;
      }
    },
    [setLanguageError, addItem],
  );

  const handleLanguageSelect = useCallback(
    async (languageCode: SupportedLanguage | undefined, scope: SettingScope) => {
      if (!languageCode) {
        // Just close the dialog if no language selected
        setIsLanguageDialogOpen(false);
        return;
      }

      try {
        // Save the language setting
        loadedSettings.setValue(scope, 'language', languageCode);
        
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
        setLanguageError(
          t('language.save_failed', 'Failed to save language setting. Please try again.')
        );
      }
    },
    [loadedSettings, applyLanguage, setLanguageError],
  );

  return {
    isLanguageDialogOpen,
    openLanguageDialog,
    handleLanguageSelect,
  };
};