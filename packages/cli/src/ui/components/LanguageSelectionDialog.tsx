/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { discoverAvailableLanguages } from '@google/gemini-cli-core';

import type React from 'react';
import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import type {
  LoadableSettingScope,
  LoadedSettings,
} from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';
import type {
  LanguageInfo,
  SupportedLanguage,
} from '@google/gemini-cli-core';
import { useKeypress } from '../hooks/useKeypress.js';

interface LanguageSelectionDialogProps {
  /** Callback function when a language is selected */
  onSelect: (
    languageCode: SupportedLanguage | undefined,
    scope: LoadableSettingScope,
  ) => void;
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
  const [selectedScope, setSelectedScope] = useState<LoadableSettingScope>(
    SettingScope.User,
  );
  const [availableLanguages, setAvailableLanguages] = useState<LanguageInfo[]>(
    [],
  );
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
        setErrorMessage(
          'Failed to load available languages. Using defaults.',
        );
        // Fallback to default languages
        setAvailableLanguages([
          { code: 'en', name: 'English', nativeName: 'English' },
          { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
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
    key: lang.code,
  }));

  // Determine which language should be initially selected
  // Priority: settings > current language > English > first available
  const currentLanguage = settings.merged.ui?.language;
  const initialLanguageIndex = languageItems.findIndex((item) => {
    if (currentLanguage) {
      return item.value === currentLanguage;
    }
    // Default to English if available, otherwise first language
    return item.value === 'en';
  });

  const scopeItems: Array<{
    label: string;
    value: LoadableSettingScope;
    key: LoadableSettingScope;
  }> = [
    {
      label: 'User Settings',
      value: SettingScope.User as LoadableSettingScope,
      key: SettingScope.User as LoadableSettingScope,
    },
    {
      label: 'Workspace Settings',
      value: SettingScope.Workspace as LoadableSettingScope,
      key: SettingScope.Workspace as LoadableSettingScope,
    },
  ];

  const handleLanguageSelect = (languageCode: SupportedLanguage) => {
    onSelect(languageCode, selectedScope);
  };

  const handleScopeHighlight = (scope: LoadableSettingScope) => {
    setSelectedScope(scope);
  };

  const handleScopeSelect = (scope: LoadableSettingScope) => {
    handleScopeHighlight(scope);
    setFocusedSection('language'); // Reset focus to language section
  };

  const [focusedSection, setFocusedSection] = useState<'language' | 'scope'>(
    'language',
  );

  useKeypress(
    (key) => {
      if (key.name === 'tab' && !isFirstTimeSetup) {
        setFocusedSection((prev) =>
          prev === 'language' ? 'scope' : 'language',
        );
      }
      if (key.name === 'escape' && !isFirstTimeSetup) {
        // Only allow escape if not first-time setup
        onSelect(undefined, selectedScope);
      }
    },
    { isActive: true },
  );

  // Calculate scope messages
  let otherScopeModifiedMessage = '';
  if (!isFirstTimeSetup) {
    const otherScope =
      selectedScope === SettingScope.User
        ? SettingScope.Workspace
        : SettingScope.User;
    if (settings.forScope(otherScope).settings.ui?.language !== undefined) {
      otherScopeModifiedMessage =
        settings.forScope(selectedScope).settings.ui?.language !== undefined
          ? `(Also modified in ${otherScope})`
          : `(Modified in ${otherScope})`;
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
        <Text bold>
          Loading Available Languages...
        </Text>
        <Box marginTop={1}>
          <Text color={Colors.Gray}>
            Discovering available language options...
          </Text>
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
          Language Selection Error
        </Text>
        <Box marginTop={1}>
          <Text>
            No language files found. Please ensure translation files are available.
          </Text>
        </Box>
        {!isFirstTimeSetup && (
          <Box marginTop={1}>
            <Text color={Colors.Gray}>
              Press Esc to continue with default language.
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
          ? 'Welcome! Select Your Language'
          : 'Language Selection'}
      </Text>

      {isFirstTimeSetup && (
        <Box marginTop={1}>
          <Text>
            Choose your preferred language for the interface. You can change this later using the /language command.
          </Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text bold={focusedSection === 'language'} wrap="truncate">
          {focusedSection === 'language' ? '> ' : '  '}
          Select Language{' '}
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
              Apply To
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
          (Use Enter to select
          {showScopeSelection ? ', Tab to change focus' : ''}
          {!isFirstTimeSetup ? ', Esc to cancel' : ''}
          )
        </Text>
      </Box>

      {isFirstTimeSetup && availableLanguages.length > 0 && (
        <Box marginTop={1}>
          <Text color={Colors.AccentBlue}>
            Available languages: {availableLanguages.length}
          </Text>
        </Box>
      )}
    </Box>
  );
}
