/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@thacio/auditaria-cli-core';

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { Colors } from '../colors.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { LoadedSettings, SettingScope } from '../../config/settings.js';
import { discoverAvailableLanguages } from '@thacio/auditaria-cli-core';
import type { LanguageInfo, SupportedLanguage } from '@thacio/auditaria-cli-core';

interface LanguageSelectionDialogProps {
  /** Callback function when a language is selected */
  onSelect: (languageCode: SupportedLanguage | undefined, scope: SettingScope) => void;
  /** The settings object */
  settings: LoadedSettings;
  /** Whether this is the first-time setup (prevents escape exit) */
  isFirstTimeSetup?: boolean;
}

export function LanguageSelectionDialog({
  onSelect,
  settings,
  isFirstTimeSetup = false,
}: LanguageSelectionDialogProps): React.JSX.Element {
  const [selectedScope, setSelectedScope] = useState<SettingScope>(
    SettingScope.User,
  );
  const [availableLanguages, setAvailableLanguages] = useState<LanguageInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Load available languages on component mount
  useEffect(() => {
    const loadLanguages = async () => {
      try {
        const languages = await discoverAvailableLanguages();
        setAvailableLanguages(languages);
      } catch (error) {
        console.error('Failed to load available languages:', error);
        setErrorMessage(t('language_dialog.errors.failed_to_load', 'Failed to load available languages. Using defaults.'));
        // Fallback to default languages
        setAvailableLanguages([
          { code: 'en', name: 'English', nativeName: 'English' },
          { code: 'pt', name: 'Portuguese', nativeName: 'Português' }
        ]);
      } finally {
        setIsLoading(false);
      }
    };

    loadLanguages();
  }, []);

  // Generate language items for the radio button selector
  const languageItems = availableLanguages.map((lang) => ({
    label: `${lang.nativeName} (${lang.name})`,
    value: lang.code,
    languageInfo: lang,
  }));

  // Determine which language should be initially selected
  // Priority: settings > current language > English > first available
  const currentLanguage = settings.merged.language;
  const initialLanguageIndex = languageItems.findIndex((item) => {
    if (currentLanguage) {
      return item.value === currentLanguage;
    }
    // Default to English if available, otherwise first language
    return item.value === 'en';
  });

  const scopeItems = [
    { label: t('language_dialog.scope_options.user_settings', 'User Settings'), value: SettingScope.User },
    { label: t('language_dialog.scope_options.workspace_settings', 'Workspace Settings'), value: SettingScope.Workspace },
  ];

  const handleLanguageSelect = (languageCode: SupportedLanguage) => {
    onSelect(languageCode, selectedScope);
  };

  const handleScopeHighlight = (scope: SettingScope) => {
    setSelectedScope(scope);
  };

  const handleScopeSelect = (scope: SettingScope) => {
    handleScopeHighlight(scope);
    setFocusedSection('language'); // Reset focus to language section
  };

  const [focusedSection, setFocusedSection] = useState<'language' | 'scope'>(
    'language',
  );

  useInput((input, key) => {
    if (key.tab && !isFirstTimeSetup) {
      setFocusedSection((prev) => (prev === 'language' ? 'scope' : 'language'));
    }
    if (key.escape && !isFirstTimeSetup) {
      // Only allow escape if not first-time setup
      onSelect(undefined, selectedScope);
    }
  });

  // Calculate scope messages
  let otherScopeModifiedMessage = '';
  if (!isFirstTimeSetup) {
    const otherScope =
      selectedScope === SettingScope.User
        ? SettingScope.Workspace
        : SettingScope.User;
    if (settings.forScope(otherScope).settings.language !== undefined) {
      otherScopeModifiedMessage =
        settings.forScope(selectedScope).settings.language !== undefined
          ? t('language_dialog.messages.also_modified_in', '(Also modified in {scope})', { scope: otherScope })
          : t('language_dialog.messages.modified_in', '(Modified in {scope})', { scope: otherScope });
    }
  }

  // Show loading state
  if (isLoading) {
    return (
      <Box
        borderStyle="round"
        borderColor={Colors.Gray}
        flexDirection="column"
        padding={1}
        width="100%"
      >
        <Text bold>{t('language_dialog.loading_title', 'Loading Available Languages...')}</Text>
        <Box marginTop={1}>
          <Text color={Colors.Gray}>{t('language_dialog.loading_message', 'Discovering available language options...')}</Text>
        </Box>
      </Box>
    );
  }

  // Show error if no languages available
  if (languageItems.length === 0) {
    return (
      <Box
        borderStyle="round"
        borderColor={Colors.AccentRed}
        flexDirection="column"
        padding={1}
        width="100%"
      >
        <Text bold color={Colors.AccentRed}>
          {t('language_dialog.error_title', 'Language Selection Error')}
        </Text>
        <Box marginTop={1}>
          <Text>
            {t('language_dialog.no_languages_available', 'No language files found. Please ensure translation files are available.')}
          </Text>
        </Box>
        {!isFirstTimeSetup && (
          <Box marginTop={1}>
            <Text color={Colors.Gray}>
              {t('language_dialog.messages.press_escape', 'Press Esc to continue with default language.')}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  const showScopeSelection = !isFirstTimeSetup;

  return (
    <Box
      borderStyle="round"
      borderColor={Colors.Gray}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>
        {isFirstTimeSetup 
          ? t('language_dialog.first_time_title', 'Welcome! Select Your Language')
          : t('language_dialog.title', 'Language Selection')
        }
      </Text>
      
      {isFirstTimeSetup && (
        <Box marginTop={1}>
          <Text>
            {t('language_dialog.first_time_description', 'Choose your preferred language for the interface. You can change this later using the /language command.')}
          </Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text bold={focusedSection === 'language'} wrap="truncate">
          {focusedSection === 'language' ? '> ' : '  '}
          {t('language_dialog.select_language', 'Select Language')}{' '}
          <Text color={Colors.Gray}>{otherScopeModifiedMessage}</Text>
        </Text>
        
        <RadioButtonSelect
          items={languageItems}
          initialIndex={Math.max(0, initialLanguageIndex)}
          onSelect={handleLanguageSelect}
          isFocused={focusedSection === 'language'}
        />

        {/* Scope Selection - only show if not first-time setup */}
        {showScopeSelection && (
          <Box marginTop={1} flexDirection="column">
            <Text bold={focusedSection === 'scope'} wrap="truncate">
              {focusedSection === 'scope' ? '> ' : '  '}
              {t('language_dialog.apply_to', 'Apply To')}
            </Text>
            <RadioButtonSelect
              items={scopeItems}
              initialIndex={0} // Default to User Settings
              onSelect={handleScopeSelect}
              onHighlight={handleScopeHighlight}
              isFocused={focusedSection === 'scope'}
            />
          </Box>
        )}
      </Box>

      {/* Error message */}
      {errorMessage && (
        <Box marginTop={1}>
          <Text color={Colors.AccentRed}>{errorMessage}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={Colors.Gray} wrap="truncate">
          {t('language_dialog.messages.use_enter_select', '(Use Enter to select')}
          {showScopeSelection ? t('language_dialog.messages.tab_to_change_focus', ', Tab to change focus') : ''}
          {!isFirstTimeSetup ? t('language_dialog.messages.escape_to_cancel', ', Esc to cancel') : ''}
          )
        </Text>
      </Box>

      {isFirstTimeSetup && availableLanguages.length > 0 && (
        <Box marginTop={1}>
          <Text color={Colors.AccentBlue}>
            {t('language_dialog.languages_count', 'Available languages: {count}', { count: availableLanguages.length.toString() })}
          </Text>
        </Box>
      )}
    </Box>
  );
}