/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t, initI18n, setLanguage, getCurrentLanguage } from '@google/gemini-cli-core';
import type { SupportedLanguage } from '@google/gemini-cli-core';

import { useState, useCallback, useEffect } from 'react';
import { LoadedSettings, SettingScope } from '../../config/settings.js';
import { type HistoryItem, MessageType } from '../types.js';

interface UseLanguageSettingsReturn {
  isLanguageDialogOpen: boolean;
  openLanguageDialog: () => void;
  handleLanguageSelect: (
    languageCode: SupportedLanguage | undefined,
    scope: SettingScope,
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
  const hasLanguageSetting = loadedSettings.merged.language !== undefined;
  const isFirstTimeSetup = !hasLanguageSetting;

  // Initial state: Open dialog if no language is set
  const [isLanguageDialogOpen, setIsLanguageDialogOpen] = useState(isFirstTimeSetup);

  // Apply initial language on component mount
  useEffect(() => {
    const currentLanguage = loadedSettings.merged.language;
    
    if (currentLanguage) {
      // Language is already set, initialize with that language
      initI18n(currentLanguage).catch((error) => {
        console.error('Failed to initialize i18n with saved language:', error);
        setLanguageError(
          t('language.initialization_failed', 'Failed to load language "{language}". Using default.', 
            { language: currentLanguage }
          )
        );
      });
    } else if (!isFirstTimeSetup) {
      // This shouldn't happen, but fallback to English if no language is set
      // and it's not first-time setup
      initI18n('en').catch((error) => {
        console.error('Failed to initialize i18n with fallback language:', error);
      });
    }
  }, [loadedSettings.merged.language, isFirstTimeSetup, setLanguageError]);

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
        // If no language selected and it's first-time setup, don't allow proceeding
        if (isFirstTimeSetup) {
          setLanguageError(
            t('language.must_select_language', 'You must select a language to continue.')
          );
          return;
        }
        // Otherwise, just close the dialog
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
          
          // For first-time setup, show welcome message
          if (isFirstTimeSetup) {
            addItem(
              {
                type: MessageType.INFO,
                text: t('language.welcome_message', 'Welcome! Language has been set to {language}. You can change it anytime using the /language command.', 
                  { language: languageCode }
                ),
              },
              Date.now(),
            );
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
    [loadedSettings, applyLanguage, isFirstTimeSetup, addItem, setLanguageError],
  );

  return {
    isLanguageDialogOpen,
    openLanguageDialog,
    handleLanguageSelect,
    isFirstTimeSetup,
  };
};