/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getAvailableLanguages } from '@google/gemini-cli-core';
import type { LanguageInfo, SupportedLanguage } from '@google/gemini-cli-core';

import type React from 'react';
import { useState } from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import type {
  LoadableSettingScope,
  LoadedSettings,
} from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { getScopeMessageForSetting } from '../../utils/dialogScopeUtils.js';

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

  // Get available languages synchronously from the hardcoded list
  const availableLanguages: LanguageInfo[] = getAvailableLanguages();

  // Generate language items for the radio button selector
  const languageItems = availableLanguages.map((lang) => ({
    label: `${lang.nativeName} (${lang.name})`,
    value: lang.code,
    languageInfo: lang,
    key: lang.code,
  }));

  // Determine which language should be initially selected
  // Priority: settings > English > first available
  const currentLanguage = settings.merged.ui?.language;
  const initialLanguageIndex = languageItems.findIndex((item) => {
    if (currentLanguage) {
      return item.value === currentLanguage;
    }
    // Default to English if available, otherwise first language
    return item.value === 'en';
  });

  // Language settings only support User and System scopes (no Workspace)
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
      label: 'System Settings',
      value: SettingScope.System as LoadableSettingScope,
      key: SettingScope.System as LoadableSettingScope,
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

  // Use shared utility for scope message (consistent with ThemeDialog)
  const otherScopeModifiedMessage = isFirstTimeSetup
    ? ''
    : getScopeMessageForSetting('ui.language', selectedScope, settings);

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
            Choose your preferred language for the interface. You can change
            this later using the /language command.
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

      <Box marginTop={1}>
        <Text color={Colors.Gray} wrap="truncate">
          (Use Enter to select
          {showScopeSelection ? ', Tab to change focus' : ''}
          {!isFirstTimeSetup ? ', Esc to cancel' : ''})
        </Text>
      </Box>
    </Box>
  );
}
